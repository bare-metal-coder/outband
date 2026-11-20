/**
 * @description Outband API: in-memory rate limiters with a size cap.
 * @license Apache-2.0
 */

'use strict';

const MAX_KEYS = 100000;

/** Fixed-window counter: `limit` hits per `windowMs`. */
class WindowLimiter {
    constructor(limit, windowMs) { this.limit = limit; this.windowMs = windowMs; this.map = new Map(); }

    _entry(key, now) {
        let e = this.map.get(key);
        if ((e == null) || (e.reset <= now)) {
            if (this.map.size >= MAX_KEYS) { this.prune(now); if (this.map.size >= MAX_KEYS) { this.map.clear(); } }
            e = { count: 0, reset: now + this.windowMs };
            this.map.set(key, e);
        }
        return e;
    }

    /** Count a hit. @returns {{allowed: boolean, limit: number, remaining: number, resetSec: number}} */
    hit(key) {
        const now = Date.now();
        const e = this._entry(key, now);
        e.count++;
        const allowed = e.count <= this.limit;
        return { allowed: allowed, limit: this.limit, remaining: Math.max(0, this.limit - e.count), resetSec: Math.max(1, Math.ceil((e.reset - now) / 1000)) };
    }

    /** Look without counting. */
    peek(key) {
        const now = Date.now();
        const e = this.map.get(key);
        if ((e == null) || (e.reset <= now)) return { allowed: true, limit: this.limit, remaining: this.limit, resetSec: Math.ceil(this.windowMs / 1000) };
        return { allowed: e.count < this.limit, limit: this.limit, remaining: Math.max(0, this.limit - e.count), resetSec: Math.max(1, Math.ceil((e.reset - now) / 1000)) };
    }

    prune(now) { for (const [k, e] of this.map) { if (e.reset <= now) this.map.delete(k); } }
}

/**
 * Failure counter with lockout: `max` failures within `windowMs` locks the
 * key for `lockMs`. Used for the per-account login counter, the per-user
 * second-factor counter and the invalid-bearer limiter.
 */
class FailureLock {
    constructor(max, windowMs, lockMs) { this.max = max; this.windowMs = windowMs; this.lockMs = lockMs; this.map = new Map(); }

    /** Seconds left on a lock, or 0. */
    lockedFor(key) {
        const e = this.map.get(key);
        if ((e == null) || (e.lockedUntil == null)) return 0;
        const left = e.lockedUntil - Date.now();
        if (left <= 0) { this.map.delete(key); return 0; }
        return Math.ceil(left / 1000);
    }

    fail(key) {
        const now = Date.now();
        if (this.map.size >= MAX_KEYS) { this.prune(now); if (this.map.size >= MAX_KEYS) { this.map.clear(); } }
        let e = this.map.get(key);
        if (e == null) { e = { times: [], lockedUntil: null }; this.map.set(key, e); }
        if ((e.lockedUntil != null) && (e.lockedUntil > now)) return;
        e.times = e.times.filter(function (t) { return t > now - this.windowMs; }, this);
        e.times.push(now);
        if (e.times.length >= this.max) { e.lockedUntil = now + this.lockMs; e.times = []; }
    }

    reset(key) { this.map.delete(key); }

    prune(now) {
        for (const [k, e] of this.map) {
            if ((e.lockedUntil != null) && (e.lockedUntil > now)) continue;
            if ((e.times.length == 0) || (e.times[e.times.length - 1] <= now - this.windowMs)) this.map.delete(k);
        }
    }
}

/** Concurrent-use counter (SSE streams per credential). */
class ConcurrencyLimiter {
    constructor(max) { this.max = max; this.map = new Map(); }
    /** @returns {null|function} a release function, or null if over the limit */
    acquire(key) {
        const n = this.map.get(key) || 0;
        if (n >= this.max) return null;
        this.map.set(key, n + 1);
        let released = false;
        const self = this;
        return function release() {
            if (released) return; released = true;
            const m = (self.map.get(key) || 1) - 1;
            if (m <= 0) self.map.delete(key); else self.map.set(key, m);
        };
    }
}

module.exports = { WindowLimiter, FailureLock, ConcurrencyLimiter };
