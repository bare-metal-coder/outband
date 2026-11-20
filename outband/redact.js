/**
 * @description Outband API: log redaction.
 *
 * Request and debug logs never carry secrets. Redacted always:
 *   headers  Authorization, Cookie, Set-Cookie, Sec-WebSocket-Protocol
 *   query    ticket, token, access_token (and MeshCentral's auth cookie parameter)
 * Request bodies are never logged by Outband. `installDebugRedaction` wraps
 * MeshCentral's debug logger so every debug source is redacted the same way,
 * including rejected requests.
 * @license Apache-2.0
 */

'use strict';

const REDACTED = '[redacted]';
const SECRET_HEADERS = ['authorization', 'cookie', 'set-cookie', 'sec-websocket-protocol', 'proxy-authorization'];
const SECRET_PARAMS = ['ticket', 'token', 'access_token', 'auth'];
const PARAM_RE = new RegExp('([?&;](?:' + SECRET_PARAMS.join('|') + ')=)[^&#\\s"\']*', 'gi');
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+\/=-]+/gi;
const SECRET_RE = /\bobt_[A-Za-z0-9_-]{20,}/g;
const TICKET_RE = /\b(outband\.ticket\.)[A-Za-z0-9_-]+/g;

function redactString(s) {
    if (typeof s != 'string') return s;
    return s.replace(PARAM_RE, '$1' + REDACTED).replace(BEARER_RE, '$1' + REDACTED).replace(SECRET_RE, 'obt_' + REDACTED).replace(TICKET_RE, '$1' + REDACTED);
}

function redactUrl(url) { return redactString(url); }

function redactHeaders(headers) {
    if ((headers == null) || (typeof headers != 'object')) return headers;
    const out = {};
    for (const k of Object.keys(headers)) {
        out[k] = (SECRET_HEADERS.indexOf(k.toLowerCase()) >= 0) ? REDACTED : redactString(headers[k]);
    }
    return out;
}

function looksLikeHeaders(o) {
    if ((o == null) || (typeof o != 'object') || Array.isArray(o)) return false;
    for (const k of Object.keys(o)) { if (SECRET_HEADERS.indexOf(k.toLowerCase()) >= 0 || k.toLowerCase() == 'host' || k.toLowerCase() == 'user-agent') return true; }
    return false;
}

/** Redact one value handed to a logger. */
function redactValue(v, depth) {
    if (typeof v == 'string') return redactString(v);
    if ((v == null) || (typeof v != 'object') || ((depth || 0) > 3)) return v;
    if (looksLikeHeaders(v)) return redactHeaders(v);
    if (Array.isArray(v)) return v.map(function (x) { return redactValue(x, (depth || 0) + 1); });
    if (Buffer.isBuffer(v) || (v instanceof Error)) return v;
    const out = {};
    for (const k of Object.keys(v)) {
        out[k] = (SECRET_HEADERS.indexOf(k.toLowerCase()) >= 0 || SECRET_PARAMS.indexOf(k.toLowerCase()) >= 0 || k.toLowerCase() == 'password' || k.toLowerCase() == 'secret' || k.toLowerCase() == 'code') ? REDACTED : redactValue(v[k], (depth || 0) + 1);
    }
    return out;
}

/** Wrap parent.debug (MeshCentral's debug logger) so every argument is redacted. */
function installDebugRedaction(parent) {
    if ((parent == null) || (typeof parent.debug != 'function') || parent.debug.outbandRedacted) return;
    const original = parent.debug;
    const wrapped = function (source, ...args) {
        // Fast path: nothing is listening, so nothing would be written.
        if ((parent.debugSources == null) && (parent.debugRemoteSources == null) && !(parent.config && parent.config.settings && parent.config.settings.log)) return;
        return original.call(parent, source, ...args.map(function (a) { return redactValue(a, 0); }));
    };
    wrapped.outbandRedacted = true;
    parent.debug = wrapped;
}

module.exports = { redactString, redactUrl, redactHeaders, redactValue, installDebugRedaction, REDACTED };
