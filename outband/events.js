/**
 * @description Outband API: event visibility and listing.
 *
 * One rule set serves `/events`, `/devices/{id}/events`, `/stream` and
 * events delivered again after a reconnect:
 *   - events about groups the caller has rights on (through the token's
 *     `groups` restriction), and the caller's own user events;
 *   - `LIMITEVENTS` narrows a group to the caller's own events;
 *   - `ALLEVENTS` or full site rights see the whole domain, except through a
 *     group-restricted token (ctx.domainWideEvents()).
 * @license Apache-2.0
 */

'use strict';

const { ApiError, FULL_RIGHTS } = require('./util');
const { mapEvent, isAuditRecord, eventId, LIMITEVENTS } = require('./mappers');

/** Most stored MeshCentral events one listing can reach (an upper bound on the work of any request). */
const MAX_DEPTH = 5000;

function timeOf(ev) { const t = (ev.time instanceof Date) ? ev.time.getTime() : new Date(ev.time).getTime(); return Number.isFinite(t) ? t : 0; }

/** Whether this credential may see this event now. */
function eventVisible(ctx, ev) {
    const audit = isAuditRecord(ev);
    const mesh = audit ? ev.group_id : ev.meshid;
    const node = audit ? ev.device_id : ev.nodeid;
    const ref = (typeof mesh == 'string' && mesh) ? mesh : ((typeof node == 'string' && node) ? node : null);
    const domain = (ev.domain != null) ? ev.domain : (ref ? String(ref).split('/')[1] : '');
    if (domain !== ctx.domain.id) return false;
    if (ctx.domainWideEvents()) return true;
    const own = (audit ? ev.user : ev.userid) === ctx.userid;
    if (typeof mesh == 'string' && mesh) {
        const r = ctx.meshRights(mesh);
        if (r == 0) return false;
        if ((r != FULL_RIGHTS) && ((r & LIMITEVENTS) != 0)) return own;
        return true;
    }
    return own;
}

function dbEvents(ctx, ids, limit) {
    const db = ctx.core.webserver.db;
    return new Promise(function (resolve) {
        if ((ids.length == 0) || (typeof db.GetEventsWithLimit != 'function')) { resolve([]); return; }
        try { db.GetEventsWithLimit(ids, ctx.domain.id, limit, null, function (err, docs) { resolve(Array.isArray(docs) ? docs : []); }); }
        catch (ex) { resolve([]); }
    });
}

function visibleMeshIds(ctx) {
    const meshes = ctx.core.webserver.meshes || {};
    const out = [];
    for (const id of Object.keys(meshes)) { if (ctx.meshRights(id) != 0) out.push(id); }
    return out;
}

function checkCursor(c) {
    if (c == null) return null;
    if ((typeof c.t != 'number') || !Number.isFinite(c.t) || (typeof c.i != 'string') || (c.i.length > 64)) throw new ApiError(400, 'invalid_request', 'Invalid cursor', { field: 'cursor' });
    if ((c.d !== undefined) && (!Number.isInteger(c.d) || (c.d < 0) || (c.d > MAX_DEPTH))) throw new ApiError(400, 'invalid_request', 'Invalid cursor', { field: 'cursor' });
    return c;
}

/** (time, id) position of an event; positions order events newest first. */
function posOf(ev) { return { t: timeOf(ev), i: eventId(ev) }; }
function older(a, b) { return (a.t < b.t) || ((a.t == b.t) && (a.i < b.i)); } // a is older than b

/**
 * Newest-first events the caller may see, from ONE bounded read of each
 * source per request. The cursor is a scan position `{t, i, d}`: everything
 * strictly older than (t, i) has not been looked at yet, and `d` is how many
 * stored MeshCentral events were already read from the top. A page can hold
 * fewer than `limit` items (even none) while `next` is set: continue from it.
 * `next` is null only when the history is exhausted, or when the read depth
 * (MAX_DEPTH stored MeshCentral events) is reached.
 * @param {object} f {device, group, type, audit, since, until} (short ids)
 */
