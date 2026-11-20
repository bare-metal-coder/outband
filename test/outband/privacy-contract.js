/**
 * Privacy contract for resource mappers.
 *
 * Every Device, DeviceDetail and Event object the API returns (REST and
 * stream) must be built by the mappers in `outband/mappers.js`:
 *   mapDevice(ctx, node, info)        -> spec Device
 *   mapDeviceDetail(ctx, node, info)  -> spec DeviceDetail
 *   mapEvent(ctx, event)              -> spec Event (MeshCentral event or Outband audit record)
 * and they must decide every private field through the AuthContext helpers
 * (seesDeviceAddresses, seesIdentities, seesSourceIp, pseudonymUser,
 * pseudonymToken) and build Outband audit messages with Audit.message.
 *
 * `runPrivacyContract(mappers)` feeds records full of private values to the
 * mappers under several credentials and returns a list of violations
 * (empty when the mappers comply). The resources implementation must pass it.
 */

'use strict';

const { AuthContext } = require('../../outband/auth');
const { Audit } = require('../../outband/audit');
const { checkSchema } = require('./contract');

const FULL = 0xFFFFFFFF;
const SECRET = {
    ip: '198.51.100.23', ip6: '2001:db8::23', serial: 'SN-EXAMPLE-0001', email: 'alice@example.com',
    userid: 'user//alice', username: 'alice', tokenId: 'tok_EXAMPLEtoken01', tokenName: 'private-token-name'
};
const NODE_ID = 'EXAMPLEnodeId00000000000000000000000000000000000000000000000000';
const GROUP_ID = 'EXAMPLEgroupId0000000000000000000000000000000000000000000000000';

function fakeCore() {
    return {
        webserver: { users: {}, GetMeshRights: function () { return FULL; } },
        hooks: { userHasSecondFactor: function () { return false; } },
        pseudonyms: {
            user: function (scope, id) { return 'u_' + Buffer.from(scope + '|' + id).toString('hex').substring(0, 16); },
            token: function (scope, id) { return 't_' + Buffer.from(scope + '|' + id).toString('hex').substring(0, 16); }
        }
    };
}

/**
 * Build a spied context. kind: 'session-admin' | 'session-user' | 'token-read' | 'token-console' | 'token-audit-admin'
 * | 'token-audit-admin-restricted' (full admin, `audit` scope, restricted to one group).
 */
function makeCtx(kind) {
    const core = fakeCore();
    const admin = (kind == 'session-admin') || (kind == 'token-audit-admin') || (kind == 'token-audit-admin-restricted');
    const user = { _id: 'user//viewer', type: 'user', name: 'viewer', siteadmin: admin ? FULL : 0, links: {} };
    const isToken = kind.startsWith('token');
    const scopes = isToken ? (kind == 'token-read' ? ['read'] : kind == 'token-console' ? ['read', 'console'] : ['read', 'audit']) : ['read', 'power_on', 'power_off', 'console', 'identity', 'audit'];
    const ctx = new AuthContext(core, {
        domain: { id: '' }, user: user, method: isToken ? 'token' : 'cookie', scopes: scopes,
        token: isToken ? { _id: 'tok_viewer', groups: (kind == 'token-audit-admin-restricted') ? ['OtherGroup'] : null, scopes: scopes } : null,
        session: isToken ? null : { u: user._id, x: 'X', ia: Date.now(), la: Date.now(), la2: null },
        credentialKey: isToken ? 'tok:tok_viewer' : 'ses:user//viewer/X', ip: '127.0.0.1'
    });
    ctx.calls = {};
    for (const m of ['seesDeviceAddresses', 'seesIdentities', 'seesSourceIp', 'pseudonymUser', 'pseudonymToken']) {
        const orig = ctx[m].bind(ctx);
        ctx[m] = function (...a) { ctx.calls[m] = (ctx.calls[m] || 0) + 1; return orig(...a); };
    }
    return ctx;
}

function fixtures() {
    const node = {
        _id: 'node//' + NODE_ID, type: 'node', name: 'server-01', host: 'server-01.example.com', meshid: 'mesh//' + GROUP_ID, domain: '',
        ip: SECRET.ip, osdesc: 'Ubuntu 24.04 LTS', agent: { ver: 1, id: 6 }, intelamt: { ver: '16.1.25', state: 2 }, pwr: 1,
        desc: 'Contact ' + SECRET.email, tags: ['lab']
    };
    const info = {
        ips: [SECRET.ip, SECRET.ip6], serial: SECRET.serial, sysinfo: { hardware: { identifiers: { bios_serial: SECRET.serial, product_name: 'Example' } } },
        group: { id: GROUP_ID, name: 'Lab', kind: 'agent' }, rights: FULL, online: true, lastConnect: { addr: SECRET.ip }
    };
    const mcEvent = {
        _id: 'EXAMPLEevent0001', etype: 'node', action: 'login', time: new Date('2026-01-01T12:00:00Z'), nodeid: node._id, meshid: node.meshid, domain: '',
        userid: SECRET.userid, username: SECRET.username, msg: 'Account login from ' + SECRET.ip + ', ' + SECRET.email, ip: SECRET.ip, tokenName: SECRET.tokenName
    };
    const audit = {
        _id: 'evt_EXAMPLEaudit1', time: Date.parse('2026-01-01T12:00:01Z'), domain: '', type: 'node', action: 'outband.power', outcome: 'success',
        user: SECRET.userid, user_name: SECRET.username, token_id: SECRET.tokenId, token_name: SECRET.tokenName, device_id: node._id, group_id: node.meshid,
        action_id: 'act_EXAMPLE01', source_ip: SECRET.ip, params: { power_action: 'off', path: 'agent' }, count: 1
    };
    return { node, info, mcEvent, audit };
}

