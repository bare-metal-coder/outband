/**
 * @description Outband API: power path rules (spec `powerAction`, `DeviceCapabilities`).
 *
 * Pure functions, so the device layer and the tests share one definition:
 *   - `via` selects exactly one path (also for `wake`), with no fallback;
 *   - without `via`, the default dispatches on one or more paths;
 *   - when none of an action's default paths is available, the action is
 *     left out of `power` / `power_via`, and a request without `via` gets
 *     409 not_reachable with `details.path` and `details.available_paths`.
 *
 * `env`:
 *   groupKind  'agent' | 'amt' | 'local' | 'ipkvm' (MeshCentral group type)
 *   reachable  { agent, amt, wol, mqtt, ipkvm }  booleans, "can carry it now"
 *   allowed(path, action)  the owner's MeshCentral rights allow this path
 * @license Apache-2.0
 */

'use strict';

const { ApiError } = require('./util');

const ACTIONS = ['on', 'off', 'reset', 'cycle', 'sleep', 'wake'];
const PATHS = ['agent', 'amt', 'wol', 'mqtt', 'ipkvm'];

/** `via` values allowed per action. */
const VIA_ALLOWED = {
    on: ['amt', 'ipkvm'],
    wake: ['wol', 'amt', 'mqtt', 'ipkvm'],
    off: ['agent', 'amt', 'mqtt', 'ipkvm'],
    reset: ['agent', 'amt', 'mqtt'],
    sleep: ['agent', 'mqtt'],
    cycle: ['amt']
};

/** Rights per path (MeshCentral MESHRIGHT bits): need, mustNot. */
const RIGHTS = {
    WAKEDEVICE: 0x40, RESETOFF: 0x40000, NOAMT: 0x800, REMOTECONTROL: 0x8, REMOTEVIEWONLY: 0x100, NOTERMINAL: 0x200
};
function rightsFor(action, path) {
    const on = (action == 'on') || (action == 'wake');
    const need = on ? RIGHTS.WAKEDEVICE : RIGHTS.RESETOFF;
    const mustNot = (path == 'amt') ? RIGHTS.NOAMT : 0;
    return { need: need, mustNot: mustNot };
}

function scopeForAction(action) { return ((action == 'on') || (action == 'wake')) ? 'power_on' : 'power_off'; }

/** The default path list for an action (before reachability). `primary` must be available; `extra` is added when available. */
function defaultPaths(action, groupKind) {
    if (groupKind == 'ipkvm') {
        if ((action == 'on') || (action == 'wake') || (action == 'off')) return { anyOf: ['ipkvm'], extra: [] };
        return { anyOf: [], extra: [] };
    }
    const amtOnly = (groupKind == 'amt') || (groupKind == 'local');
    switch (action) {
        case 'on': return { anyOf: ['amt'], extra: [] };
        case 'wake': return amtOnly ? { anyOf: ['amt'], extra: [] } : { anyOf: ['wol', 'amt'], extra: [] };
        case 'off': case 'reset': case 'sleep': return amtOnly ? { anyOf: [], extra: [] } : { anyOf: ['agent'], extra: ['mqtt'] };
        case 'cycle': return { anyOf: ['amt'], extra: [] };
    }
    return { anyOf: [], extra: [] };
}

function usable(env, action, path) {
    if (VIA_ALLOWED[action].indexOf(path) < 0) return false;
    if ((env.groupKind == 'ipkvm') != (path == 'ipkvm')) return false;
    if (((env.groupKind == 'amt') || (env.groupKind == 'local')) && (path != 'amt')) return false;
    return !!(env.reachable && env.reachable[path]);
}

/** Paths the default dispatches on now (reachable and allowed), or [] when the default is unavailable. */
function defaultNow(env, action) {
    const d = defaultPaths(action, env.groupKind);
    const primary = d.anyOf.filter(function (p) { return usable(env, action, p) && env.allowed(p, action); });
    if (primary.length == 0) return [];
    return primary.concat(d.extra.filter(function (p) { return usable(env, action, p) && env.allowed(p, action); }));
}

/** Every single path `via` can use now. */
function viaNow(env, action) {
    return VIA_ALLOWED[action].filter(function (p) { return usable(env, action, p) && env.allowed(p, action); });
}

/**
 * Capabilities for one device and caller.
 * @param {object} env
 * @param {function(string): boolean} hasScope
 * @returns {{power: string[], power_via: object, power_paths: object}}
 */
function capabilities(env, hasScope) {
    const out = { power: [], power_via: {}, power_paths: {} };
    for (const a of ACTIONS) {
        if (!hasScope(scopeForAction(a))) continue;
        const d = defaultNow(env, a);
        const v = viaNow(env, a);
        if (d.length > 0) { out.power.push(a); out.power_via[a] = d; }
        if (v.length > 0) { out.power_paths[a] = v; }
    }
    return out;
}

/**
 * Decide the dispatch paths for a request, or throw the spec error.
 * Call after visibility and scope checks.
 * @returns {string[]} paths to dispatch on
 */
function plan(env, action, via) {
    if (ACTIONS.indexOf(action) < 0) throw new ApiError(400, 'invalid_request', 'Invalid action', { field: 'action' });
    if (via != null) {
        if ((PATHS.indexOf(via) < 0) || (VIA_ALLOWED[action].indexOf(via) < 0)) throw new ApiError(400, 'invalid_request', 'This path cannot carry this action', { field: 'via' });
        if (!env.allowed(via, action)) throw new ApiError(403, 'forbidden', 'Not allowed on this path', { path: via });
        if (!usable(env, action, via)) throw new ApiError(409, 'not_reachable', 'This path cannot carry the action now', { path: via });
        return [via];
    }
    const d = defaultPaths(action, env.groupKind);
    const reachablePrimary = d.anyOf.filter(function (p) { return usable(env, action, p); });
    if (reachablePrimary.length > 0) {
        const allowedPrimary = reachablePrimary.filter(function (p) { return env.allowed(p, action); });
        if (allowedPrimary.length == 0) throw new ApiError(403, 'forbidden', 'Not allowed on this path', { path: reachablePrimary[0] });
        return defaultNow(env, action);
    }
    throw new ApiError(409, 'not_reachable', 'The default path cannot carry the action now', { path: d.anyOf[0] || null, available_paths: viaNow(env, action) });
}

module.exports = { ACTIONS, PATHS, VIA_ALLOWED, RIGHTS, rightsFor, scopeForAction, capabilities, plan, defaultNow, viaNow };
