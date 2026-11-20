/**
 * @description Outband API: the mappers. Every Device, DeviceDetail, Group,
 * Event and stream payload is built here, field by field from an allowlist.
 * Raw MeshCentral objects are never passed through, and every private field
 * is decided by an AuthContext helper (see outband/CONTRIBUTING-API.md,
 * "Privacy contract"):
 *   ips, hardware.serial          ctx.seesDeviceAddresses()
 *   user and token identities     ctx.seesIdentities(), else pseudonymUser / pseudonymToken
 *   source_ip, ip / email params  ctx.seesSourceIp()
 *   Outband audit messages        Audit.message(doc)
 * @license Apache-2.0
 */

'use strict';

const net = require('net');
const { Audit } = require('./audit');
const { AuthContext } = require('./auth');
const power = require('./power');
const { lastSegment, FULL_RIGHTS } = require('./util');

/** MeshCentral MESHRIGHT bits, by lower-case name. */
const RIGHT_NAMES = [
    ['editgroup', 0x1], ['manageusers', 0x2], ['managedevices', 0x4], ['remotecontrol', 0x8], ['agentconsole', 0x10], ['serverfiles', 0x20],
    ['wakedevice', 0x40], ['setnotes', 0x80], ['remoteviewonly', 0x100], ['noterminal', 0x200], ['nofiles', 0x400], ['noamt', 0x800],
    ['desklimitedinput', 0x1000], ['limitevents', 0x2000], ['chatnotify', 0x4000], ['uninstall', 0x8000], ['nodesktop', 0x10000],
    ['remotecommand', 0x20000], ['resetoff', 0x40000], ['guestsharing', 0x80000], ['devicedetails', 0x100000], ['relay', 0x200000],
    ['noregistry', 0x400000], ['nosoftware', 0x800000]
];
const LIMITEVENTS = 0x2000;
const CONN = { AGENT: 1, CIRA: 2, AMT: 4, RELAY: 8, MQTT: 16 };
const GROUP_KINDS = { 1: 'amt', 2: 'agent', 3: 'local', 4: 'ipkvm' };
const POWER_STATES = { 0: 'unknown', 1: 'on', 2: 'sleep', 3: 'sleep', 4: 'sleep', 5: 'hibernate', 6: 'soft_off', 7: 'present', 8: 'off' };

function iso(t) { if (t == null) return null; const d = new Date(t); return isNaN(d.getTime()) ? null : d.toISOString(); }
function str(v, max) { return (typeof v == 'string') ? v.substring(0, max || 256) : null; }
function validIp(v) { return (typeof v == 'string') && (net.isIP(v) != 0); }

/** `{mask, names}` for a MeshCentral rights mask. */
function mapRights(mask) {
    mask = (mask >>> 0);
    if (mask == FULL_RIGHTS) return { mask: mask, names: ['admin'] };
    return { mask: mask, names: RIGHT_NAMES.filter(function (r) { return (mask & r[1]) != 0; }).map(function (r) { return r[0]; }) };
}

function groupKind(mesh) { return GROUP_KINDS[mesh && mesh.mtype] || 'agent'; }

/** @returns {object} spec Group. `info`: {mesh, rights, deviceCount} */
function mapGroup(ctx, info) {
    const mesh = info.mesh;
    return {
        id: lastSegment(mesh._id),
        name: str(mesh.name, 256) || '',
        description: str(mesh.desc, 1024) || '',
        kind: groupKind(mesh),
        rights: mapRights(info.rights),
        device_count: Math.max(0, info.deviceCount | 0)
    };
}

