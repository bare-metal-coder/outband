/**
 * @description Outband API: single-use console tickets.
 *
 * A ticket is 256 random bits, bound to the user, device, console kind and
 * credential, valid for 60 seconds and usable once. Only its hash is kept.
 * Logout or revocation of the credential cancels unused tickets.
 * @license Apache-2.0
 */

'use strict';

const crypto = require('crypto');
const { sha256Hex } = require('./util');

const TICKET_MS = 60000;
const MAX_TICKETS = 10000;
const PROTOCOL = 'outband.console.v1';
const TICKET_PREFIX = 'outband.ticket.';

class Tickets {
    constructor() { this.map = new Map(); } // hash -> {userid, deviceId, kind, credentialKey, cookie, exp}

    /** @returns {{ticket: string, expires: number}} */
    issue(binding) {
        const now = Date.now();
        this.prune(now);
        if (this.map.size >= MAX_TICKETS) { const oldest = this.map.keys().next().value; this.map.delete(oldest); }
        const ticket = crypto.randomBytes(32).toString('base64url');
        const t = { userid: binding.userid, deviceId: binding.deviceId, kind: binding.kind, credentialKey: binding.credentialKey, cookie: !!binding.cookie, exp: now + TICKET_MS };
        this.map.set(sha256Hex(ticket), t);
        return { ticket: ticket, expires: t.exp };
    }

    /**
     * Mark a ticket used, atomically (the entry is removed before anything
     * else runs). Returns the binding, or null for a bad, used or expired ticket.
     */
    consume(ticket, deviceId, kind) {
        if ((typeof ticket != 'string') || (ticket.length < 40) || (ticket.length > 64)) return null;
        const h = sha256Hex(ticket);
        const t = this.map.get(h);
        if (t == null) return null;
        this.map.delete(h);
        if (t.exp <= Date.now()) return null;
        if ((deviceId != null && t.deviceId != deviceId) || (kind != null && t.kind != kind)) return null;
        return t;
    }

    /** Read the ticket from `Sec-WebSocket-Protocol`. Tickets in the URL are not accepted. */
    static fromProtocols(headerValue) {
        if (typeof headerValue != 'string') return null;
        const list = headerValue.split(',').map(function (s) { return s.trim(); });
        if (list.indexOf(PROTOCOL) < 0) return null;
        for (const p of list) { if (p.startsWith(TICKET_PREFIX)) return p.substring(TICKET_PREFIX.length); }
        return null;
    }

    cancelCredential(credentialKey) { for (const [h, t] of this.map) { if (t.credentialKey == credentialKey) this.map.delete(h); } }
    cancelUser(userid) { for (const [h, t] of this.map) { if (t.userid == userid) this.map.delete(h); } }
    prune(now) { for (const [h, t] of this.map) { if (t.exp <= now) this.map.delete(h); } }
}

module.exports = { Tickets, PROTOCOL, TICKET_PREFIX, TICKET_MS };
