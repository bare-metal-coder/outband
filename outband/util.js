/**
 * @description Outband API: shared helpers (errors, ids, time, client address).
 * @license Apache-2.0
 */

'use strict';

const crypto = require('crypto');
const net = require('net');

const API_VERSION = '1.0.0-draft.7';
const OUTBAND_VERSION = '0.1.0';
const FULL_RIGHTS = 0xFFFFFFFF;
const SITE_LOCKED = 0x20;

/** Random URL-safe id with a prefix, e.g. randomId('tok_', 16). */
function randomId(prefix, bytes) {
    return prefix + crypto.randomBytes(bytes || 12).toString('base64url');
}

function iso(ms) { return (ms == null) ? null : new Date(ms).toISOString(); }

/** Send a spec-shaped error: {"error": {code, message, details?, request_id}}. */
function sendError(res, status, code, message, details, headers) {
    if (res.headersSent) { try { res.end(); } catch (ex) { } return; }
    const body = { error: { code: code, message: message } };
    if ((details != null) && (Object.keys(details).length > 0)) { body.error.details = details; }
    if (res.locals && res.locals.outbandRequestId) { body.error.request_id = res.locals.outbandRequestId; }
    if (headers) { res.set(headers); }
    if (status == 401) { res.set('WWW-Authenticate', 'Bearer realm="outband"'); }
    res.status(status).json(body);
}

/** An error a handler can throw; the router turns it into a JSON error response. */
class ApiError extends Error {
    constructor(status, code, message, details, headers) {
        super(message);
        this.status = status; this.code = code; this.details = details; this.headers = headers;
    }
}

/** Constant-time comparison of two strings of any length. */
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb) && (String(a).length == String(b).length);
}

function sha256Hex(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

/** Last segment of a MeshCentral id (`kind/domain/value`). */
function lastSegment(id) { if (typeof id != 'string') return null; const i = id.indexOf('/', id.indexOf('/') + 1); return (i < 0) ? id : id.substring(i + 1); }

/** True when `ip` is inside `cidr` (IPv4 or IPv6). */
function ipInCidr(ip, cidr) {
    try {
        const parts = String(cidr).split('/');
        const base = parts[0];
        const kind = net.isIP(base);
        if (kind == 0) return false;
        const bits = (parts.length > 1) ? parseInt(parts[1], 10) : ((kind == 4) ? 32 : 128);
        const bl = new net.BlockList();
        bl.addSubnet(base, bits, (kind == 4) ? 'ipv4' : 'ipv6');
        let addr = String(ip);
        if (addr.startsWith('::ffff:') && net.isIPv4(addr.substring(7))) { addr = addr.substring(7); }
        const ak = net.isIP(addr);
        if (ak == 0) return false;
        return bl.check(addr, (ak == 4) ? 'ipv4' : 'ipv6');
    } catch (ex) { return false; }
}

/** Validate an IPv4/IPv6 CIDR (or a bare address). */
function isValidCidr(cidr) {
    if ((typeof cidr != 'string') || (cidr.length > 64)) return false;
    const parts = cidr.split('/');
    if (parts.length > 2) return false;
    const kind = net.isIP(parts[0]);
    if (kind == 0) return false;
    if (parts.length == 1) return true;
    if (!/^\d{1,3}$/.test(parts[1])) return false;
    const bits = parseInt(parts[1], 10);
    return (bits >= 0) && (bits <= ((kind == 4) ? 32 : 128));
}

/** Truncate an address for erasure: IPv4 to /24, IPv6 to /48. */
function truncateIp(ip) {
    if (typeof ip != 'string') return null;
    let addr = ip.startsWith('::ffff:') ? ip.substring(7) : ip;
    if (net.isIPv4(addr)) { const p = addr.split('.'); return p[0] + '.' + p[1] + '.' + p[2] + '.0/24'; }
    if (net.isIPv6(addr)) {
        // Expand, keep the first 3 groups (48 bits)
        const sides = addr.split('::');
        const left = sides[0] ? sides[0].split(':') : [];
        const right = (sides.length > 1 && sides[1]) ? sides[1].split(':') : [];
        const fill = new Array(Math.max(0, 8 - left.length - right.length)).fill('0');
        const full = (sides.length > 1) ? left.concat(fill, right) : left;
        return full.slice(0, 3).map(function (g) { return parseInt(g || '0', 16).toString(16); }).join(':') + '::/48';
    }
    return null;
}

/**
 * Whether the TCP peer is a configured trusted proxy or TLS offloader, so
 * its X-Forwarded-Host and X-Forwarded-Proto headers may be used. Only an
 * explicit address list counts (`trustedProxy` / `tlsOffload` set to
 * addresses or CIDRs); `true` ("any peer") does not. The proxy must
 * overwrite these headers, not append to client-supplied ones; Outband
 * reads only the last hop.
 */
function fromTrustedProxy(args, req) {
    let peer = (req.socket && req.socket.remoteAddress) || '';
    if (peer.startsWith('::ffff:')) { peer = peer.substring(7); }
    const match = function (list) {
        if (typeof list == 'string') { list = list.split(','); }
        if (!Array.isArray(list)) return false;
        for (const c of list) { if (ipInCidr(peer, String(c).trim())) return true; }
        return false;
    };
    return match(args.trustedproxy) || match(args.tlsoffload);
}

/** The last (nearest) value of a comma-separated forwarding header. */
function lastHop(value) {
    if (typeof value != 'string') return null;
    const parts = value.split(',');
    const v = parts[parts.length - 1].trim();
    return (v.length > 0) ? v : null;
}

/** True when the request arrived over TLS, directly or through a trusted TLS offloader. */
function isSecureRequest(args, req) {
    if (req.socket && req.socket.encrypted) return true;
    return fromTrustedProxy(args, req) && (String(lastHop(req.headers['x-forwarded-proto']) || '').toLowerCase() == 'https');
}

/** Encode/decode opaque pagination cursors. */
function encodeCursor(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
function decodeCursor(s) {
    if (s == null) return null;
    if ((typeof s != 'string') || (s.length > 512)) throw new ApiError(400, 'invalid_request', 'Invalid cursor', { field: 'cursor' });
    try { const o = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); if ((o == null) || (typeof o != 'object')) throw 0; return o; }
    catch (ex) { throw new ApiError(400, 'invalid_request', 'Invalid cursor', { field: 'cursor' }); }
}

/** Parse the standard `limit` query parameter. */
function parseLimit(q) {
    if (q.limit == null) return 50;
    if ((typeof q.limit != 'string') || !/^\d{1,3}$/.test(q.limit)) throw new ApiError(400, 'invalid_request', 'Invalid limit', { field: 'limit' });
    const n = parseInt(q.limit, 10);
    if ((n < 1) || (n > 200)) throw new ApiError(400, 'invalid_request', 'Invalid limit', { field: 'limit' });
    return n;
}

module.exports = {
    API_VERSION, OUTBAND_VERSION, FULL_RIGHTS, SITE_LOCKED,
    randomId, iso, sendError, ApiError, safeEqual, sha256Hex, lastSegment,
    ipInCidr, isValidCidr, truncateIp, fromTrustedProxy, lastHop, isSecureRequest,
    encodeCursor, decodeCursor, parseLimit
};
