/**
 * @description Outband API: the resource endpoints (groups, devices, device
 * events, events, stream). Power and the console relay are separate lanes
 * and stay as the `not_implemented` stubs; devices still report their
 * `capabilities`, computed from outband/power.js without dispatching.
 *
 * Order of checks for every endpoint: visibility (404, identical for
 * "missing" and "not visible"), scope, MeshCentral rights, reachability.
 * @license Apache-2.0
 */

'use strict';

const { ApiError, lastSegment } = require('./util');
const { mapDevice, mapDeviceDetail, mapGroup, groupKind, CONN } = require('./mappers');
const events = require('./events');
const { Hub } = require('./hub');
const { createStream } = require('./stream');

function dbGet(core, id) {
    return new Promise(function (resolve) {
        try { core.webserver.db.Get(id, function (err, docs) { resolve((err || !Array.isArray(docs) || (docs.length != 1)) ? null : docs[0]); }); }
        catch (ex) { resolve(null); }
    });
}

function allNodes(core, domainId, meshIds) {
    return new Promise(function (resolve) {
        if (meshIds.length == 0) { resolve([]); return; }
        try { core.webserver.db.GetAllTypeNoTypeFieldMeshFiltered(meshIds, null, domainId, 'node', null, 0, 0, null, function (err, docs) { resolve(Array.isArray(docs) ? docs : []); }); }
        catch (ex) { resolve([]); }
    });
}

function checkPageCursor(c) {
    if (c == null) return null;
    if ((typeof c.n != 'string') || (typeof c.i != 'string') || (c.n.length > 600) || (c.i.length > 200)) throw new ApiError(400, 'invalid_request', 'Invalid cursor', { field: 'cursor' });
    return c;
}

function afterCursor(name, id, c) { return (c == null) || (name > c.n) || ((name == c.n) && (id > c.i)); }
function sortKey(name) { return String(name || '').toLowerCase(); }

