/**
 * @description Outband API: /session, /auth/login, /auth/2fa, /auth/reauth, /auth/logout.
 * @license Apache-2.0
 */

'use strict';

const crypto = require('crypto');
const { ApiError, iso, lastSegment, FULL_RIGHTS } = require('../util');
const { redactString } = require('../redact');
const { checkFields } = require('../http');
const { loadUser, userBlocked } = require('../auth');
const twofa = require('../twofa');

const DUMMY_SALT = crypto.randomBytes(64).toString('base64');
const SECOND_FACTOR_METHODS = ['otp', 'backup', 'email', 'sms', 'messaging', 'yubikey'];
const SEND_METHODS = ['email', 'sms', 'messaging'];
const REFUSED = function () { return new ApiError(401, 'invalid_credentials', 'Invalid username or password'); };

/** Spend the same time as a real password check. */
function dummyHash(password) {
    return new Promise(function (resolve) {
        try { require('../../pass').hash(String(password || ''), DUMMY_SALT, function () { resolve(); }, 0); } catch (ex) { resolve(); }
    });
}

function userView(user, full) {
    const u = { id: lastSegment(user._id), name: user.name };
    if (full) { u.email = (typeof user.email == 'string') ? user.email : null; u.siteadmin = (typeof user.siteadmin == 'number') ? (user.siteadmin >>> 0) : 0; }
    return u;
}

