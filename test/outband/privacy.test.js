/**
 * Runs the privacy contract against outband/mappers.js once it exists, and
 * checks that the contract itself catches mappers that do not use the helpers.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runPrivacyContract, GROUP_ID } = require('./privacy-contract');
const { Audit } = require('../../outband/audit');
const { lastSegment } = require('../../outband/util');

/** A minimal mapper set that follows the contract (reference for the self-test). */
const compliant = {
    mapDevice: function mapDevice(ctx, node, info) {
        const d = {
            id: lastSegment(node._id), name: node.name, host: node.host || null, group: { id: GROUP_ID, name: info.group.name }, os: node.osdesc || null,
            online: !!info.online, connectivity: { agent: true, amt_cira: false, amt_local: false, relay: false, mqtt: false },
            amt: { state: 'provisioned', version: '16.1.25', reachable: false }, power: { state: 'on', since: null }, last_seen: null,
            capabilities: { power: [], power_via: {}, power_paths: {}, console: [] }
        };
        if (ctx.seesDeviceAddresses()) d.ips = info.ips.slice();
        return d;
    },
    mapDeviceDetail: function mapDeviceDetail(ctx, node, info) {
        const d = compliant.mapDevice(ctx, node, info);
        const hw = { manufacturer: null, model: 'Example', cpu: null, memory_mb: null };
        if (ctx.seesDeviceAddresses()) hw.serial = info.serial;
        return Object.assign(d, { rights: { mask: 4294967295, names: ['admin'] }, description: null, tags: [], agent: null, hardware: hw });
    },
    mapEvent: function mapEvent(ctx, ev) {
        const isAudit = (typeof ev.action == 'string') && ev.action.startsWith('outband.');
        const real = ctx.seesIdentities();
        const ip = ctx.seesSourceIp();
        const userid = isAudit ? ev.user : ev.userid;
        const tokenId = isAudit ? ev.token_id : null;
        return {
            id: String(ev._id), time: new Date(ev.time).toISOString(), type: isAudit ? ev.type : ev.etype, action: ev.action,
            message: isAudit ? Audit.message(ev) : 'Device event',
            user: userid ? (real ? { id: lastSegment(userid), name: isAudit ? ev.user_name : ev.username, redacted: false } : { id: ctx.pseudonymUser(userid), name: null, redacted: true }) : null,
            token_id: tokenId ? (real ? tokenId : ctx.pseudonymToken(tokenId)) : null,
            token_name: (tokenId && real) ? ev.token_name : null,
            device_id: null, group_id: null, action_id: null, outcome: 'success',
            source_ip: (ip && isAudit) ? ev.source_ip : null
        };
    }
};

test('privacy contract: the reference mappers comply', async function () {
    assert.deepStrictEqual(await runPrivacyContract(compliant), []);
});

test('privacy contract: mappers that ignore the helpers are caught', async function () {
    const leaky = {
        mapDevice: function mapDevice(ctx, node, info) { return Object.assign(compliant.mapDevice(makeAll(ctx), node, info)); },
        mapDeviceDetail: function mapDeviceDetail(ctx, node, info) { return compliant.mapDeviceDetail(makeAll(ctx), node, info); },
        mapEvent: function mapEvent(ctx, ev) { const e = compliant.mapEvent(makeAll(ctx), ev); e.message = ev.msg || e.message; e.source_ip = ev.ip || ev.source_ip; return e; }
    };
    function makeAll(ctx) { return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { seesDeviceAddresses: () => true, seesIdentities: () => true, seesSourceIp: () => true }); }
    const v = await runPrivacyContract(leaky);
    assert.ok(v.some((x) => /device address shown/.test(x)), v.join('\n'));
    assert.ok(v.some((x) => /serial shown/.test(x)));
    assert.ok(v.some((x) => /source_ip shown/.test(x)));
    assert.ok(v.some((x) => /real identity shown/.test(x)));
    assert.ok(v.some((x) => /did not consult/.test(x)));
});

test('privacy contract: outband/mappers.js (the resources implementation) complies', async function (t) {
    const p = path.join(__dirname, '../../outband/mappers.js');
    if (!fs.existsSync(p)) { t.diagnostic('outband/mappers.js not present yet; the resources implementation must add it'); return; }
    assert.deepStrictEqual(await runPrivacyContract(require(p)), []);
});
