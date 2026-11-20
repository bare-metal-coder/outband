/**
 * @description Outband API: in-memory rate limiters with a size cap.
 *
 * When a table is full, expired entries are dropped first, then the oldest
 * entries that are not locked. Locked entries are never evicted, and the
 * tables are never cleared wholesale.
 * @license Apache-2.0
 */

'use strict';

const DEFAULT_MAX_KEYS = 100000;

/** Fixed-window counter: `limit` hits per `windowMs`. */
class WindowLimiter {
    constructor(limit, windowMs, maxKeys) { this.limit = limit; this.windowMs = windowMs; this.maxKeys = maxKeys || DEFAULT_MAX_KEYS; this.map = new Map(); }

    _evict(now) {
        for (const [k, e] of this.map) { if (e.reset <= now) this.map.delete(k); }
        // Oldest first (Map keeps insertion order); an entry over its limit counts as locked.
        for (const [k, e] of this.map) {
            if (this.map.size < this.maxKeys) break;
            if (e.count <= this.limit) this.map.delete(k);
        }
    }

    _entry(key, now) {
        let e = this.map.get(key);
        if ((e == null) || (e.reset <= now)) {
            if (e != null) this.map.delete(key);
            if (this.map.size >= this.maxKeys) { this._evict(now); }
            e = { count: 0, reset: now + this.windowMs };
            if (this.map.size < this.maxKeys) this.map.set(key, e);
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

    prune(now) { for (const [k, e] of this.map) { if (e.reset <= now) this.map.delete(k); } }
}

/**
 * Failure counter with lockout: `max` failures within `windowMs` locks the
 * key for `lockMs`. Used for the per-account login counter, the per-user
 * second-factor counter and the invalid-bearer limiter.
 */
class FailureLock {
    constructor(max, windowMs, lockMs, maxKeys) { this.max = max; this.windowMs = windowMs; this.lockMs = lockMs; this.maxKeys = maxKeys || DEFAULT_MAX_KEYS; this.map = new Map(); }

    /** Seconds left on a lock, or 0. */
    lockedFor(key) {
        const e = this.map.get(key);
        if ((e == null) || (e.lockedUntil == null)) return 0;
        const left = e.lockedUntil - Date.now();
        if (left <= 0) { this.map.delete(key); return 0; }
        return Math.ceil(left / 1000);
    }

    _locked(e, now) { return (e.lockedUntil != null) && (e.lockedUntil > now); }

    /** Drop stale entries, then the oldest unlocked ones. Never a locked entry. */
    _evict(now) {
        this.prune(now);
        for (const [k, e] of this.map) {
            if (this.map.size < this.maxKeys) break;
            if (!this._locked(e, now)) this.map.delete(k);
        }
    }

    fail(key) {
        const now = Date.now();
        let e = this.map.get(key);
        if (e == null) {
            if (this.map.size >= this.maxKeys) this._evict(now);
            if (this.map.size >= this.maxKeys) return; // every entry is locked: do not track more keys
            e = { times: [], lockedUntil: null };
            this.map.set(key, e);
        }
        if (this._locked(e, now)) return;
        e.lockedUntil = null;
        e.times = e.times.filter(function (t) { return t > now - this.windowMs; }, this);
        e.times.push(now);
        if (e.times.length >= this.max) { e.lockedUntil = now + this.lockMs; e.times = []; }
    }

    reset(key) { const e = this.map.get(key); if ((e != null) && !this._locked(e, Date.now())) this.map.delete(key); }

    prune(now) {
        for (const [k, e] of this.map) {
            if (this._locked(e, now)) continue;
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
