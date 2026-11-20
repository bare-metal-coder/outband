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

const { ApiError, FULL_RIGHTS, lastSegment } = require('./util');
const { mapEvent, isAuditRecord, LIMITEVENTS } = require('./mappers');

const MAX_WINDOW = 20000;

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
    return c;
}

/**
 * Newest-first events the caller may see.
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
        const t = timeOf(ev), id = String(ev._id);
        if ((since != null) && (t < since)) return false;
        if ((until != null) && (t >= until)) return false;
        if (cursor && !((t < cursor.t) || ((t == cursor.t) && (id < cursor.i)))) return false;
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
    const q = { domain: domain };
    if (f.type) q.type = f.type;
    if (fullNode) q.device_id = fullNode;
    if (fullMesh) q.group_id = fullMesh;
    if ((since != null) || (until != null)) { q.time = {}; if (since != null) q.time.$gte = since; if (until != null) q.time.$lt = until; }

    let W = Math.min(Math.max(limit * 3, 60), 5000), all = [], exhausted = false;
    for (let round = 0; round < 6; round++) {
        const parts = await Promise.all([
            (f.audit === true) ? [] : dbEvents(ctx, ids, W),
            (f.audit === false) ? [] : ctx.core.audit.find(q, W, cursor).then(function (r) { return r.items; })
        ]);
        all = parts[0].concat(parts[1]).filter(pred).sort(function (a, b) { const d = timeOf(b) - timeOf(a); return (d != 0) ? d : (String(b._id) < String(a._id) ? -1 : 1); });
        exhausted = (parts[0].length < W) && (parts[1].length < W);
        if ((all.length > limit) || exhausted || (W >= MAX_WINDOW)) break;
        W = Math.min(W * 4, MAX_WINDOW);
    }
    const items = all.slice(0, limit);
    const last = items[items.length - 1];
    const more = (all.length > limit) || (!exhausted && items.length > 0);
    return { items: items.map(function (ev) { return mapEvent(ctx, ev); }), next: (more && last) ? { t: timeOf(last), i: String(last._id) } : null };
}

module.exports = { eventVisible, collect, visibleMeshIds, timeOf, lastSegment };