/** A user-supplied name made safe for log lines: no control characters, secrets redacted, bounded length. */
function logName(s) { return redactString(String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?')).substring(0, 64); }

function serverName(domain) { return (typeof domain.title == 'string' && domain.title.length > 0) ? domain.title : 'Outband'; }

/** Ask MeshCentral's authenticator, without its login-token path and with a dummy hash for unknown local users. */
function checkPassword(core, username, password, domain) {
    return new Promise(function (resolve) {
        const ws = core.webserver;
        const local = (domain.auth == null) || (domain.auth == '') || ((domain.auth != 'ldap') && (domain.auth != 'sspi'));
        if (local) {
            const u = ws.users['user/' + domain.id + '/' + username.toLowerCase()];
            if ((u == null) || (u.salt == null)) { dummyHash(password).then(function () { resolve({ err: 'unknown' }); }); return; }
        }
        try {
            ws.authenticate(username, password, domain, function (err, userid, passhint, loginOptions) {
                resolve({ err: err, userid: userid, loginOptions: loginOptions });
            });
        } catch (ex) { resolve({ err: ex }); }
    });
}

/** Policy checks that make MeshCentral's own login page ask for something the API cannot do. */
function loginBlockedByPolicy(core, domain, user, req) {
    const parent = core.parent, ws = core.webserver;
    if ((parent.config.settings.maintenancemode != null) && (user.siteadmin != FULL_RIGHTS)) return 'maintenance';
    if ((typeof user.passchange == 'number') && ((user.passchange == -1) || ((typeof domain.passwordrequirements == 'object') && (typeof domain.passwordrequirements.reset == 'number') && (user.passchange + (domain.passwordrequirements.reset * 86400) < Math.floor(Date.now() / 1000))))) return 'password_change_required';
    const cn = ws.certificates.CommonName || '';
    const emailcheck = ((domain.mailserver != null) && (cn.indexOf('.') != -1) && (ws.args.lanonly != true) && (domain.auth != 'sspi') && (domain.auth != 'ldap'));
    if (emailcheck && (user.emailVerified !== true)) return 'email_unverified';
    if ((typeof ws.force2factorPending == 'function') && ws.force2factorPending(domain, user, req)) return 'second_factor_setup_required';
    return null;
}

/** Second factors this user needs right now, or null when none is required. Throws REFUSED when one is required but impossible. */
function secondFactorPlan(core, domain, user, req) {
    const fakeReq = { clientIp: req.clientIp, headers: {} }; // never the "remember this device" cookie
    const required = core.hooks.checkUserOneTimePasswordRequired(domain, user, fakeReq, null);
    if (!required) return null;
    if (!twofa.available(core, domain)) return { refuse: 'second_factor_unavailable' };
    const methods = twofa.userMethods(core, domain, user);
    if (methods.length == 0) return { refuse: 'second_factor_unsupported' }; // e.g. WebAuthn only
    return { methods: methods };
}

/** Send a code by email, SMS or messaging (same as MeshCentral's login page). */
function sendCode(core, domain, user, method, req) {
    const ws = core.webserver, parent = core.parent;
    const digits = function (n) { let s = ''; for (let i = 0; i < n; i++) s += crypto.randomInt(10); return s; };
    if (method == 'email') {
        user.otpekey = { k: digits(8), d: Date.now() };
        ws.db.SetUser(user);
        domain.mailserver.sendAccountLoginMail(domain, user.email, user.otpekey.k, ws.getLanguageCodes(req), null);
    } else if (method == 'sms') {
        user.otpsms = { k: digits(6), d: Date.now() };
        ws.db.SetUser(user);
        parent.smsserver.sendToken(domain, user.phone, user.otpsms.k, ws.getLanguageCodes(req));
    } else if (method == 'messaging') {
        user.otpmsg = { k: digits(6), d: Date.now() };
        ws.db.SetUser(user);
        parent.msgserver.sendToken(domain, user.msghandle, user.otpmsg.k, ws.getLanguageCodes(req));
    }
}

/** Check a code with MeshCentral's own second-factor logic. */
function checkCode(core, req, domain, user, code) {
    return new Promise(function (resolve) {
        try { core.hooks.checkUserOneTimePassword(req, domain, user, code, null, function (ok) { resolve(ok === true); }); }
        catch (ex) { resolve(false); }
    });
}

function validateCodeBody(body) {
    if ((body.method !== undefined) && (SECOND_FACTOR_METHODS.indexOf(body.method) < 0)) throw new ApiError(400, 'invalid_request', 'Invalid method', { field: 'method' });
    if ((body.send !== undefined) && (typeof body.send != 'boolean')) throw new ApiError(400, 'invalid_request', 'Invalid send', { field: 'send' });
    if ((body.code !== undefined) && ((typeof body.code != 'string') || (body.code.length < 4) || (body.code.length > 64))) throw new ApiError(400, 'invalid_request', 'Invalid code', { field: 'code' });
    if ((body.send === true) && (body.code !== undefined)) throw new ApiError(400, 'invalid_request', 'Send a code or check one, not both', { field: 'code' });
}

/**
 * Shared step-2 logic for pending logins and pending re-authentications.
 * Resolves to 'sent' or 'ok'. Throws for every refusal.
 */
async function secondFactorStep(core, req, res, p, body, mcUser, onDiscard) {
    const domain = req.xdomain;
    if (body.send === true) {
        if ((body.method === undefined) || (SEND_METHODS.indexOf(body.method) < 0) || (p.methods.indexOf(body.method) < 0)) throw new ApiError(400, 'invalid_request', 'This method cannot send a code', { field: 'method' });
        const wait = core.pending.trySend(p);
        if (wait > 0) throw new ApiError(429, 'rate_limited', 'Too many codes sent', null, { 'Retry-After': String(wait) });
        sendCode(core, domain, mcUser, body.method, req);
        return 'sent';
    }
    if (body.code === undefined) throw new ApiError(400, 'invalid_request', 'Missing field', { field: 'code' });
    if ((body.method !== undefined) && (p.methods.indexOf(body.method) < 0)) throw new ApiError(400, 'invalid_request', 'Method not available for this user', { field: 'method' });
    const locked = core.pending.userLockedFor(p.userid);
    if (locked > 0) throw new ApiError(429, 'rate_limited', 'Too many wrong codes', null, { 'Retry-After': String(locked) });
    if (core.webserver.checkAllow2Fa(req) == false) throw new ApiError(429, 'rate_limited', 'Too many attempts from this address', null, { 'Retry-After': '60' });
    const formatOk = twofa.codeFormatOk(body.code, body.method, p.methods);
    const ok = formatOk && await checkCode(core, req, domain, mcUser, body.code);
    if (!ok) {
        if (!formatOk) { try { core.webserver.setbad2Fa(req); } catch (ex) { } } // MeshCentral's checker records the other failures itself
        const discarded = core.pending.wrongCode(p);
        if (discarded && onDiscard) onDiscard();
        core.audit.write({ domain: domain.id, action: 'outband.2fa', outcome: 'failed', user: p.userid, ip: req.clientIp });
        throw new ApiError(401, 'invalid_code', 'Wrong code');
    }
    core.pending.discard(p.id);
    return 'ok';
}

module.exports = function (core) {
    const ws = core.webserver, parent = core.parent;

    /** Create a new MeshCentral session with a new session id, and its record. */
    async function startSession(req, user, passwordTime, secondFactorTime) {
        const old = req.session;
        if (old && (typeof old.userid == 'string') && (typeof old.x == 'string')) { await core.sessions.revoke(old.userid, old.x, 'logout'); core.tickets.cancelCredential('ses:' + old.userid + '/' + old.x); }
        req.session = { userid: user._id, ip: req.clientIp };
        core.hooks.setSessionRandom(req); // creates the session record through the Outband hook
        if (typeof req.session.x != 'string') throw new Error('session id not set');
        core.sessions.onNewSession(user._id, req.session.x); // no-op when the hook already did it
        await core.sessions.markAuth(user._id, req.session.x, passwordTime, secondFactorTime);
        const mcUser = ws.users[user._id];
        if (mcUser) { mcUser.pastlogin = mcUser.login; mcUser.login = mcUser.access = Math.floor(Date.now() / 1000); ws.db.SetUser(mcUser); }
        const targets = ['*', 'server-users', user._id];
        if (user.groups) { for (const i in user.groups) { targets.push('server-users:' + i); } }
        try {
            parent.DispatchEvent(targets, ws, { etype: 'user', userid: user._id, username: user.name, account: ws.CloneSafeUser(mcUser || user), action: 'login', msgid: 107, msgArgs: [req.clientIp, 'Outband API', ''], msg: 'Account login from ' + req.clientIp + ', Outband API', domain: req.xdomain.id, ip: req.clientIp });
            parent.authLog('https', 'Accepted password for ' + logName(user.name) + ' from ' + req.clientIp + ' (Outband API)');
        } catch (ex) { }
        core.audit.write({ domain: req.xdomain.id, action: 'outband.login', outcome: 'success', user: user._id, userName: user.name, ip: req.clientIp });
    }

    /** Password step shared by login and reauth. Resolves to {user, mcUser} or throws REFUSED / 429. */
    async function passwordStep(req, username, password, auditAction) {
        const domain = req.xdomain;
        const blockingMode = (parent.config.settings.maxinvalidlogin && parent.config.settings.maxinvalidlogin.blocking) || 'iprange';
        if ((blockingMode !== 'username') && (ws.checkAllowLogin(req) === false)) throw new ApiError(429, 'rate_limited', 'Too many failed logins from this address', null, { 'Retry-After': '60' });
        // Unknown local user names share one bucket, so they cannot evict the counters of real accounts.
        const local = (domain.auth == null) || (domain.auth == '') || ((domain.auth != 'ldap') && (domain.auth != 'sspi'));
        const known = !local || (ws.users['user/' + domain.id + '/' + username.toLowerCase()] != null);
        const accountKey = domain.id + '/' + (known ? username.toLowerCase() : '\u0000unknown');
        const refuse = function (reason, userid) {
            core.audit.write({ domain: domain.id, action: auditAction, outcome: 'failed', reason: reason, user: userid || null, ip: req.clientIp });
            return REFUSED();
        };
        if (core.limits.account.lockedFor(accountKey) > 0) { await dummyHash(password); throw refuse('account_locked'); }
        if ((blockingMode === 'username') && (ws.checkAllowLogin(null, username) === false)) { await dummyHash(password); throw refuse('account_locked'); }
        if (username.startsWith('~t:')) { await dummyHash(password); core.limits.account.fail(accountKey); throw refuse('login_token'); }
        const r = await checkPassword(core, username, password, domain);
        if ((r.userid == null) || r.err) {
            core.limits.account.fail(accountKey);
            try { ws.setbadLogin(req, username); } catch (ex) { }
            try { parent.authLog('https', 'Failed password for ' + logName(username) + ' from ' + req.clientIp + ' (Outband API)'); } catch (ex) { }
            throw refuse((r.err == 'locked') ? 'locked' : 'bad_password');
        }
        if ((r.loginOptions != null) && (r.loginOptions.tokenName != null)) throw refuse('login_token', r.userid);
        const user = await loadUser(ws, r.userid);
        const mcUser = ws.users[r.userid];
        if (userBlocked(user) || (mcUser == null)) throw refuse('locked', r.userid);
        core.notBefore.observe(user); // a credential change is recorded before any new session is created
        return { user: user, mcUser: mcUser, accountKey: accountKey, refuse: refuse };
    }

    // GET /api/v1/session
    async function getSession(req, res, ctx) {
        const domain = req.xdomain;
        if (ctx != null) {
            res.json({
                authenticated: true, user: userView(ctx.user, ctx.seesOwnIdentity()), auth_method: ctx.isCookie ? 'cookie' : 'token',
                scopes: ctx.scopes.slice(), server: { name: serverName(domain), version: parent.currentVer || '' }, twofa: { required: false }
            });
            return;
        }
        const obp = req.session && req.session.obp;
        const p = (obp && (typeof obp.i == 'string') && (obp.i.indexOf(':') < 0)) ? core.pending.get(obp.i) : null;
        const tf = (p != null && p.domainid == domain.id) ? { required: true, methods: p.methods.slice(), expires_at: iso(p.exp) } : { required: false };
        res.json({ authenticated: false, user: null, auth_method: null, scopes: [], server: { name: serverName(domain) }, twofa: tf });
    }

    // POST /api/v1/auth/login
    async function login(req, res) {
        const body = req.body;
        checkFields(body, ['username', 'password'], ['username', 'password']);
        if ((typeof body.username != 'string') || (body.username.length < 1) || (body.username.length > 256)) throw new ApiError(400, 'invalid_request', 'Invalid username', { field: 'username' });
        if ((typeof body.password != 'string') || (body.password.length < 1) || (body.password.length > 1024)) throw new ApiError(400, 'invalid_request', 'Invalid password', { field: 'password' });
        const domain = req.xdomain;
        const step = await passwordStep(req, body.username, body.password, 'outband.login');
        const passwordTime = Date.now();
        const blocked = loginBlockedByPolicy(core, domain, step.mcUser, req);
        if (blocked) throw step.refuse(blocked, step.user._id);
        const plan = secondFactorPlan(core, domain, step.mcUser, req);
        if (plan && plan.refuse) throw step.refuse(plan.refuse, step.user._id);
        core.limits.account.reset(step.accountKey);
        if (plan) {
            const old = req.session;
            if (old && (typeof old.userid == 'string') && (typeof old.x == 'string')) { await core.sessions.revoke(old.userid, old.x, 'logout'); }
            const p = core.pending.create(step.user._id, domain.id, passwordTime, plan.methods);
            req.session = { obp: { i: p.id, e: p.exp } };
            res.json({ authenticated: false, twofa: { required: true, methods: plan.methods.slice(), expires_at: iso(p.exp) } });
            return;
        }
        await startSession(req, step.user, passwordTime, null);
        res.json({ authenticated: true, user: userView(step.user, true) });
    }

    // POST /api/v1/auth/2fa
    async function secondFactor(req, res) {
        const body = req.body;
        checkFields(body, ['code', 'method', 'send'], []);
        validateCodeBody(body);
        const domain = req.xdomain;
        const obp = req.session && req.session.obp;
        const p = (obp && (typeof obp.i == 'string') && (obp.i.indexOf(':') < 0)) ? core.pending.get(obp.i) : null;
        if ((p == null) || (p.domainid != domain.id)) throw new ApiError(401, 'no_pending_login', 'No pending login');
        const user = await loadUser(ws, p.userid);
        const mcUser = ws.users[p.userid];
        if (userBlocked(user) || (mcUser == null)) { core.pending.discard(p.id); req.session = null; throw new ApiError(401, 'no_pending_login', 'No pending login'); }
        const r = await secondFactorStep(core, req, res, p, body, mcUser, function () { req.session = null; });
        if (r == 'sent') { res.status(202).end(); return; }
        // Re-check what may have changed since the password step.
        const fresh = await loadUser(ws, p.userid);
        if (userBlocked(fresh) || (core.notBefore.observe(fresh) > p.passwordTime) || loginBlockedByPolicy(core, domain, ws.users[p.userid] || fresh, req)) {
            req.session = null;
            core.audit.write({ domain: domain.id, action: 'outband.2fa', outcome: 'denied', reason: 'recheck', user: p.userid, ip: req.clientIp });
            throw new ApiError(401, 'no_pending_login', 'No pending login');
        }
        core.audit.write({ domain: domain.id, action: 'outband.2fa', outcome: 'success', user: user._id, userName: user.name, ip: req.clientIp });
        await startSession(req, user, p.passwordTime, Date.now());
        res.json({ authenticated: true, user: userView(user, true) });
    }

    // POST /api/v1/auth/reauth
    async function reauth(req, res, ctx) {
        const body = req.body;
        checkFields(body, ['password', 'code', 'method', 'send'], []);
        if (body.password !== undefined) {
            for (const f of ['code', 'method', 'send']) { if (body[f] !== undefined) throw new ApiError(400, 'invalid_request', 'Password and second factor go in separate requests', { field: f }); }
            if ((typeof body.password != 'string') || (body.password.length < 1) || (body.password.length > 1024)) throw new ApiError(400, 'invalid_request', 'Invalid password', { field: 'password' });
        } else {
            validateCodeBody(body);
            if ((body.code === undefined) && (body.send !== true)) throw new ApiError(400, 'invalid_request', 'Missing field', { field: 'password' });
        }
        const domain = req.xdomain;
        const sessionKey = ctx.userid + '/' + ctx.session.x;
        if (body.password !== undefined) {
            const loginName = (domain.auth == 'ldap') ? ctx.user.name : lastSegment(ctx.userid);
            const step = await passwordStep(req, loginName, body.password, 'outband.reauth');
            if (step.user._id != ctx.userid) throw step.refuse('bad_password', ctx.userid);
            core.limits.account.reset(step.accountKey);
            const now = Date.now();
            await core.sessions.markAuth(ctx.userid, ctx.session.x, now, null);
            const enrolled = core.hooks.userHasSecondFactor(domain, step.mcUser);
            if (!enrolled) { core.audit.write({ domain: domain.id, action: 'outband.reauth', outcome: 'success', user: ctx.userid, userName: ctx.user.name, ip: ctx.ip }); res.status(204).end(); return; }
            const methods = twofa.available(core, domain) ? twofa.userMethods(core, domain, step.mcUser) : [];
            if (methods.length == 0) throw step.refuse('second_factor_unsupported', ctx.userid);
            const p = core.pending.createReauth(sessionKey, ctx.userid, domain.id, now, methods);
            res.status(200).json({ twofa: { required: true, methods: methods.slice(), expires_at: iso(p.exp) } });
            return;
        }
        const p = core.pending.getReauth(sessionKey);
        if (p == null) throw new ApiError(401, 'reauth_required', 'Send the password first');
        const mcUser = ws.users[ctx.userid];
        if (mcUser == null) throw new ApiError(401, 'unauthenticated', 'Session ended');
        const r = await secondFactorStep(core, req, res, p, body, mcUser, null);
        if (r == 'sent') { res.status(202).end(); return; }
        await core.sessions.markAuth(ctx.userid, ctx.session.x, null, Date.now());
        core.audit.write({ domain: domain.id, action: 'outband.reauth', outcome: 'success', user: ctx.userid, userName: ctx.user.name, ip: ctx.ip });
        res.status(204).end();
    }

    // POST /api/v1/auth/logout
    async function logout(req, res) {
        const s = req.session;
        if (s && (typeof s.userid == 'string') && (typeof s.x == 'string')) {
            await core.sessions.revoke(s.userid, s.x, 'logout');
            core.tickets.cancelCredential('ses:' + s.userid + '/' + s.x);
            const user = ws.users[s.userid];
            if (user != null) {
                try { parent.DispatchEvent(['*'], ws, { etype: 'user', userid: user._id, username: user.name, action: 'logout', msgid: 2, msg: 'Account logout', domain: req.xdomain.id }); } catch (ex) { }
                core.audit.write({ domain: req.xdomain.id, action: 'outband.logout', outcome: 'success', user: user._id, userName: user.name, ip: req.clientIp });
            }
        }
        if (s && s.obp && (typeof s.obp.i == 'string') && (s.obp.i.indexOf(':') < 0)) { core.pending.discard(s.obp.i); }
        req.session = null;
        res.status(204).end();
    }

    return { getSession, login, secondFactor, reauth, logout, serverName, userView };
};
