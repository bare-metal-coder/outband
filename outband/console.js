/**
 * @description Outband API: the text console relay (Serial-over-LAN first).
 *
 * The ticket, Origin and credential checks at the WebSocket upgrade are done
 * by the router (outband/router.js). This module:
 *   - decides whether a console may be opened (`target`): visibility (404),
 *     scope `console` (403), MeshCentral rights for the kind (403),
 *     reachability (409 not_reachable), one SOL session per device
 *     (409 busy);
 *   - relays an opened console (`open`): the server opens Intel AMT
 *     redirection itself, with the AMT credentials MeshCentral holds, over
 *     MeshCentral's CIRA connection or the local network. The client only
 *     ever sees terminal bytes; the credentials never leave the server.
 *
 * Frames: binary frames carry terminal bytes both ways; text frames carry
 * JSON control messages (`{"type":"state",...}` from the server,
 * `{"type":"resize",...}` from the client, ignored for SOL).
 *
 * Every open console is re-checked at least every 5 seconds (credential,
 * rights, reachability) and at once on the revocation events of
 * `core.bus`. Close codes: 4403 credential ended or rights lost, 4409 not
 * reachable or busy, 1009 frame too large, 1008 a client that does not
 * read, 1000 idle or ended, 1011 server error.
 * @license Apache-2.0
 */

'use strict';

const EventEmitter = require('events');
const crypto = require('crypto');
const { ApiError } = require('./util');
const { solAllowed, solReachable, CONN } = require('./mappers');

const DEFAULTS = {
    revalidateMs: 2500,                 // credential and rights re-check (at most 5 s to close)
    checkTimeoutMs: 4000,               // a re-check that does not answer closes the console
    idleMs: 15 * 60000,                 // no data either way
    connectTimeoutMs: 30000,            // AMT redirection must be open by then
    maxFrame: 16384,                    // largest frame accepted from the client
    maxClientBuffered: 1 << 20,         // bytes queued towards a client that does not read
    maxDeviceBuffered: 1 << 20          // bytes queued towards the device
};

// ---- Intel AMT redirection (SOL) --------------------------------------------

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xFFFF, 0); return b; }
function lstr(s) { const b = Buffer.from(String(s), 'utf8'); return Buffer.concat([Buffer.from([b.length & 0xFF]), b]); }
function md5hex(s) { return crypto.createHash('md5').update(s, 'utf8').digest('hex'); }

/** A removed device's pin is kept this long, so a device re-added with the same id is checked against it. */
const PIN_TOMBSTONE_MS = 30 * 86400000;

const START_SOL = Buffer.from([0x10, 0x00, 0x00, 0x00, 0x53, 0x4F, 0x4C, 0x20]);
const AUTH_URI = '/RedirectionService';

/**
 * The client side of the Intel AMT redirection protocol, SOL only, over a
 * transport ({write(Buffer), close()} emitting 'open', 'data', 'close').
 * Emits 'open' when the serial session is established, 'data' (terminal
 * bytes from the device) and 'close'.
 */
class SolClient extends EventEmitter {
    constructor(transport, user, pass) {
        super();
        this.t = transport; this.user = user; this.pass = pass;
        this.acc = Buffer.alloc(0); this.seq = 1; this.state = 0; this.keepAlive = null; this.closed = false;
        const self = this;
        transport.on('open', function () { self.send(START_SOL); });
        transport.on('data', function (d) { self.onData(d); });
        transport.on('close', function () { self.close(); });
    }

    send(b) { if (!this.closed) this.t.write(b); }

    /** Terminal bytes to the device. */
    write(data) {
        if (this.state != 1) return;
        for (let i = 0; i < data.length; i += 4096) {
            const part = data.subarray(i, Math.min(data.length, i + 4096));
            this.send(Buffer.concat([Buffer.from([0x28, 0, 0, 0]), u32(this.seq++), u16(part.length), part]));
        }
    }

