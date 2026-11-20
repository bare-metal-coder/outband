/**
 * @description Outband API: credential resolution and the authenticated context.
 *
 * A request uses exactly one credential. A bearer token wins over a cookie.
 * The owning user is loaded from the database on every request; nothing is
 * cached from token creation or login time.
 * @license Apache-2.0
 */

'use strict';

const { ApiError, FULL_RIGHTS, SITE_LOCKED, lastSegment, ipInCidr, isSecureRequest } = require('./util');
const { SCOPES } = require('./tokens');

const STEP_UP_MS = 15 * 60000;

/** True when a user record may not authenticate (missing, or locked and not a full admin). */
function userBlocked(user) {
    if ((user == null) || (user.type != 'user')) return true;
    const sa = user.siteadmin;
    if ((typeof sa == 'number') && (sa != FULL_RIGHTS) && ((sa & SITE_LOCKED) != 0)) return true;
    return false;
}

/** Time (ms) before which sessions and tokens of this user are invalid (password change or reset). */
function notBefore(user) {
    return ((typeof user.passchange == 'number') && (user.passchange > 0)) ? (user.passchange * 1000) : 0;
}

/**
 * The authenticated principal of an API request.
 * Resource handlers receive one of these; see outband/CONTRIBUTING-API.md.
 */
class AuthContext {
    constructor(core, o) {
        this.core = core;
        /** MeshCentral domain object. */
        this.domain = o.domain;
        /** User record, freshly loaded from the database for this request. */
        this.user = o.user;
        /** Full MeshCentral user id, `user/<domain>/<name>`. */
        this.userid = o.user._id;
        /** 'cookie' or 'token'. */
        this.method = o.method;
        /** Scopes this credential holds (a session holds every scope). */
        this.scopes = o.scopes.slice();
        /** Token record (bearer only), else null. */
        this.token = o.token || null;
        /** Session record {u, x, ia, la, la2} (cookie only), else null. */
        this.session = o.session || null;
        /** Stable key of the credential: `tok:<id>` or `ses:<userid>/<x>`. */
        this.credentialKey = o.credentialKey;
        /** Client address as resolved by MeshCentral. */
        this.ip = o.ip;
    }

    get isCookie() { return this.method == 'cookie'; }
    get isToken() { return this.method == 'token'; }

    hasScope(scope) { return this.scopes.indexOf(scope) >= 0; }

    /** Throws 403 insufficient_scope. */
    requireScope(scope) {
        if (!this.hasScope(scope)) throw new ApiError(403, 'insufficient_scope', 'This credential lacks the required scope', { required_scope: scope });
    }

    /** Browser-session-only endpoints: throws 403 forbidden, reason session_required. */
    requireSession() {
        if (!this.isCookie) throw new ApiError(403, 'forbidden', 'This endpoint needs a browser session', { reason: 'session_required' });
    }

    isFullAdmin() { return this.user.siteadmin === FULL_RIGHTS; }

    requireFullAdmin() {
        if (!this.isFullAdmin()) throw new ApiError(403, 'forbidden', 'Full site administrators only');
    }

    /** The token's group restriction (short group ids), or null for none. */
    get groupRestriction() { return (this.token && Array.isArray(this.token.groups)) ? this.token.groups : null; }

    /** True when the token's `groups` restriction allows this group (short id or full mesh id). */
    groupAllowed(groupId) {
        const r = this.groupRestriction;
        if (r == null) return true;
        return r.indexOf(lastSegment(groupId)) >= 0;
    }

    /**
     * The owner's effective MeshCentral rights on a device group, after the
     * token's group restriction (0 when the group is outside it).
     * @param {string|object} mesh full mesh id or mesh object
     */
    meshRights(mesh) {
        const id = (typeof mesh == 'string') ? mesh : (mesh && mesh._id);
        if ((typeof id != 'string') || !id.startsWith('mesh/' + this.domain.id + '/')) return 0;
        if (!this.groupAllowed(id)) return 0;
        return this.core.webserver.GetMeshRights(this.user, id) >>> 0;
    }