function createResources(core) {
    const hub = new Hub();
    core.hub = hub;
    hub.attach(core.parent);
    core.audit.onWrite = function (doc) { hub.onAudit(doc); };

    const ws = core.webserver;

    function connectivity(nodeid) {
        const p = core.parent;
        const s = (typeof p.GetConnectivityState == 'function') ? p.GetConnectivityState(nodeid) : (p.connectivityByNode && p.connectivityByNode[nodeid]);
        return s || null;
    }

    /** Online agents per group, for the Wake-on-LAN peer rule. */
    function agentPeers() {
        const m = new Map(), by = core.parent.connectivityByNode || {};
        for (const id of Object.keys(by)) { const s = by[id]; if (s && s.meshid && ((s.connectivity & CONN.AGENT) != 0)) m.set(s.meshid, (m.get(s.meshid) || 0) + 1); }
        return m;
    }

    /** Everything the mappers need about one node, for this caller. */
    function nodeInfo(ctx, node, o) {
        const mesh = ws.meshes[node.meshid];
        const s = connectivity(node._id);
        const conn = s ? (s.connectivity | 0) : 0;
        const ips = [];
        const add = function (a) {
            if (typeof a != 'string') return;
            a = a.replace(/^\[([^\]]+)\](:\d+)?$/, '$1').replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1');
            if ((a.length > 0) && (ips.indexOf(a) < 0)) ips.push(a);
        };
        add(node.ip); if (o.lc) add(o.lc.addr);
        const pw = hub.power.get(node._id);
        const peers = o.peers ? ((o.peers.get(node.meshid) || 0) - (((conn & CONN.AGENT) != 0) ? 1 : 0)) : 0;
        let lastSeen = (o.lc && (typeof o.lc.time == 'number')) ? o.lc.time : null;
        if ((conn & CONN.AGENT) != 0) lastSeen = Date.now();
        return {
            group: { id: lastSegment(node.meshid), name: mesh ? mesh.name : '', kind: groupKind(mesh) },
            rights: ctx.meshRights(node.meshid), conn: conn, powerState: s ? (s.powerState | 0) : 0,
            powerSince: pw ? pw.since : null, lastSeen: lastSeen, ips: ips, wolPeers: peers > 0,
            sysinfo: o.sysinfo || null
        };
    }

    function notFoundDevice(ctx, id) {
        core.audit.deny(ctx.credentialKey, {
            domain: ctx.domain.id, type: 'node', action: 'outband.not_found', reason: 'device', user: ctx.userid, userName: ctx.user.name,
            tokenId: ctx.token && ctx.token._id, tokenName: ctx.token && ctx.token.name, deviceId: 'node/' + ctx.domain.id + '/' + id, ip: ctx.ip
        });
        return new ApiError(404, 'not_found', 'Not found');
    }

    /** The node, when it exists and the caller may see it; else throws the (audited) 404. */
    async function visibleNode(ctx, id) {
        ctx.requireScope('read');
        const node = await dbGet(core, 'node/' + ctx.domain.id + '/' + id);
        if ((node == null) || (node.type != null && node.type != 'node') || (typeof node.meshid != 'string') || (ctx.meshRights(node.meshid) == 0) || (ws.meshes[node.meshid] == null)) throw notFoundDevice(ctx, id);
        return node;
    }

    function visibleMeshes(ctx) {
        const out = [];
        for (const id of Object.keys(ws.meshes || {})) {
            const mesh = ws.meshes[id];
            if ((mesh == null) || mesh.deleted) continue;
            const rights = ctx.meshRights(id);
            if (rights != 0) out.push({ mesh: mesh, rights: rights });
        }
        return out;
    }

    const impl = {
        listGroups: async function (ctx, args) {
            ctx.requireScope('read');
            const cur = checkPageCursor(args.cursor);
            const vis = visibleMeshes(ctx).sort(function (a, b) { return (sortKey(a.mesh.name) + '\0' + a.mesh._id) < (sortKey(b.mesh.name) + '\0' + b.mesh._id) ? -1 : 1; });
            const rest = vis.filter(function (v) { return afterCursor(sortKey(v.mesh.name), lastSegment(v.mesh._id), cur); });
            const page = rest.slice(0, args.limit);
            const counts = await countDevices(ctx, page.map(function (v) { return v.mesh._id; }));
            const last = page[page.length - 1];
            return {
                items: page.map(function (v) { return mapGroup(ctx, { mesh: v.mesh, rights: v.rights, deviceCount: counts.get(v.mesh._id) || 0 }); }),
                next: (rest.length > page.length) ? { n: sortKey(last.mesh.name), i: lastSegment(last.mesh._id) } : null
            };
        },

        getGroup: async function (ctx, groupId) {
            ctx.requireScope('read');
            const id = 'mesh/' + ctx.domain.id + '/' + groupId;
            const mesh = ws.meshes[id];
            const rights = ctx.meshRights(id);
            if ((mesh == null) || mesh.deleted || (rights == 0)) throw new ApiError(404, 'not_found', 'Not found');
            const counts = await countDevices(ctx, [id]);
            return mapGroup(ctx, { mesh: mesh, rights: rights, deviceCount: counts.get(id) || 0 });
        },

        listDevices: async function (ctx, args) {
            ctx.requireScope('read');
            const cur = checkPageCursor(args.cursor);
            let ids = visibleMeshes(ctx).map(function (v) { return v.mesh._id; });
            if (args.group) ids = ids.filter(function (id) { return lastSegment(id) == args.group; });
            let nodes = (await allNodes(core, ctx.domain.id, ids)).filter(function (n) { return (typeof n._id == 'string') && (typeof n.meshid == 'string') && (ctx.meshRights(n.meshid) != 0); });
            if (args.q) { const q = args.q.toLowerCase(); nodes = nodes.filter(function (n) { return (String(n.name || '').toLowerCase().indexOf(q) >= 0) || (String(n.host || '').toLowerCase().indexOf(q) >= 0); }); }
            if (args.status) {
                nodes = nodes.filter(function (n) {
                    const s = connectivity(n._id), c = s ? (s.connectivity | 0) : 0;
                    if (args.status == 'online') return (c & CONN.AGENT) != 0;
                    if (args.status == 'offline') return (c & CONN.AGENT) == 0;
                    return (c & (CONN.CIRA | CONN.AMT | CONN.RELAY)) != 0;
                });
            }
            nodes.sort(function (a, b) { const ka = sortKey(a.name) + '\0' + lastSegment(a._id), kb = sortKey(b.name) + '\0' + lastSegment(b._id); return (ka < kb) ? -1 : ((ka > kb) ? 1 : 0); });
            const rest = nodes.filter(function (n) { return afterCursor(sortKey(n.name), lastSegment(n._id), cur); });
            const page = rest.slice(0, args.limit);
            const peers = agentPeers();
            const lcs = await Promise.all(page.map(function (n) { return dbGet(core, 'lc' + n._id); }));
            const last = page[page.length - 1];
            return {
                items: page.map(function (n, i) { return mapDevice(ctx, n, nodeInfo(ctx, n, { lc: lcs[i], peers: peers })); }),
                next: (rest.length > page.length) ? { n: sortKey(last.name), i: lastSegment(last._id) } : null
            };
        },

        getDevice: async function (ctx, deviceId) {
            const node = await visibleNode(ctx, deviceId);
            const parts = await Promise.all([dbGet(core, 'lc' + node._id), dbGet(core, 'si' + node._id)]);
            return mapDeviceDetail(ctx, node, nodeInfo(ctx, node, { lc: parts[0], sysinfo: parts[1], peers: agentPeers() }));
        },

        listDeviceEvents: async function (ctx, deviceId, args) {
            await visibleNode(ctx, deviceId);
            return events.collect(ctx, { device: deviceId, since: args.since, until: args.until }, args.limit, args.cursor);
        },

        listEvents: async function (ctx, args) {
            return events.collect(ctx, { device: args.device, group: args.group, type: args.type, audit: args.audit, since: args.since, until: args.until }, args.limit, args.cursor);
        },

        // Lanes that come later: the router answers 501 for these.
        powerAction: async function () { throw new ApiError(501, 'not_implemented', 'Not implemented yet'); },
        consoleTarget: async function () { throw new ApiError(501, 'not_implemented', 'Not implemented yet'); },
        openConsole: function (wsock) { try { wsock.close(1011); } catch (ex) { } },

        stream: null
    };

    async function countDevices(ctx, meshIds) {
        const m = new Map();
        const nodes = await allNodes(core, ctx.domain.id, meshIds);
        for (const n of nodes) { m.set(n.meshid, (m.get(n.meshid) || 0) + 1); }
        return m;
    }

    impl.stream = createStream(core, hub, {
        nodeMessage: async function (ctx, nodeid, lcOk) {
            const node = await dbGet(core, nodeid);
            if ((node == null) || (typeof node.meshid != 'string') || (ctx.meshRights(node.meshid) == 0) || (ws.meshes[node.meshid] == null)) return null;
            const lc = (((connectivity(nodeid) || {}).connectivity & CONN.AGENT) != 0) ? null : await dbGet(core, 'lc' + nodeid);
            return mapDevice(ctx, node, nodeInfo(ctx, node, { lc: lc, peers: agentPeers() }));
        }
    });
    return impl;
}

module.exports = createResources;