    onData(d) {
        if (this.closed) return;
        this.acc = (this.acc.length == 0) ? Buffer.from(d) : Buffer.concat([this.acc, d]);
        if (this.acc.length > (1 << 20)) { this.close(); return; }
        while (this.acc.length > 0 && !this.closed) {
            const a = this.acc;
            let size = 0;
            switch (a[0]) {
                case 0x11: { // StartRedirectionSessionReply
                    if (a.length < 4) return;
                    if (a[1] != 0) { this.close(); return; }
                    if (a.length < 13) return;
                    const oem = a[12];
                    if (a.length < 13 + oem) return;
                    this.send(Buffer.from([0x13, 0, 0, 0, 0, 0, 0, 0, 0])); // query the authentication methods
                    size = 13 + oem;
                    break;
                }
                case 0x14: { // AuthenticateSessionReply
                    if (a.length < 9) return;
                    const len = a.readUInt32LE(5);
                    if (a.length < 9 + len) return;
                    const status = a[1], type = a[4], data = a.subarray(9, 9 + len);
                    size = 9 + len;
                    if (type == 0) {
                        if (data.indexOf(4) < 0) { this.close(); return; } // digest with cnonce only
                        const body = Buffer.concat([lstr(this.user), Buffer.from([0, 0]), lstr(AUTH_URI), Buffer.from([0, 0, 0, 0])]);
                        this.send(Buffer.concat([Buffer.from([0x13, 0, 0, 0, 4]), u32(body.length), body]));
                    } else if (((type == 3) || (type == 4)) && (status == 1)) {
                        let p = 0;
                        const field = function () { const l = data[p]; const v = data.subarray(p + 1, p + 1 + l).toString('binary'); p += l + 1; return v; };
                        const realm = field(), nonce = field();
                        const qop = (type == 4) ? field() : null;
                        const cnonce = crypto.randomBytes(16).toString('hex'), nc = '00000002';
                        const extra = (type == 4) ? (nc + ':' + cnonce + ':' + qop + ':') : '';
                        const digest = md5hex(md5hex(this.user + ':' + realm + ':' + this.pass) + ':' + nonce + ':' + extra + md5hex('POST:' + AUTH_URI));
                        const parts = [lstr(this.user), Buffer.concat([Buffer.from([realm.length]), Buffer.from(realm, 'binary')]), Buffer.concat([Buffer.from([nonce.length]), Buffer.from(nonce, 'binary')]), lstr(AUTH_URI), lstr(cnonce), lstr(nc), lstr(digest)];
                        if (type == 4) parts.push(Buffer.concat([Buffer.from([qop.length]), Buffer.from(qop, 'binary')]));
                        const body = Buffer.concat(parts);
                        this.send(Buffer.concat([Buffer.from([0x13, 0, 0, 0, type]), u32(body.length), body]));
                    } else if (status == 0) {
                        // Authenticated: SOL settings (MaxTxBuffer 10000, TxTimeout 100, TxOverflowTimeout 0, RxTimeout 10000, RxFlushTimeout 100, Heartbeat 0)
                        this.send(Buffer.concat([Buffer.from([0x20, 0, 0, 0]), u32(this.seq++), u16(10000), u16(100), u16(0), u16(10000), u16(100), u16(0), u32(0)]));
                    } else { this.close(); return; }
                    break;
                }
                case 0x21: // settings accepted
                    if (a.length < 23) return;
                    size = 23;
                    this.send(Buffer.concat([Buffer.from([0x27, 0, 0, 0]), u32(this.seq++), Buffer.from([0, 0, 0x1B, 0, 0, 0])]));
                    if (this.state == 0) {
                        this.state = 1;
                        const self = this;
                        this.keepAlive = setInterval(function () { self.send(Buffer.concat([Buffer.from([0x2B, 0, 0, 0]), u32(self.seq++)])); }, 2000);
                        if (this.keepAlive.unref) this.keepAlive.unref();
                        this.emit('open');
                    }
                    break;
                case 0x29: // serial settings
                    if (a.length < 10) return;
                    size = 10;
                    break;
                case 0x2A: { // terminal data from the device
                    if (a.length < 10) return;
                    const cs = 10 + a.readUInt16LE(8);
                    if (a.length < cs) return;
                    if (this.state == 1) this.emit('data', Buffer.from(a.subarray(10, cs)));
                    size = cs;
                    break;
                }
                case 0x2B: // keep-alive
                    if (a.length < 8) return;
                    size = 8;
                    break;
                default:
                    this.close();
                    return;
            }
            this.acc = this.acc.subarray(size);
        }
    }