    /** Full rights (0xFFFFFFFF) are not subject to "must not have" bits. */
    static hasRight(rights, need, mustNot) {
        rights = rights >>> 0;
        if (rights == FULL_RIGHTS) return true;
        if ((rights & need) != need) return false;
        if ((mustNot != null) && ((rights & mustNot) != 0)) return false;
        return true;
    }

    /** Domain-wide event view: ALLEVENTS (0x800) or full site admin, and no group restriction. */
    domainWideEvents() {
        if (this.groupRestriction != null) return false;
        const sa = this.user.siteadmin >>> 0;
        return (sa == FULL_RIGHTS) || ((sa & 0x800) != 0);
    }

    /** Real user and token names in events: sessions and tokens with `audit`. */
    seesIdentities() { return this.isCookie || this.hasScope('audit'); }

    /** source_ip: full site admins only, by session or by an unrestricted `audit` token. */
    seesSourceIp() {
        if (!this.isFullAdmin()) return false;
        if (this.isCookie) return true;
        return this.hasScope('audit') && (this.groupRestriction == null);
    }

    /** Device `ips` and `hardware.serial`: sessions, and tokens with `console`. */
    seesDeviceAddresses() { return this.isCookie || this.hasScope('console'); }

    /** `user.email` and `user.siteadmin` in /session: sessions, and tokens with `identity`. */
    seesOwnIdentity() { return this.isCookie || this.hasScope('identity'); }

    /** Pseudonym of a user id as seen by this credential (when identities are hidden). */
    pseudonymUser(userid) { return this.core.pseudonyms.user(this.credentialKey, userid); }
    pseudonymToken(tokenId) { return this.core.pseudonyms.token(this.credentialKey, tokenId); }

    /** Step-up: last_auth (and last_auth_2fa when a second factor is enrolled) within 15 minutes. */
    stepUpOk() {
        if (!this.isCookie || (this.session == null)) return false;
        const now = Date.now();
        if ((this.session.la == null) || (now - this.session.la > STEP_UP_MS)) return false;
        const mcUser = this.core.webserver.users[this.userid] || this.user;
        if (this.core.hooks.userHasSecondFactor(this.domain, mcUser)) {
            if ((this.session.la2 == null) || (now - this.session.la2 > STEP_UP_MS)) return false;
        }
        return true;
    }

    requireStepUp() {
        if (!this.stepUpOk()) throw new ApiError(401, 'reauth_required', 'Recent authentication required');
    }

    /** Re-check the credential (for streams and consoles). Resolves to null, or a `closed` reason. */
    revalidate() { return this.core.revalidate(this); }
}

/** Load a user record from the database. */
function loadUser(webserver, userid) {
    return new Promise(function (resolve) {
        if (typeof userid != 'string') { resolve(null); return; }
        try {
            webserver.db.Get(userid, function (err, docs) {
                if (err || (docs == null) || (docs.length != 1)) { resolve(null); return; }
                resolve(docs[0]);
            });
        } catch (ex) { resolve(null); }
    });
}

function parseBearer(req) {
    const h = req.headers.authorization;
    if (h == null) return null;
    const m = /^Bearer[ ]+(\S+)\s*$/i.exec(String(h));
    return { secret: m ? m[1] : '' };
}

/**
 * Resolve the request's credential.
 * Resolves to an AuthContext, or null when the request carries no credential.
 * Throws ApiError for a credential that is present but refused.
 */