/** Capabilities the caller has on a device now, without dispatching anything. */
function mapCapabilities(ctx, info) {
    const rights = (info.rights >>> 0);
    const conn = (info.conn | 0);
    const kind = (info.group && info.group.kind) || 'agent';
    const amtUp = (conn & (CONN.CIRA | CONN.AMT | CONN.RELAY)) != 0;
    const env = {
        groupKind: kind,
        reachable: {
            agent: (conn & CONN.AGENT) != 0,
            amt: amtUp,
            wol: (info.wolPeers === true) && (kind == 'agent'),
            mqtt: (conn & CONN.MQTT) != 0,
            ipkvm: (kind == 'ipkvm') && (conn != 0)
        },
        allowed: function (path, action) {
            const r = power.rightsFor(action, path);
            return AuthContext.hasRight(rights, r.need, r.mustNot);
        }
    };
    const caps = power.capabilities(env, function (s) { return ctx.hasScope(s); });
    const console_ = [];
    if (ctx.hasScope('console') && amtUp && (kind != 'ipkvm') && AuthContext.hasRight(rights, 0x8, 0x800 | 0x100)) console_.push('sol');
    return { power: caps.power, power_via: caps.power_via, power_paths: caps.power_paths, console: console_ };
}

/** @returns {object} spec Device. `info`: see outband/devices.js (`nodeInfo`) */
function mapDevice(ctx, node, info) {
    const conn = (info.conn != null) ? (info.conn | 0) : (info.online ? CONN.AGENT : 0);
    const withInfo = Object.assign({}, info, { conn: conn });
    const ai = (node.intelamt != null) && (typeof node.intelamt == 'object') ? node.intelamt : null;
    let amtState = 'none';
    if (ai != null) amtState = ({ 0: 'unprovisioned', 1: 'provisioning', 2: 'provisioned' })[ai.state] || 'unknown';
    const ps = (info.powerState != null) ? info.powerState : node.pwr;
    const d = {
        id: lastSegment(node._id),
        name: str(node.name, 256) || '',
        host: str(node.host, 256),
        group: { id: str(info.group && info.group.id, 128), name: str(info.group && info.group.name, 256) || '' },
        os: str(node.osdesc, 256),
        online: (conn & CONN.AGENT) != 0,
        connectivity: {
            agent: (conn & CONN.AGENT) != 0, amt_cira: (conn & CONN.CIRA) != 0, amt_local: (conn & CONN.AMT) != 0,
            relay: (conn & CONN.RELAY) != 0, mqtt: (conn & CONN.MQTT) != 0
        },
        amt: { state: amtState, version: ai ? str(ai.ver, 32) : null, reachable: (conn & (CONN.CIRA | CONN.AMT | CONN.RELAY)) != 0 },
        power: { state: POWER_STATES[ps] || 'unknown', since: iso(info.powerSince) },
        last_seen: iso(info.lastSeen),
        capabilities: mapCapabilities(ctx, withInfo),
        links: { ui: '/devices/' + lastSegment(node._id) }
    };
    if (ctx.seesDeviceAddresses()) d.ips = (Array.isArray(info.ips) ? info.ips : []).filter(validIp);
    return d;
}

/** Hardware summary from a MeshCentral system-information record. */
function hardwareOf(sysinfo) {
    const hw = (sysinfo && sysinfo.hardware) || {};
    const id = hw.identifiers || {};
    let mem = null;
    const mems = (hw.windows && Array.isArray(hw.windows.memory)) ? hw.windows.memory : null;
    if (mems) { let b = 0; for (const m of mems) { const c = Number(m && m.Capacity); if (Number.isFinite(c)) b += c; } if (b > 0) mem = Math.round(b / 1048576); }
    if ((mem == null) && hw.linux && hw.linux.memory && Array.isArray(hw.linux.memory)) { let m2 = 0; for (const m of hw.linux.memory) { const s = parseInt(m && m.Size, 10); if (Number.isFinite(s)) m2 += s; } if (m2 > 0) mem = m2; }
    return {
        manufacturer: str(id.board_vendor || id.bios_vendor, 128),
        model: str(id.product_name || id.board_name, 128),
        serial: str(id.bios_serial || id.board_serial || id.product_serial, 128),
        cpu: str(id.cpu_name, 128),
        memory_mb: mem
    };
}