    close() {
        if (this.closed) return;
        this.closed = true; this.state = -1;
        if (this.keepAlive) { clearInterval(this.keepAlive); this.keepAlive = null; }
        try { this.t.close(); } catch (ex) { }
        this.emit('close');
    }
}

// ---- transports ---------------------------------------------------------------

/** True when a certificate matches a stored hash (SHA-1 fingerprint, SHA-256 or SHA-384 of the DER bytes). */
function certMatches(cert, hash) {
    if ((typeof hash != 'string') || (hash.length == 0)) return false;
    if ((cert == null) || (cert.raw == null)) return false;
    hash = hash.toLowerCase();
    if (typeof cert.fingerprint == 'string' && cert.fingerprint.split(':').join('').toLowerCase() == hash) return true;
    if ((hash.length == 64) && (crypto.createHash('sha256').update(cert.raw).digest('hex') == hash)) return true;
    if ((hash.length == 96) && (crypto.createHash('sha384').update(cert.raw).digest('hex') == hash)) return true;
    return false;
}

/**
 * TLS options for Intel AMT, by mode. AMT presents a self-signed firmware
 * certificate that cannot be validated against a CA, so chain validation is off;
 * the peer certificate is pinned instead (see `verify` in createConsole: pinned on
 * first use in Outband's own store and enforced on every connection).
 *   modern  TLS 1.2 or later, no legacy renegotiation (the default);
 *   legacy  TLS 1.0 or later, the RSA/AES suites older AMT firmware offers, and
 *           legacy renegotiation. Used only for a device whose modern handshake
 *           failed (auto-detected, recorded with its pin). Node does not verify the
 *           peer certificate again on renegotiation, so in this mode the pin, checked
 *           at the handshake, is the only protection against a renegotiation to
 *           another peer.
 */
function amtTlsOptions(mode) {
    if (mode !== 'legacy') return { minVersion: 'TLSv1.2', rejectUnauthorized: false };
    const constants = require('constants');
    return { ciphers: 'RSA+AES:!aNULL:!MD5:!DSS:@SECLEVEL=0', minVersion: 'TLSv1', secureOptions: constants.SSL_OP_NO_SSLv2 | constants.SSL_OP_NO_SSLv3 | constants.SSL_OP_NO_COMPRESSION | constants.SSL_OP_CIPHER_SERVER_PREFERENCE | constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION, rejectUnauthorized: false };
}

/**
 * Wrap a socket-like stream into the transport interface. For TLS
 * (`openEvent` 'secureConnect'), `verify(cert)` must resolve to true before
 * anything is sent; otherwise the transport closes with `t.failure` set.
 */
function socketTransport(sock, openEvent, verify) {
    const t = new EventEmitter();
    let closed = false;
    t.failure = null;
    t.tls = (openEvent == 'secureConnect'); t.handshook = false; t.reached = false;
    const end = function () { if (closed) return; closed = true; try { sock.destroy(); } catch (ex) { } t.emit('close'); };
    sock.on('connect', function () { t.reached = true; });
    sock.on(openEvent, function () {
        if (openEvent != 'secureConnect') { t.emit('open'); return; }
        t.handshook = true;
        if (typeof verify != 'function') { t.failure = 'cert_changed'; end(); return; }
        let cert = null;
        try { cert = sock.getPeerCertificate(); } catch (ex) { cert = null; }
        Promise.resolve(verify(cert)).then(function (ok) {
            if (closed) return;
            if (ok === true) t.emit('open'); else { t.failure = 'cert_changed'; end(); }
        }, function () { t.failure = 'error'; end(); });
    });
    sock.on('data', function (d) { if (!closed) t.emit('data', Buffer.isBuffer(d) ? d : Buffer.from(d, 'binary')); });
    sock.on('close', end);
    sock.on('error', end);
    t.write = function (b) { if (!closed) { try { sock.write(b); } catch (ex) { end(); } } };
    t.close = end;
    t.pending = function () { return sock.writableLength || 0; };
    return t;
}

