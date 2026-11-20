/**
 * @description Outband API: /auth/tokens*, /admin/tokens*, /admin/settings.
 * @license Apache-2.0
 */

'use strict';

const { ApiError, lastSegment, isValidCidr, encodeCursor, decodeCursor, parseLimit } = require('../util');
const { checkFields } = require('../http');
const { Tokens, SCOPES, PROFILES, MAX_LIVE_TOKENS, maxLifetimeDays, needsStepUp } = require('../tokens');

const ID_RE = /^[A-Za-z0-9@$_-]{8,128}$/;
const TOKEN_ID_RE = /^tok_[A-Za-z0-9_-]{6,60}$/;
const NAME_RE = /^[\x20-\x7E]{1,64}$/;
const USER_ID_RE = /^[^\/\s]{1,256}$/;

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = function (core) {
    const ws = core.webserver;

    function ownerName(userid) { const u = ws.users[userid]; return (u && u.name) || lastSegment(userid); }

    function page(result, limit) {
        return { items: result.items.map(function (d) { return Tokens.toApi(d, ownerName(d.owner)); }), next_cursor: result.next ? encodeCursor(result.next) : null };
    }

    /** Validate and normalise a CreateTokenRequest. */
    function parseCreate(ctx, body) {
        checkFields(body, ['name', 'scopes', 'profile', 'expires_in_days', 'groups', 'allowed_ips'], ['name']);
        if ((typeof body.name != 'string') || !NAME_RE.test(body.name)) throw new ApiError(400, 'invalid_request', 'Invalid name', { field: 'name' });
        if ((body.scopes === undefined) == (body.profile === undefined)) throw new ApiError(400, 'invalid_request', 'Give exactly one of scopes or profile', { field: (body.scopes === undefined) ? 'scopes' : 'profile' });
        let scopes;
        if (body.profile !== undefined) {
            if ((typeof body.profile != 'string') || !Object.prototype.hasOwnProperty.call(PROFILES, body.profile)) throw new ApiError(400, 'invalid_request', 'Unknown profile', { field: 'profile' });
            scopes = PROFILES[body.profile].slice();
        } else {
            if (!Array.isArray(body.scopes) || (body.scopes.length < 1)) throw new ApiError(400, 'invalid_request', 'Invalid scopes', { field: 'scopes' });
            const seen = {};
            for (const s of body.scopes) {
                if ((typeof s != 'string') || (SCOPES.indexOf(s) < 0) || seen[s]) throw new ApiError(400, 'invalid_request', 'Invalid scopes', { field: 'scopes' });
                seen[s] = true;
            }
            scopes = SCOPES.filter(function (s) { return (s == 'read') || seen[s]; });
        }
        const cap = maxLifetimeDays(scopes);
        let days = Math.min(90, cap);
        if (body.expires_in_days !== undefined) {
            if (!Number.isInteger(body.expires_in_days) || (body.expires_in_days < 1) || (body.expires_in_days > 365)) throw new ApiError(400, 'invalid_request', 'Invalid expires_in_days', { field: 'expires_in_days' });
            if (body.expires_in_days > cap) throw new ApiError(400, 'invalid_request', 'Lifetime too long for these scopes (max ' + cap + ' days)', { field: 'expires_in_days', max: cap });
            days = body.expires_in_days;
        }
        let groups = null;
        if (body.groups !== undefined) {
            if (!Array.isArray(body.groups) || (body.groups.length < 1) || (body.groups.length > 100)) throw new ApiError(400, 'invalid_request', 'Invalid groups', { field: 'groups' });
            const seen = {};
            for (const g of body.groups) {
                if ((typeof g != 'string') || !ID_RE.test(g) || seen[g]) throw new ApiError(400, 'invalid_request', 'Invalid groups', { field: 'groups' });
                seen[g] = true;
                const meshid = 'mesh/' + ctx.domain.id + '/' + g;
                const mesh = ws.meshes[meshid];
                if ((mesh == null) || (mesh.deleted != null) || (ws.GetMeshRights(ctx.user, meshid) == 0)) throw new ApiError(400, 'invalid_request', 'Unknown group', { field: 'groups' });
            }
            groups = body.groups.slice();
        }
        if ((scopes.indexOf('console') >= 0) && (groups == null)) throw new ApiError(400, 'invalid_request', 'Tokens with console need a groups list', { field: 'groups' });
        let allowedIps = null;
        if (body.allowed_ips !== undefined) {
            if (!Array.isArray(body.allowed_ips) || (body.allowed_ips.length < 1) || (body.allowed_ips.length > 20) || !body.allowed_ips.every(isValidCidr)) throw new ApiError(400, 'invalid_request', 'Invalid allowed_ips', { field: 'allowed_ips' });
            allowedIps = body.allowed_ips.slice();
        }
        return { name: body.name, scopes: scopes, days: days, groups: groups, allowedIps: allowedIps };
    }

    // GET /api/v1/auth/tokens
    async function listOwn(req, res, ctx) {
        const limit = parseLimit(req.query);
        const cursor = decodeCursor(req.query.cursor);
        const q = Object.assign({ owner: ctx.userid, domain: ctx.domain.id }, Tokens.listableQuery());
        res.json(page(await core.tokens.list(q, { limit: limit, cursor: cursor })));
    }

    // POST /api/v1/auth/tokens
    async function create(req, res, ctx) {
        const opts = parseCreate(ctx, req.body);
        if (needsStepUp(opts.scopes)) ctx.requireStepUp();
        if ((await core.tokens.liveCount(ctx.userid)) >= MAX_LIVE_TOKENS) throw new ApiError(409, 'token_limit', 'Token limit reached');
        const r = await core.tokens.create({ name: opts.name, owner: ctx.userid, domain: ctx.domain.id, scopes: opts.scopes, days: opts.days, groups: opts.groups, allowedIps: opts.allowedIps });
        core.audit.write({ domain: ctx.domain.id, action: 'outband.token.create', user: ctx.userid, userName: ctx.user.name, tokenId: r.doc._id, tokenName: r.doc.name, ip: ctx.ip, params: { scopes: opts.scopes.join(' ') } });
        res.status(201).json({ token: Tokens.toApi(r.doc, ctx.user.name), secret: r.secret });
    }

    async function revokeCommon(req, res, ctx, admin) {
        const id = req.params.tokenId;
        if (!TOKEN_ID_RE.test(id)) throw new ApiError(404, 'not_found', 'Token not found');
        const doc = await core.tokens.get(id);
        if ((doc == null) || (doc.domain != ctx.domain.id) || (!admin && (doc.owner != ctx.userid))) throw new ApiError(404, 'not_found', 'Token not found');
        const was = doc.revoked;
        await core.tokens.revoke(doc, ctx.userid, 'revoked');
        core.tickets.cancelCredential('tok:' + doc._id);
        if (was == null) {
            core.audit.write({ domain: ctx.domain.id, action: 'outband.token.revoke', user: ctx.userid, userName: ctx.user.name, tokenId: doc._id, tokenName: doc.name, ip: ctx.ip, subject: (doc.owner != ctx.userid) ? doc.owner : null, params: admin ? { owner: lastSegment(doc.owner) } : {} });
        }
        res.status(204).end();
    }

    // DELETE /api/v1/auth/tokens/{tokenId}
    function revokeOwn(req, res, ctx) { return revokeCommon(req, res, ctx, false); }

    // GET /api/v1/admin/tokens
    async function adminList(req, res, ctx) {
        const limit = parseLimit(req.query);
        const cursor = decodeCursor(req.query.cursor);
        const q = { domain: ctx.domain.id };
        if (req.query.user !== undefined) {
            if ((typeof req.query.user != 'string') || !USER_ID_RE.test(req.query.user)) throw new ApiError(400, 'invalid_request', 'Invalid user', { field: 'user' });
            q.owner = 'user/' + ctx.domain.id + '/' + req.query.user.toLowerCase();
        }
        if (req.query.prefix !== undefined) {
            if ((typeof req.query.prefix != 'string') || (req.query.prefix.length < 4) || (req.query.prefix.length > 12)) throw new ApiError(400, 'invalid_request', 'Invalid prefix', { field: 'prefix' });
            q.prefix = { $regex: new RegExp('^' + escapeRegex(req.query.prefix)) };
        }
        let includeRevoked = false;
        if (req.query.include_revoked !== undefined) {
            if ((req.query.include_revoked !== 'true') && (req.query.include_revoked !== 'false')) throw new ApiError(400, 'invalid_request', 'Invalid include_revoked', { field: 'include_revoked' });
            includeRevoked = (req.query.include_revoked === 'true');
        }
        Object.assign(q, Tokens.listableQuery());
        if (!includeRevoked) { q.revoked = null; }
        res.json(page(await core.tokens.list(q, { limit: limit, cursor: cursor })));
    }

    // DELETE /api/v1/admin/tokens/{tokenId}
    function adminRevoke(req, res, ctx) { return revokeCommon(req, res, ctx, true); }

    // GET /api/v1/admin/settings
    async function getSettings(req, res) { res.json(core.settings.view()); }

    // PUT /api/v1/admin/settings
    async function putSettings(req, res, ctx) {
        const body = req.body;
        checkFields(body, ['bearer'], []);
        if (Object.keys(body).length < 1) throw new ApiError(400, 'invalid_request', 'Nothing to change');
        if (typeof body.bearer != 'boolean') throw new ApiError(400, 'invalid_request', 'Invalid bearer', { field: 'bearer' });
        ctx.requireStepUp();
        const before = await core.settings.setBearer(body.bearer, lastSegment(ctx.userid));
        if (before !== body.bearer) {
            core.audit.write({ domain: ctx.domain.id, type: 'server', action: 'outband.settings.bearer', user: ctx.userid, userName: ctx.user.name, ip: ctx.ip, params: { state: body.bearer ? 'on' : 'off' } });
        }
        res.json(core.settings.view());
    }

    return { listOwn, create, revokeOwn, adminList, adminRevoke, getSettings, putSettings };
};
