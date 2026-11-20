/**
 * @description Outband API: the /api/v1 router.
 *
 * Order for every request: base headers, OPTIONS refusal, /health,
 * availability (503), Host check (421), credentials in the URL (400), then
 * the route (CSRF, credential, rate limit, handler).
 * @license Apache-2.0
 */

'use strict';

const express = require('express');
const { ApiError, sendError, iso, encodeCursor, decodeCursor, parseLimit, lastSegment } = require('./util');
const { baseHeaders, route, csrfOk } = require('./http');
const { checkHost, hasConfiguredName } = require('./hostorigin');
const { resolveCredential } = require('./auth');
const { Tickets, PROTOCOL } = require('./tickets');
const { Idempotency } = require('./idempotency');
const { fromTrustedProxy } = require('./util');
const power = require('./power');

const ID_RE = /^[A-Za-z0-9@$_-]{8,128}$/;
const URL_CREDENTIALS = ['token', 'access_token', 'ticket'];

function checkId(v, field) { if ((typeof v != 'string') || !ID_RE.test(v)) throw new ApiError(400, 'invalid_request', 'Invalid ' + field, { field: field }); return v; }
function optId(q, field) { return (q[field] === undefined) ? undefined : checkId(q[field], field); }
function optTime(q, field) {
    if (q[field] === undefined) return undefined;
    const d = (typeof q[field] == 'string') ? new Date(q[field]) : null;
    if ((d == null) || isNaN(d.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(q[field])) throw new ApiError(400, 'invalid_request', 'Invalid ' + field, { field: field });
    return d;
}
function sendPage(res, r) { const b = { items: r.items, next_cursor: r.next ? encodeCursor(r.next) : null }; if (r.truncated === true) b.truncated = true; res.json(b); }
function pageArgs(q) { return { limit: parseLimit(q), cursor: decodeCursor(q.cursor) }; }

function buildRouter(core) {
    const router = express.Router({ caseSensitive: true, strict: false });
    const ws = core.webserver;
    const authH = require('./handlers/auth')(core);
    const tokH = require('./handlers/tokens')(core);
    const srvH = require('./handlers/server')(core);
    const R = function (opts, fn) { return route(core, opts, fn); };
    const res_ = function () { return core.resources; };

    router.use(baseHeaders);

    // No CORS. Every OPTIONS request is refused.
    router.use(function (req, res, next) {
        if (req.method == 'OPTIONS') {
            core.audit.deny(null, { domain: (req.xdomain && req.xdomain.id) || '', action: 'outband.csrf', reason: 'options', ip: req.clientIp });
            sendError(res, 403, 'csrf_failed', 'OPTIONS requests are refused');
            return;
        }
        next();
    });

    // Health: no authentication, no configuration details.
    router.get('/health', function (req, res) {
        const r = core.limits.health.hit('ip:' + req.clientIp);
        if (!r.allowed) { sendError(res, 429, 'rate_limited', 'Too many requests', null, { 'Retry-After': String(r.resetSec) }); return; }
        srvH.health(req, res).catch(function () { sendError(res, 503, 'unavailable', 'Unavailable'); });
    });

    // Availability, Host, URL credentials.
    router.use(function (req, res, next) {
        if (core.state != 'ready') { sendError(res, 503, 'unavailable', 'Starting'); return; }
        const domain = req.xdomain;
        if ((domain == null) || core.apiDisabled() || core.noAuthMode() || !hasConfiguredName(domain, ws.certificates)) {
            sendError(res, 503, 'unavailable', 'The API is not available in this server configuration'); return;
        }
        if (!checkHost(req, domain, ws.certificates, ws.args, fromTrustedProxy(ws.args, req))) { sendError(res, 421, 'invalid_host', 'Host is not a configured name'); return; }
        for (const k of URL_CREDENTIALS) {
            if (req.query[k] !== undefined) { sendError(res, 400, 'invalid_request', 'Credentials are not accepted in the URL', { field: k }); return; }
        }
        next();
    });

    // Server and session
    router.get('/server', R({ auth: 'required' }, srvH.server));
    router.get('/session', R({ auth: 'optional', rateLimit: false }, authH.getSession));

    // Auth
    router.post('/auth/login', R({ auth: 'none', csrf: 'always', rateLimit: false }, authH.login));
    router.post('/auth/2fa', R({ auth: 'none', csrf: 'always', rateLimit: false }, authH.secondFactor));
    router.post('/auth/reauth', R({ auth: 'required', session: true, rateLimit: false }, authH.reauth));
    router.post('/auth/logout', R({ auth: 'none', csrf: 'always', rateLimit: false }, authH.logout));

    // Tokens (browser session only)
    router.get('/auth/tokens', R({ auth: 'required', session: true }, tokH.listOwn));
    router.post('/auth/tokens', R({ auth: 'required', session: true }, tokH.create));
    router.delete('/auth/tokens/:tokenId', R({ auth: 'required', session: true }, tokH.revokeOwn));

    // Admin (full site admin, browser session only)
    router.get('/admin/tokens', R({ auth: 'required', session: true, admin: true }, tokH.adminList));
    router.delete('/admin/tokens/:tokenId', R({ auth: 'required', session: true, admin: true }, tokH.adminRevoke));
    router.get('/admin/settings', R({ auth: 'required', session: true, admin: true }, tokH.getSettings));
    router.put('/admin/settings', R({ auth: 'required', session: true, admin: true }, tokH.putSettings));

    // Resources (implemented through the Resources interface; stubs answer 501)
    router.get('/groups', R({ auth: 'required' }, async function (req, res, ctx) { sendPage(res, await res_().listGroups(ctx, pageArgs(req.query))); }));
    router.get('/groups/:groupId', R({ auth: 'required' }, async function (req, res, ctx) { res.json(await res_().getGroup(ctx, checkId(req.params.groupId, 'groupId'))); }));
    router.get('/devices', R({ auth: 'required' }, async function (req, res, ctx) {
        const q = req.query, a = pageArgs(q);
        a.group = optId(q, 'group');
        if (q.status !== undefined) { if (['online', 'offline', 'amt'].indexOf(q.status) < 0) throw new ApiError(400, 'invalid_request', 'Invalid status', { field: 'status' }); a.status = q.status; }
        if (q.q !== undefined) { if ((typeof q.q != 'string') || (q.q.length > 128)) throw new ApiError(400, 'invalid_request', 'Invalid q', { field: 'q' }); a.q = q.q; }
        sendPage(res, await res_().listDevices(ctx, a));
    }));
    router.get('/devices/:deviceId', R({ auth: 'required' }, async function (req, res, ctx) { res.json(await res_().getDevice(ctx, checkId(req.params.deviceId, 'deviceId'))); }));
    router.post('/devices/:deviceId/power', R({ auth: 'required' }, async function (req, res, ctx) {
        const deviceId = checkId(req.params.deviceId, 'deviceId');
        const body = req.body;
        if ((body == null) || (typeof body != 'object') || Array.isArray(body)) throw new ApiError(400, 'invalid_request', 'A JSON object body is required');
        for (const k of Object.keys(body)) { if ((k != 'action') && (k != 'via')) throw new ApiError(400, 'invalid_request', 'Unknown field', { field: k }); }
        if (typeof body.action != 'string') throw new ApiError(400, 'invalid_request', 'Missing field', { field: 'action' });
        if (power.ACTIONS.indexOf(body.action) < 0) throw new ApiError(400, 'invalid_request', 'Invalid action', { field: 'action' });
        if ((body.via !== undefined) && (power.PATHS.indexOf(body.via) < 0)) throw new ApiError(400, 'invalid_request', 'Invalid via', { field: 'via' });
        ctx.requireScope(power.scopeForAction(body.action)); // central scope check, before any idempotency lookup
        const key = req.headers['idempotency-key'];
        if ((key !== undefined) && !Idempotency.validKey(key)) throw new ApiError(400, 'invalid_request', 'Invalid Idempotency-Key', { field: 'Idempotency-Key' });
        const lim = core.limits.action.hit(ctx.credentialKey);
        if (!lim.allowed) throw new ApiError(429, 'rate_limited', 'Too many power and console requests', null, { 'Retry-After': String(lim.resetSec) });
        if (key !== undefined) {
            const prev = await core.idempotency.lookup(ctx.credentialKey, key, 'power:' + deviceId, body);
            if (prev && prev.conflict) throw new ApiError(409, 'idempotency_conflict', 'Idempotency-Key reused with a different body');
            if (prev) { res.status(prev.status).json(prev.body); return; }
        }
        const result = await res_().powerAction(ctx, deviceId, { action: body.action, via: body.via }, { idempotencyKey: key || null });
        if (key !== undefined) { await core.idempotency.save(ctx.credentialKey, key, 'power:' + deviceId, body, 202, result); }
        res.status(202).json(result);
    }));
    const eventLimit = function (ctx) {
        const lim = core.limits.events.hit(ctx.credentialKey);
        if (!lim.allowed) throw new ApiError(429, 'rate_limited', 'Too many event reads', null, { 'Retry-After': String(lim.resetSec) });
    };
    router.get('/devices/:deviceId/events', R({ auth: 'required' }, async function (req, res, ctx) {
        eventLimit(ctx);
        const a = pageArgs(req.query); a.since = optTime(req.query, 'since'); a.until = optTime(req.query, 'until');
        sendPage(res, await res_().listDeviceEvents(ctx, checkId(req.params.deviceId, 'deviceId'), a));
    }));
    router.get('/events', R({ auth: 'required' }, async function (req, res, ctx) {
        eventLimit(ctx);
        const q = req.query, a = pageArgs(q);
        a.device = optId(q, 'device'); a.group = optId(q, 'group'); a.since = optTime(q, 'since'); a.until = optTime(q, 'until');
        if (q.type !== undefined) { if ((typeof q.type != 'string') || (q.type.length > 32)) throw new ApiError(400, 'invalid_request', 'Invalid type', { field: 'type' }); a.type = q.type; }
        if (q.audit !== undefined) { if ((q.audit !== 'true') && (q.audit !== 'false')) throw new ApiError(400, 'invalid_request', 'Invalid audit', { field: 'audit' }); a.audit = (q.audit === 'true'); }
        sendPage(res, await res_().listEvents(ctx, a));
    }));

    // Console tickets
    router.post('/devices/:deviceId/console/:kind/ticket', R({ auth: 'required' }, async function (req, res, ctx) {
        const deviceId = checkId(req.params.deviceId, 'deviceId');
        const kind = req.params.kind;
        if ((kind != 'sol') && (kind != 'terminal')) throw new ApiError(400, 'invalid_request', 'Invalid kind', { field: 'kind' });
        ctx.requireScope('console'); // central scope check
        const lim = core.limits.action.hit(ctx.credentialKey);
        if (!lim.allowed) throw new ApiError(429, 'rate_limited', 'Too many power and console requests', null, { 'Retry-After': String(lim.resetSec) });
        let target;
        try { target = await res_().consoleTarget(ctx, deviceId, kind); }
        catch (ex) {
            if ((ex instanceof ApiError) && (ex.status == 403)) {
                core.audit.deny(ctx.credentialKey, { domain: ctx.domain.id, type: 'node', action: 'outband.console.ticket', reason: ex.code, user: ctx.userid, tokenId: ctx.token && ctx.token._id, deviceId: 'node/' + ctx.domain.id + '/' + deviceId, ip: ctx.ip, params: { kind: kind } });
            }
            throw ex;
        }
        const t = core.tickets.issue({ userid: ctx.userid, deviceId: target.deviceId || deviceId, kind: kind, credentialKey: ctx.credentialKey, cookie: ctx.isCookie });
        core.audit.write({ domain: ctx.domain.id, type: 'node', action: 'outband.console.ticket', user: ctx.userid, userName: ctx.user.name, tokenId: ctx.token && ctx.token._id, tokenName: ctx.token && ctx.token.name, deviceId: 'node/' + ctx.domain.id + '/' + deviceId, groupId: target.groupId ? ('mesh/' + ctx.domain.id + '/' + lastSegment(target.groupId)) : null, ip: ctx.ip, params: { kind: kind } });
        res.status(201).json({
            url: '/api/v1/devices/' + encodeURIComponent(deviceId) + '/console/' + kind,
            protocols: [PROTOCOL, 'outband.ticket.' + t.ticket],
            expires_at: iso(t.expires)
        });
    }));

    // Console WebSocket (needs express-ws, present in the MeshCentral server)
    if (typeof router.ws == 'function') {
        router.ws('/devices/:deviceId/console/:kind', async function (wsock, req) {
            const close = function (code) { try { wsock.close(code); } catch (ex) { } };
            try {
                const deviceId = req.params.deviceId, kind = req.params.kind;
                const binding = core.tickets.consume(Tickets.fromProtocols(req.headers['sec-websocket-protocol']), deviceId, kind);
                if (binding == null) { close(4401); return; }
                if (binding.cookie && !require('./hostorigin').checkOrigin(req, req.xdomain, ws.certificates, ws.args)) { close(4401); return; }
                let ctx = null;
                try { ctx = await resolveCredential(core, req); } catch (ex) { ctx = null; }
                if ((ctx == null) || (ctx.credentialKey != binding.credentialKey) || (ctx.userid != binding.userid)) { close(4403); return; }
                try { await core.resources.consoleTarget(ctx, deviceId, kind); }
                catch (ex) { close(((ex instanceof ApiError) && (ex.status == 409)) ? 4409 : ((ex instanceof ApiError) && (ex.status == 501)) ? 1011 : 4403); return; }
                core.audit.write({ domain: ctx.domain.id, type: 'node', action: 'outband.console.open', user: ctx.userid, userName: ctx.user.name, tokenId: ctx.token && ctx.token._id, deviceId: 'node/' + ctx.domain.id + '/' + deviceId, ip: ctx.ip, params: { kind: kind } });
                core.resources.openConsole(wsock, ctx, { deviceId: deviceId, kind: kind });
            } catch (ex) { close(1011); }
        });
    }

    // Stream (the resource layer owns the response)
    router.get('/stream', R({ auth: 'required' }, async function (req, res, ctx) {
        const q = req.query;
        let types = null;
        if (q.types !== undefined) {
            if ((typeof q.types != 'string') || (q.types.length > 256)) throw new ApiError(400, 'invalid_request', 'Invalid types', { field: 'types' });
            types = q.types.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
        }
        let last = req.headers['last-event-id'];
        if (last === undefined) last = q.last_event_id;
        if ((last !== undefined) && ((typeof last != 'string') || (last.length > 64))) throw new ApiError(400, 'invalid_request', 'Invalid last event id', { field: 'last_event_id' });
        const releaseTotal = core.limits.streamsTotal.acquire('all');
        if (releaseTotal == null) throw new ApiError(429, 'rate_limited', 'Too many concurrent streams on this server', null, { 'Retry-After': '5' });
        const releaseCred = core.limits.streams.acquire(ctx.credentialKey);
        if (releaseCred == null) { releaseTotal(); throw new ApiError(429, 'rate_limited', 'Too many concurrent streams', null, { 'Retry-After': '5' }); }
        const release = function () { releaseCred(); releaseTotal(); };
        res.on('close', release);
        try { await res_().stream(ctx, req, res, { types: types, lastEventId: (last === undefined) ? null : last }); }
        catch (ex) { release(); throw ex; }
    }));

    router.use(function (req, res) { sendError(res, 404, 'not_found', 'No such endpoint'); });
    return router;
}

module.exports = { buildRouter, csrfOk };
