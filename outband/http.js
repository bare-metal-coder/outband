/**
 * @description Outband API: HTTP plumbing shared by every route
 * (base headers, JSON bodies, the route wrapper with auth, CSRF and rate limits).
 * @license Apache-2.0
 */

'use strict';

const express = require('express');
const { ApiError, sendError, randomId, API_VERSION } = require('./util');
const { resolveCredential } = require('./auth');
const { checkOrigin } = require('./hostorigin');

const jsonParser = express.json({ limit: '64kb', strict: true, type: function () { return true; } });

/** Every response: version, request id, no caching. */
function baseHeaders(req, res, next) {
    const id = randomId('req_', 12);
    res.locals.outbandRequestId = id;
    res.set({ 'Outband-API-Version': API_VERSION, 'Outband-Request-Id': id, 'Cache-Control': 'no-store' });
    next();
}

function hasBody(req) {
    const len = req.headers['content-length'];
    if ((len != null) && (len !== '0')) return true;
    return (req.headers['transfer-encoding'] != null);
}

/** Parse a JSON body. Non-JSON bodies get 415; malformed JSON gets 400. */
function parseJson(req, res) {
    return new Promise(function (resolve, reject) {
        if (!hasBody(req)) { req.body = undefined; resolve(); return; }
        const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (ct != 'application/json') { reject(new ApiError(415, 'unsupported_media_type', 'Request bodies must be application/json')); return; }
        jsonParser(req, res, function (err) {
            if (err) { reject(new ApiError((err.status == 413) ? 413 : 400, 'invalid_request', (err.status == 413) ? 'Request body too large' : 'Malformed JSON body')); return; }
            resolve();
        });
    });
}

/** Check a request body against a simple field spec; unknown fields are refused. */
function checkFields(body, allowed, required) {
    if ((body == null) || (typeof body != 'object') || Array.isArray(body)) throw new ApiError(400, 'invalid_request', 'A JSON object body is required');
    for (const k of Object.keys(body)) { if (allowed.indexOf(k) < 0) throw new ApiError(400, 'invalid_request', 'Unknown field', { field: k }); }
    for (const k of (required || [])) { if (body[k] === undefined) throw new ApiError(400, 'invalid_request', 'Missing field', { field: k }); }
}

function csrfOk(core, req) {
    return (req.headers['x-outband'] === '1') && checkOrigin(req, req.xdomain, core.webserver.certificates, core.webserver.args);
}

/**
 * Wrap a handler.
 * @param {object} core
 * @param {object} opts
 *   auth: 'required' | 'optional' | 'none'
 *   csrf: 'always' (auth endpoints) | default (cookie non-GET)
 *   session: true for browser-session-only endpoints
 *   admin: true for full-site-admin endpoints
 *   rateLimit: false for the auth endpoints (no RateLimit-* headers)
 * @param {function(req, res, ctx): Promise<void>} handler
 */
function route(core, opts, handler) {
    return async function (req, res) {
        try {
            const unsafe = (req.method != 'GET') && (req.method != 'HEAD');
            if ((opts.csrf == 'always') && !csrfOk(core, req)) {
                core.audit.deny(null, { domain: req.xdomain.id, action: 'outband.csrf', reason: 'csrf_failed', ip: req.clientIp });
                throw new ApiError(403, 'csrf_failed', 'Missing X-Outband header or Origin mismatch');
            }
            let ctx = null;
            if (opts.auth != 'none') {
                try { ctx = await resolveCredential(core, req); }
                catch (ex) { if ((opts.auth == 'optional') && (ex instanceof ApiError) && (ex.status != 429)) { ctx = null; } else throw ex; }
                if ((ctx == null) && (opts.auth == 'required')) throw new ApiError(401, 'unauthenticated', 'Authentication required');
            }
            if ((ctx != null) && ctx.isCookie && unsafe && (opts.csrf != 'always') && !csrfOk(core, req)) {
                core.audit.deny(ctx.credentialKey, { domain: ctx.domain.id, action: 'outband.csrf', reason: 'csrf_failed', user: ctx.userid, ip: ctx.ip });
                throw new ApiError(403, 'csrf_failed', 'Missing X-Outband header or Origin mismatch');
            }
            if ((ctx != null) && (opts.rateLimit !== false)) {
                const r = core.limits.perCredential.hit(ctx.credentialKey);
                res.set({ 'RateLimit-Limit': String(r.limit), 'RateLimit-Remaining': String(r.remaining), 'RateLimit-Reset': String(r.resetSec) });
                if (!r.allowed) throw new ApiError(429, 'rate_limited', 'Too many requests', null, { 'Retry-After': String(r.resetSec) });
            }
            if (opts.session && (ctx != null)) ctx.requireSession();
            if (opts.admin && (ctx != null)) ctx.requireFullAdmin();
            if (unsafe) { await parseJson(req, res); }
            await handler(req, res, ctx);
        } catch (ex) {
            if (ex instanceof ApiError) { sendError(res, ex.status, ex.code, ex.message, ex.details, ex.headers); return; }
            try { core.parent.debug('web', 'Outband API error: ' + (ex && ex.message)); } catch (e2) { }
            sendError(res, 500, 'internal', 'Internal error');
        }
    };
}

module.exports = { baseHeaders, parseJson, checkFields, csrfOk, route, hasBody };