function contains(obj, s) { return JSON.stringify(obj).indexOf(s) >= 0; }

/**
 * @param {{mapDevice: Function, mapDeviceDetail: Function, mapEvent: Function}} mappers
 * @returns {Promise<string[]>} violations
 */
async function runPrivacyContract(mappers) {
    const v = [];
    const f = fixtures();
    const call = async function (fn, ctx, ...a) { try { return await fn(ctx, ...a); } catch (ex) { v.push(fn.name + ' threw: ' + ex.message); return null; } };
    const schema = function (name, val) { try { checkSchema(name, val); } catch (ex) { v.push(ex.message.split('\n')[0]); } };

    // Devices
    for (const kind of ['token-read', 'token-audit-admin']) {
        const ctx = makeCtx(kind);
        const d = await call(mappers.mapDevice, ctx, f.node, f.info);
        const dd = await call(mappers.mapDeviceDetail, ctx, f.node, f.info);
        if (d) schema('Device', d);
        if (dd) schema('DeviceDetail', dd);
        for (const [name, out] of [['mapDevice', d], ['mapDeviceDetail', dd]]) {
            if (out == null) continue;
            if (contains(out, SECRET.ip) || contains(out, SECRET.ip6)) v.push(name + ' (' + kind + '): device address shown without console scope');
            if (contains(out, SECRET.serial)) v.push(name + ' (' + kind + '): hardware serial shown without console scope');
            if ('ips' in out) v.push(name + ' (' + kind + '): `ips` must be left out');
        }
        if (!ctx.calls.seesDeviceAddresses) v.push('mapDevice/mapDeviceDetail (' + kind + '): did not consult ctx.seesDeviceAddresses()');
    }
    for (const kind of ['session-user', 'token-console']) {
        const ctx = makeCtx(kind);
        const dd = await call(mappers.mapDeviceDetail, ctx, f.node, f.info);
        if (dd && !contains(dd.ips || [], SECRET.ip)) v.push('mapDeviceDetail (' + kind + '): ips missing where they may be shown');
        if (dd && !(dd.hardware && dd.hardware.serial == SECRET.serial)) v.push('mapDeviceDetail (' + kind + '): serial missing where it may be shown');
    }

    // Events, as a caller without identities or source_ip
    for (const kind of ['token-read', 'session-user', 'token-console', 'token-audit-admin-restricted']) {
        for (const [label, ev] of [['MeshCentral event', f.mcEvent], ['audit record', f.audit]]) {
            const ctx = makeCtx(kind);
            const auditCalls = { n: 0 };
            const orig = Audit.message;
            Audit.message = function (doc) { auditCalls.n++; return orig(doc); };
            let e;
            try { e = await call(mappers.mapEvent, ctx, ev); } finally { Audit.message = orig; }
            if (e == null) continue;
            schema('Event', e);
            if (contains(e, SECRET.ip) || contains(e, SECRET.email)) v.push('mapEvent (' + kind + ', ' + label + '): address or email shown');
            if ((e.source_ip != null)) v.push('mapEvent (' + kind + ', ' + label + '): source_ip shown');
            if (!ctx.calls.seesSourceIp) v.push('mapEvent (' + kind + ', ' + label + '): did not consult ctx.seesSourceIp()');
            if (!ctx.calls.seesIdentities) v.push('mapEvent (' + kind + ', ' + label + '): did not consult ctx.seesIdentities()');
            if (label == 'audit record' && auditCalls.n == 0) v.push('mapEvent (' + kind + '): audit message not built with Audit.message');
            if ((kind == 'token-read') || (kind == 'token-console')) {
                if (contains(e, SECRET.userid) || contains(e, '"' + SECRET.username + '"') || contains(e, SECRET.tokenName) || contains(e, SECRET.tokenId)) v.push('mapEvent (' + kind + ', ' + label + '): real identity shown');
                if (!e.user || (e.user.redacted !== true) || (e.user.name !== null) || (e.user.id !== ctx.pseudonymUser(SECRET.userid))) v.push('mapEvent (' + kind + ', ' + label + '): user must be the ctx.pseudonymUser pseudonym');
                if ((label == 'audit record') && (e.token_id !== ctx.pseudonymToken(SECRET.tokenId))) v.push('mapEvent (' + kind + '): token_id must be the ctx.pseudonymToken pseudonym');
            }
            if (/(^|[^a-z])msg|login from/i.test(e.message || '') && contains(e.message, SECRET.ip)) v.push('mapEvent: free text passed through');
        }
    }
    // A group-restricted full admin with `audit` sees real names but never source_ip
    {
        const r = makeCtx('token-audit-admin-restricted');
        const er = await call(mappers.mapEvent, r, f.audit);
        if (er && (!er.user || er.user.name !== SECRET.username || er.user.redacted !== false)) v.push('mapEvent (token-audit-admin-restricted): real user name missing for an audit-scoped token');
        if (er && (er.source_ip != null)) v.push('mapEvent (token-audit-admin-restricted): source_ip shown through a group-restricted token');
        if (r.seesSourceIp()) v.push('seesSourceIp() is true for a group-restricted token');
    }
    // Events, as a full admin session: source_ip and real names are shown
    const adm = makeCtx('session-admin');
    const ea = await call(mappers.mapEvent, adm, f.audit);
    if (ea && (ea.source_ip !== SECRET.ip)) v.push('mapEvent (session-admin): source_ip missing where it may be shown');
    if (ea && (!ea.user || ea.user.name !== SECRET.username)) v.push('mapEvent (session-admin): real user name missing where it may be shown');
    return v;
}

module.exports = { runPrivacyContract, SECRET, NODE_ID, GROUP_ID };