async function resolveCredential(core, req) {
    const domain = req.xdomain;
    const ip = req.clientIp;
    const bearer = parseBearer(req);

    if (bearer != null) {
        if (!isSecureRequest(core.webserver.args, req)) throw new ApiError(403, 'https_required', 'Bearer tokens need TLS');
        const lockedFor = core.limits.invalidBearer.lockedFor(ip);
        if (lockedFor > 0) throw new ApiError(429, 'rate_limited', 'Too many invalid tokens', null, { 'Retry-After': String(lockedFor) });
        if (!core.settings.bearer()) throw new ApiError(401, 'bearer_disabled', 'Bearer authentication is turned off');
        const doc = await core.tokens.findBySecret(bearer.secret);
        if ((doc == null) || (doc.domain != domain.id)) {
            core.limits.invalidBearer.fail(ip);
            throw new ApiError(401, 'unauthenticated', 'Invalid token');
        }
        const auditEnded = function (reason) {
            core.audit.deny('tok:' + doc._id, { domain: domain.id, action: 'outband.token.use_ended', reason: reason, user: doc.owner, tokenId: doc._id, tokenName: doc.name, ip: ip });
        };
        if (doc.revoked != null) { core.limits.invalidBearer.fail(ip); auditEnded('revoked'); throw new ApiError(401, 'token_revoked', 'Token revoked'); }
        if (doc.expires <= Date.now()) { core.limits.invalidBearer.fail(ip); auditEnded('expired'); throw new ApiError(401, 'token_expired', 'Token expired'); }
        if (Array.isArray(doc.allowed_ips) && !doc.allowed_ips.some(function (c) { return ipInCidr(ip, c); })) {
            throw new ApiError(403, 'ip_not_allowed', 'Client address not allowed for this token');
        }
        const user = await loadUser(core.webserver, doc.owner);
        if (userBlocked(user) || (notBefore(user) > doc.created)) { auditEnded('user'); throw new ApiError(401, 'token_revoked', 'Token revoked'); }
        core.tokens.touch(doc);
        const scopes = SCOPES.filter(function (s) { return (s == 'read') || (doc.scopes.indexOf(s) >= 0); });
        return new AuthContext(core, { domain: domain, user: user, method: 'token', scopes: scopes, token: doc, credentialKey: 'tok:' + doc._id, ip: ip });
    }

    const s = req.session;
    if ((s == null) || (typeof s.userid != 'string')) return null;
    const clear = function () { req.session = null; };
    if (s.loginToken != null) throw new ApiError(401, 'unauthenticated', 'Login-token sessions cannot use this API');
    if (s.userid.split('/')[1] !== domain.id) return null;
    const rec = core.sessions.get(s.userid, s.x);
    if (rec == null) { clear(); throw new ApiError(401, 'unauthenticated', 'Session expired'); }
    const user = await loadUser(core.webserver, s.userid);
    if (userBlocked(user) || (notBefore(user) > rec.ia)) {
        await core.sessions.revoke(s.userid, s.x, userBlocked(user) ? 'locked' : 'expired');
        clear();
        throw new ApiError(401, 'unauthenticated', 'Session ended');
    }
    return new AuthContext(core, { domain: domain, user: user, method: 'cookie', scopes: SCOPES.slice(), session: rec, credentialKey: 'ses:' + s.userid + '/' + s.x, ip: ip });
}

/** Re-check a context. Resolves to null when still valid, else a `closed` reason. */
async function revalidate(core, ctx) {
    if (ctx.isToken) {
        if (!core.settings.bearer()) return 'disabled';
        const doc = await core.tokens.get(ctx.token._id);
        if ((doc == null) || (doc.revoked != null)) return 'revoked';
        if (doc.expires <= Date.now()) return 'expired';
        const user = await loadUser(core.webserver, doc.owner);
        if (userBlocked(user)) return 'locked';
        if (notBefore(user) > doc.created) return 'revoked';
        ctx.user = user;
        return null;
    }
    const rec = core.sessions.get(ctx.userid, ctx.session && ctx.session.x);
    if (rec == null) return core.sessions.revoked.has(ctx.userid + '/' + (ctx.session && ctx.session.x)) ? 'logout' : 'expired';
    const user = await loadUser(core.webserver, ctx.userid);
    if (userBlocked(user)) return 'locked';
    if (notBefore(user) > rec.ia) return 'expired';
    ctx.user = user;
    return null;
}

module.exports = { AuthContext, resolveCredential, revalidate, loadUser, userBlocked, notBefore, STEP_UP_MS };