/** Bytes waiting in a CIRA channel for credits from the device. */
function channelBacklog(chnl) { return (chnl && chnl.sendBuffer) ? chnl.sendBuffer.length : 0; }

/**
 * A CIRA channel (from MeshCentral's MPS server) as a transport, with TLS when
 * the device requires it. MeshCentral's channel buffers without limit while the
 * device grants no credits, so writes are held until the channel reports the
 * buffer sent (`onSendOk`), and `pending()` counts the channel's buffer too.
 */
function ciraTransport(mps, ciraconn, verify, mode) {
    const plain = (ciraconn.tag.boundPorts.indexOf(16994) >= 0);
    const chnl = mps.SetupChannel(ciraconn, plain ? 16994 : 16995);
    if (plain) {
        const t = new EventEmitter();
        let closed = false;
        const end = function () { if (closed) return; closed = true; try { chnl.close(); } catch (ex) { } t.emit('close'); };
        chnl.onStateChange = function (c, state) { if (state == 2) t.emit('open'); else if (state == 0) end(); };
        chnl.onData = function (c, data) { if (!closed) t.emit('data', Buffer.isBuffer(data) ? data : Buffer.from(data, 'binary')); };
        chnl.onSendOk = function () { };
        t.write = function (b) { if (!closed) chnl.write(b); };
        t.close = end;
        t.pending = function () { return channelBacklog(chnl); };
        return t;
    }
    const { Duplex } = require('stream');
    let held = null; // the write callback waiting for the channel to drain
    const release = function () { if (held) { const cb = held; held = null; cb(); } };
    const tunnel = new Duplex({
        read: function () { },
        write: function (chunk, enc, cb) {
            chnl.write(chunk);
            if (channelBacklog(chnl) > 0) held = cb; else cb();
        }
    });
    chnl.onData = function (c, data) { tunnel.push(Buffer.isBuffer(data) ? data : Buffer.from(data, 'binary')); };
    chnl.onSendOk = release;
    const tlsock = require('tls').connect(Object.assign({ socket: tunnel }, amtTlsOptions(mode)));
    const t = socketTransport(tlsock, 'secureConnect', verify);
    chnl.onStateChange = function (c, state) { if (state == 2) t.reached = true; else if (state == 0) t.close(); };
    const close = t.close;
    t.close = function () { held = null; try { chnl.close(); } catch (ex) { } close(); };
    t.pending = function () { return (tlsock.writableLength || 0) + (tunnel.writableLength || 0) + channelBacklog(chnl); };
    return t;
}

/** MeshCentral's way to reach the device's AMT redirection port: CIRA first, then the local network. */
function defaultConnect(core, node, verify, mode) {
    const parent = core.parent;
    const mps = parent.mpsserver;
    const ciraconn = (mps != null) ? mps.GetConnectionToNode(node._id, null, true) : null;
    if (ciraconn != null) return ciraTransport(mps, ciraconn, verify, mode);
    const s = (typeof parent.GetConnectivityState == 'function') ? parent.GetConnectivityState(node._id) : null;
    if (s && ((s.connectivity & CONN.AMT) != 0) && (typeof node.host == 'string') && node.host) {
        if (node.intelamt.tls == 1) {
            const sock = require('tls').connect(Object.assign({ host: node.host, port: 16995 }, amtTlsOptions(mode)));
            return socketTransport(sock, 'secureConnect', verify);
        }
        // Without TLS on the device, the redirection port carries the digest exchange and the keystrokes in clear.
        const sock = require('net').connect({ host: node.host, port: 16994 });
        return socketTransport(sock, 'connect', null);
    }
    return null;
}