async function collect(ctx, f, limit, cursor) {
    ctx.requireScope('read');
    cursor = checkCursor(cursor);
    const domain = ctx.domain.id;
    const fullNode = f.device ? ('node/' + domain + '/' + f.device) : null;
    const fullMesh = f.group ? ('mesh/' + domain + '/' + f.group) : null;
    if (fullMesh && (ctx.meshRights(fullMesh) == 0)) return { items: [], next: null };
    const since = f.since ? f.since.getTime() : null, until = f.until ? f.until.getTime() : null;
    const pred = function (ev) {
        const audit = isAuditRecord(ev);
        const t = timeOf(ev);
        if ((since != null) && (t < since)) return false;
        if ((until != null) && (t >= until)) return false;
        if (f.type && ((audit ? ev.type : ev.etype) !== f.type)) return false;
        if (fullNode && ((audit ? ev.device_id : ev.nodeid) !== fullNode)) return false;
        if (fullMesh && ((audit ? ev.group_id : ev.meshid) !== fullMesh)) return false;
        return eventVisible(ctx, ev);
    };
    let ids;
    if (fullNode) ids = [fullNode];
    else if (fullMesh) ids = [fullMesh];
    else if (ctx.domainWideEvents()) ids = ['*'];
    else ids = visibleMeshIds(ctx).concat([ctx.userid]);
    // Everything the audit store can filter is filtered there, including the cursor position.
    const q = { domain: domain };
    if (f.type) q.type = f.type;
    if (fullNode) q.device_id = fullNode;
    if (fullMesh) q.group_id = fullMesh;
    const tq = {};
    if (since != null) tq.$gte = since;
    const upper = (until != null) ? until : null;
    if (upper != null) tq.$lt = upper;
    if (Object.keys(tq).length > 0) q.time = tq;

    const W = Math.min(Math.max(limit * 5, 100), 1000);
    const depth = cursor ? (cursor.d || 0) : 0;
    const D = Math.min(MAX_DEPTH, depth + W);
    const wantMc = (f.audit !== true) && (depth < MAX_DEPTH);
    const wantAudit = (f.audit !== false);
    const parts = await Promise.all([
        wantMc ? dbEvents(ctx, ids, D) : [],
        wantAudit ? ctx.core.audit.find(q, W, cursor).then(function (r) { return r.items; }) : []
    ]);
    // Identical stored events without an id (same millisecond, same content) get distinct derived ids:
    // the tie-breaker is the occurrence number in the order the database returned them.
    const seenIds = new Map();
    for (const ev of parts[0]) {
        if (ev._id != null) continue;
        const base = eventId(ev), n = seenIds.get(base) || 0;
        seenIds.set(base, n + 1); ev._n = n;
    }
    const byNewest = function (a, b) { const x = posOf(a), y = posOf(b); return older(x, y) ? 1 : (older(y, x) ? -1 : 0); };
    const mcRaw = parts[0].slice().sort(byNewest), auRaw = parts[1].slice().sort(byNewest);

    // Where each source stops being complete: a source that returned a full read may hold more below its last row.
    let boundary = null;
    const bound = function (raw, full) {
        if (!full || (raw.length == 0)) return;
        const p = posOf(raw[raw.length - 1]);
        if ((since != null) && (p.t < since)) return; // reached the start of the requested range
        if ((boundary == null) || older(boundary, p)) boundary = p;
    };
    const mcCapped = wantMc && (mcRaw.length >= D) && (D >= MAX_DEPTH); // nothing deeper is read
    bound(mcRaw, wantMc && (mcRaw.length >= D) && !mcCapped);
    bound(auRaw, wantAudit && (auRaw.length >= W));

    const inRegion = function (ev) {
        const p = posOf(ev);
        if (cursor && !older(p, cursor)) return false;
        if ((boundary != null) && older(p, boundary)) return false;
        return true;
    };
    const cands = mcRaw.concat(auRaw).filter(inRegion).filter(pred).sort(byNewest);
    const items = cands.slice(0, limit);
    let pos = null;
    if (cands.length > limit) pos = posOf(items[items.length - 1]);
    else if (boundary != null) pos = boundary;
    let next = null;
    if (pos != null) {
        // MeshCentral events read so far, down to this position
        const d = wantMc ? mcRaw.filter(function (ev) { return !older(posOf(ev), pos); }).length : depth;
        next = { t: pos.t, i: pos.i, d: Math.min(Math.max(d, depth), MAX_DEPTH) };
    }
    // The depth cap stopped the walk: older MeshCentral events exist that this walk cannot reach.
    const truncated = mcCapped || (wantMc === false && f.audit !== true && depth >= MAX_DEPTH);
    const out = { items: items.map(function (ev) { return mapEvent(ctx, ev); }), next: next };
    if (truncated) out.truncated = true;
    return out;
}

module.exports = { eventVisible, collect, visibleMeshIds, timeOf, MAX_DEPTH };