/** @returns {object} spec DeviceDetail */
function mapDeviceDetail(ctx, node, info) {
    const d = mapDevice(ctx, node, info);
    const hw = hardwareOf(info.sysinfo);
    if (info.serial != null) hw.serial = str(info.serial, 128);
    const out = { manufacturer: hw.manufacturer, model: hw.model, cpu: hw.cpu, memory_mb: hw.memory_mb };
    if (ctx.seesDeviceAddresses()) out.serial = hw.serial;
    const hasHw = (hw.manufacturer != null) || (hw.model != null) || (hw.cpu != null) || (hw.memory_mb != null) || (hw.serial != null);
    const agent = (node.agent != null) && (typeof node.agent == 'object');
    return Object.assign(d, {
        rights: mapRights(info.rights),
        description: str(node.desc, 1024),
        tags: Array.isArray(node.tags) ? node.tags.filter(function (t) { return typeof t == 'string'; }).map(function (t) { return t.substring(0, 64); }).slice(0, 64) : [],
        agent: agent ? { version: (node.agent.ver != null) ? String(node.agent.ver).substring(0, 32) : null, type: Number.isInteger(node.agent.id) ? node.agent.id : null, connected_at: ((d.online) ? iso(info.lastSeen) : null) } : null,
        hardware: hasHw ? out : null
    });
}

/** Allowlisted message templates for MeshCentral events (never the free-text `msg`). */
const MC_TEMPLATES = {
    login: 'Account login{from}', authfail: 'Account login failed{from}', logout: 'Account logout',
    nodeconnect: 'Device connection changed', addnode: 'Device added', changenode: 'Device changed', removenode: 'Device removed',
    createmesh: 'Device group created', meshchange: 'Device group changed', removemesh: 'Device group removed',
    accountcreate: 'Account created', accountremove: 'Account removed', accountchange: 'Account changed',
    wakedevices: 'Wake-up requested', recordingStarted: 'Session recording started'
};
const GENERIC = { node: 'Device event', mesh: 'Device group event', user: 'User event', ugrp: 'User group event', server: 'Server event' };

function isAuditRecord(ev) { return (ev.etype === undefined) && (typeof ev.action == 'string') && ev.action.startsWith('outband.'); }

/** @returns {object} spec Event, from a MeshCentral event or an Outband audit record */
function mapEvent(ctx, ev) {
    const real = ctx.seesIdentities();
    const showIp = ctx.seesSourceIp();
    const audit = isAuditRecord(ev);
    const userid = audit ? ev.user : ev.userid;
    const tokenId = audit ? ev.token_id : null;
    const out = {
        id: String(ev._id),
        time: iso(ev.time) || new Date(0).toISOString(),
        type: str(audit ? ev.type : ev.etype, 32) || 'server',
        action: str(ev.action, 64) || 'event'
    };
    if (audit) {
        out.message = Audit.message(ev);
    } else {
        const ipText = (validIp(ev.ip) && showIp) ? (' from ' + ev.ip) : (validIp(ev.ip) ? ' from (hidden)' : '');
        const tpl = MC_TEMPLATES[ev.action];
        out.message = tpl ? tpl.replace('{from}', ipText) : (GENERIC[ev.etype] || 'Event');
    }
    if (userid) {
        if (real) out.user = { id: lastSegment(userid), name: audit ? str(ev.user_name, 128) : str(ev.username, 128), redacted: false };
        else out.user = { id: ctx.pseudonymUser(userid), name: null, redacted: true };
    } else out.user = null;
    out.token_id = tokenId ? (real ? tokenId : ctx.pseudonymToken(tokenId)) : null;
    out.token_name = (tokenId && real) ? str(ev.token_name, 128) : null;
    const dev = audit ? ev.device_id : ev.nodeid, grp = audit ? ev.group_id : ev.meshid;
    out.device_id = dev ? lastSegment(dev) : null;
    out.group_id = grp ? lastSegment(grp) : null;
    out.action_id = audit ? str(ev.action_id, 64) : null;
    out.outcome = audit ? (['success', 'denied', 'failed'].indexOf(ev.outcome) >= 0 ? ev.outcome : 'success') : 'success';
    const addr = audit ? ev.source_ip : ev.ip;
    out.source_ip = (showIp && (typeof addr == 'string') && validIp(addr.split('/')[0])) ? addr : null;
    return out;
}

module.exports = {
    mapDevice, mapDeviceDetail, mapEvent, mapGroup, mapRights, mapCapabilities, hardwareOf, groupKind, isAuditRecord,
    CONN, LIMITEVENTS, POWER_STATES
};