/**
 * A transport that falls back to the legacy TLS mode once, for a device whose
 * modern TLS handshake failed after the connection was reached. `t.mode` tells
 * which mode carried the session. A certificate that does not match the pin is
 * never retried.
 */
function fallbackTransport(first, make, mode) {
    const t = new EventEmitter();
    let inner = null, opened = false, closed = false;
    t.mode = mode; t.failure = null; t.tls = !!first.tls;
    const attach = function (x) {
        inner = x;
        x.on('open', function () { if (closed) return; opened = true; t.emit('open'); });
        x.on('data', function (d) { if (!closed) t.emit('data', d); });
        x.on('close', function () {
            if (closed || (inner !== x)) return;
            if (!opened && x.tls && x.reached && !x.handshook && (x.failure == null) && (t.mode == 'modern')) {
                let next = null;
                try { next = make('legacy'); } catch (ex) { next = null; }
                if (next != null) { t.mode = 'legacy'; attach(next); return; }
            }
            closed = true; t.failure = x.failure; t.emit('close');
        });
    };
    attach(first);
    t.write = function (b) { if (!closed) inner.write(b); };
    t.pending = function () { return inner.pending ? inner.pending() : 0; };
    t.close = function () { if (closed) return; closed = true; t.failure = inner.failure; try { inner.close(); } catch (ex) { } t.emit('close'); };
    return t;
}

/**
 * Cap incoming frames at `max` bytes while they are received (also after
 * permessage-deflate). The ws library has only a server-wide `maxPayload`, shared
 * with MeshCentral's own WebSockets, so the per-connection limit is set on the
 * receiver and the deflate extension. Written for ws 7.5 (bundled with
 * express-ws 5.0.2, used by MeshCentral) and ws 8; test/outband/power.test.js
 * checks it.
 */
function capFrames(wsock, max) {
    try {
        if (wsock._receiver && (typeof wsock._receiver._maxPayload == 'number')) wsock._receiver._maxPayload = max;
        const pmd = wsock._extensions && wsock._extensions['permessage-deflate'];
        if (pmd && (typeof pmd._maxPayload == 'number')) pmd._maxPayload = max;
    } catch (ex) { }
}

// ---- sessions -------------------------------------------------------------------

function createConsole(core, deps) {
    const busy = new Map(); // nodeid -> session
    const opts = function () { return Object.assign({}, DEFAULTS, core.consoleOptions || {}); };

    /** The checks for opening a console now; throws the spec error. */
    async function check(ctx, deviceId, kind, forOpen) {
        ctx.requireScope('console');
        const node = await deps.visibleNode(ctx, deviceId);
        if (kind != 'sol') throw new ApiError(409, 'not_supported', 'This console kind is not available yet');
        const info = deps.info(ctx, node);
        if (!solAllowed(info.rights)) throw new ApiError(403, 'forbidden', 'Not allowed');
        if ((node.intelamt == null) || (typeof node.intelamt != 'object') || !solReachable(info)) throw new ApiError(409, 'not_reachable', 'The console cannot be reached now');
        const s = busy.get(node._id);
        if ((s != null) && (s !== forOpen)) throw new ApiError(409, 'busy', 'A console session is already open for this device');
        return node;
    }

    /**
     * The Outband pin for a device's AMT certificate. Seeded from the hash MeshCentral
     * stored when there is one, otherwise from the first console that opens; after that
     * it is enforced on every connection, whatever MeshCentral's current hash is. Only an
     * administrator's reset (DELETE /api/v1/admin/devices/{id}/amt-pin) removes it.
     */
    async function verify(node, cert, session) {
        if ((cert == null) || (cert.raw == null)) return false;
        const pins = core.store.amtpins;
        let pin = await pins.findOne({ _id: node._id });
        if ((pin == null) && (typeof node.intelamt.hash == 'string') && (node.intelamt.hash.length > 0)) {
            pin = { _id: node._id, hash: node.intelamt.hash.toLowerCase(), source: 'meshcentral', time: Date.now() };
            try { await pins.insert(pin); } catch (ex) { pin = (await pins.findOne({ _id: node._id })) || pin; }
        }
        if (pin != null) return certMatches(cert, pin.hash);
        session.firstUse = crypto.createHash('sha384').update(cert.raw).digest('hex');
        return true;
    }

    /** Remove a device's pin (and its TLS mode); the next console that opens pins the certificate it sees. */
    async function resetPin(nodeid) { return core.store.amtpins.remove({ _id: nodeid }); }

    async function target(ctx, deviceId, kind) {
        const node = await check(ctx, deviceId, kind, null);
        return { deviceId: deviceId, groupId: node.meshid };
    }

    function open(wsock, ctx, binding) {
        const o = opts();
        const nodeid = 'node/' + ctx.domain.id + '/' + binding.deviceId;
        let closed = false, sol = null, transport = null, idleTimer = null, checkTimer = null, connectTimer = null, lastActivity = Date.now(), checking = false;
        const session = { ctx: ctx, nodeid: nodeid };
        const listeners = [];
        const on = function (name, fn) { core.bus.on(name, fn); listeners.push([name, fn]); };
        const state = function (st, reason) { if (closed) return; try { wsock.send(JSON.stringify(reason ? { type: 'state', state: st, reason: reason } : { type: 'state', state: st })); } catch (ex) { } };

        function finish(code, reason) {
            if (closed) return;
            state('closed', reason);
            closed = true;
            clearInterval(checkTimer); clearInterval(idleTimer); clearTimeout(connectTimer);
            for (const l of listeners) core.bus.removeListener(l[0], l[1]);
            if (busy.get(nodeid) === session) busy.delete(nodeid);
            if (sol) sol.close(); else if (transport) { try { transport.close(); } catch (ex) { } }
            try { wsock.close(code); } catch (ex) { }
        }
        session.finish = finish;

        // One SOL session per device, decided synchronously here (two upgrades can race past target()).
        if (busy.has(nodeid)) { try { wsock.close(4409); } catch (ex) { } return; }
        busy.set(nodeid, session);

        capFrames(wsock, o.maxFrame); // also set by the router before any check
        wsock.on('close', function () { finish(1000, null); });
        wsock.on('error', function () { finish(1011, 'error'); });

        // Revocation: bus events at once, and a periodic re-check of the credential, rights and reachability.
        on('session-ended', function (e) { if (ctx.isCookie && ctx.session && (e.userid === ctx.userid) && (e.x === ctx.session.x)) finish(4403, 'revoked'); });
        on('token-ended', function (e) { if (ctx.isToken && (e.tokenId === ctx.token._id)) finish(4403, 'revoked'); });
        on('bearer-disabled', function () { if (ctx.isToken) finish(4403, 'disabled'); });
        on('shutdown', function () { finish(1001, 'shutdown'); });
        const recheck = async function () {
            if (closed || checking) return;
            checking = true; let timer = null;
            try {
                const timeout = new Promise(function (resolve, reject) { timer = setTimeout(function () { reject(new ApiError(503, 'timeout', 'timeout')); }, o.checkTimeoutMs); });
                const r = await Promise.race([ctx.revalidate(), timeout]);
                if (closed) return;
                if (r) { finish(4403, 'revoked'); return; }
                await Promise.race([check(ctx, binding.deviceId, binding.kind, session), timeout]);
            } catch (ex) {
                if (!closed) finish(((ex instanceof ApiError) && (ex.status == 409)) ? 4409 : 4403, ((ex instanceof ApiError) && (ex.status == 409)) ? 'unreachable' : 'rights');
            } finally { clearTimeout(timer); checking = false; }
        };
        checkTimer = setInterval(recheck, o.revalidateMs);
        idleTimer = setInterval(function () { if (Date.now() - lastActivity > o.idleMs) finish(1000, 'idle'); }, Math.min(o.idleMs, 30000));

        // Client -> device
        wsock.on('message', function (data, isBinary) {
            if (closed) return;
            const buf = Buffer.isBuffer(data) ? data : (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data));
            if (buf.length > o.maxFrame) { finish(1009, 'frame_too_large'); return; }
            lastActivity = Date.now();
            if ((typeof data == 'string') || (isBinary === false)) return; // a text frame is a control message (ws 7 passes text as a string): `resize` is ignored for SOL, anything else too
            if ((sol == null) || (sol.state != 1)) return;
            if (transport.pending && (transport.pending() > o.maxDeviceBuffered)) { finish(1008, 'backpressure'); return; }
            sol.write(buf);
        });

        state('connecting');
        (async function () {
            const node = await deps.visibleNode(ctx, binding.deviceId).catch(function () { return null; });
            if (closed) return;
            if ((node == null) || (node.intelamt == null) || (typeof node.intelamt.user != 'string') || (typeof node.intelamt.pass != 'string')) { finish(4409, 'unreachable'); return; }
            const verifier = function (cert) { return verify(node, cert, session); };
            const pinned = await core.store.amtpins.findOne({ _id: node._id }).catch(function () { return null; });
            if (closed) return;
            const mode = (pinned && (pinned.legacy_tls === true)) ? 'legacy' : 'modern';
            const make = function (m) { return (typeof o.connect == 'function') ? o.connect(node, verifier, m) : defaultConnect(core, node, verifier, m); };
            let first = null;
            try { first = make(mode); } catch (ex) { first = null; }
            if (first == null) { finish(4409, 'unreachable'); return; }
            transport = fallbackTransport(first, make, mode);
            sol = new SolClient(transport, node.intelamt.user, node.intelamt.pass);
            connectTimer = setTimeout(function () { if (sol.state != 1) finish(4409, 'unreachable'); }, o.connectTimeoutMs);
            sol.on('open', function () {
                clearTimeout(connectTimer); lastActivity = Date.now();
                const legacy = transport.tls && (transport.mode == 'legacy');
                if (session.firstUse) {
                    core.store.amtpins.insert({ _id: node._id, hash: session.firstUse, source: 'first_use', time: Date.now(), legacy_tls: legacy }).catch(function () { });
                    session.firstUse = null;
                } else if (transport.tls) {
                    // A re-added device that presented its pinned certificate is active again; record the TLS mode that worked.
                    const set = legacy ? { $set: { legacy_tls: true }, $unset: { removed: true } } : { $unset: { removed: true } };
                    core.store.amtpins.update({ _id: node._id }, set).catch(function () { });
                }
                state('open');
            });
            sol.on('data', function (d) {
                if (closed) return;
                lastActivity = Date.now();
                if (wsock.bufferedAmount > o.maxClientBuffered) { finish(1008, 'backpressure'); return; }
                try { wsock.send(d, { binary: true }); } catch (ex) { }
            });
            sol.on('close', function () {
                if (transport.failure == 'cert_changed') {
                    core.audit.write({ domain: ctx.domain.id, type: 'node', action: 'outband.console.pin', outcome: 'denied', reason: 'cert_changed', user: ctx.userid, userName: ctx.user.name, tokenId: ctx.token && ctx.token._id, tokenName: ctx.token && ctx.token.name, deviceId: node._id, groupId: node.meshid, ip: ctx.ip, params: { kind: binding.kind } });
                    console.log('Outband API: console refused for device ' + binding.deviceId + ': its Intel AMT certificate does not match the pinned one. A full site administrator can reset the pin after checking the device.');
                    finish(4409, 'cert_changed');
                    return;
                }
                finish(4409, 'device_closed');
            });
        })().catch(function () { finish(1011, 'error'); });
    }

    return { target: target, open: open, busy: busy, resetPin: resetPin };
}

module.exports = { createConsole, SolClient, socketTransport, ciraTransport, fallbackTransport, amtTlsOptions, certMatches, capFrames, PIN_TOMBSTONE_MS, DEFAULTS };
