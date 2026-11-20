/**
 * Unit tests: power path rules, host/origin parsing, redaction, helpers.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const power = require('../../outband/power');
const { truncateIp, ipInCidr, isValidCidr } = require('../../outband/util');
const { checkHost, checkOrigin } = require('../../outband/hostorigin');
const { redactUrl, redactHeaders } = require('../../outband/redact');
const { checkSchema } = require('./contract');
const { start } = require('./harness');

function env(reach, groupKind, deny) {
    return { groupKind: groupKind || 'agent', reachable: Object.assign({ agent: false, amt: false, wol: false, mqtt: false, ipkvm: false }, reach), allowed: function (p, a) { return !(deny && deny(p, a)); } };
}
const all = function () { return true; };

test('power: agent online, AMT reachable: graceful default, hard via amt, wake on WoL plus AMT', function () {
    const e = env({ agent: true, amt: true, wol: true });
    const caps = power.capabilities(e, all);
    assert.deepStrictEqual(caps.power_via.off, ['agent']);
    assert.deepStrictEqual(caps.power_via.wake, ['wol', 'amt']);
    assert.deepStrictEqual(caps.power_paths.off, ['agent', 'amt']);
    assert.deepStrictEqual(power.plan(e, 'off', null), ['agent']);
    assert.deepStrictEqual(power.plan(e, 'off', 'amt'), ['amt']);
    assert.deepStrictEqual(power.plan(e, 'wake', null), ['wol', 'amt']);
    assert.deepStrictEqual(power.plan(e, 'wake', 'wol'), ['wol'], 'via restricts wake to one path');
    checkSchema('DeviceCapabilities', Object.assign({ console: [] }, caps));
});

test('power: agent offline, AMT reachable: off not listed, 409 with available_paths, via amt works', function () {
    const e = env({ amt: true });
    const caps = power.capabilities(e, all);
    assert.ok(caps.power.indexOf('off') < 0);
    assert.strictEqual(caps.power_via.off, undefined);
    assert.deepStrictEqual(caps.power_paths.off, ['amt']);
    assert.throws(function () { power.plan(e, 'off', null); }, function (err) { return err.status == 409 && err.details.path == 'agent' && err.details.available_paths[0] == 'amt'; });
    assert.deepStrictEqual(power.plan(e, 'off', 'amt'), ['amt']);
});

test('power: MQTT only: needs via mqtt; MQTT joins the agent default', function () {
    const e = env({ mqtt: true });
    assert.throws(function () { power.plan(e, 'off', null); }, function (err) { return err.status == 409 && err.details.available_paths[0] == 'mqtt'; });
    assert.deepStrictEqual(power.plan(e, 'off', 'mqtt'), ['mqtt']);
    assert.deepStrictEqual(power.plan(env({ agent: true, mqtt: true }), 'off', null), ['agent', 'mqtt']);
});

test('power: invalid via 400, missing right 403 with path, unreachable via 409', function () {
    const e = env({ agent: true, amt: true }, 'agent', function (p) { return p == 'amt'; });
    assert.throws(function () { power.plan(e, 'cycle', 'agent'); }, function (err) { return err.status == 400 && err.details.field == 'via'; });
    assert.throws(function () { power.plan(e, 'off', 'amt'); }, function (err) { return err.status == 403 && err.details.path == 'amt'; });
    assert.throws(function () { power.plan(env({ agent: true }), 'off', 'amt'); }, function (err) { return err.status == 409 && err.details.path == 'amt'; });
    // NOAMT on wake: only Wake-on-LAN
    assert.deepStrictEqual(power.plan(env({ wol: true, amt: true }, 'agent', function (p) { return p == 'amt'; }), 'wake', null), ['wol']);
    // Scope filter in capabilities
    const caps = power.capabilities(env({ agent: true }), function (s) { return s == 'power_on'; });
    assert.deepStrictEqual(caps.power, []);
});

test('power: AMT-only groups and IP-KVM groups', function () {
    assert.deepStrictEqual(power.plan(env({ amt: true, wol: true }, 'amt'), 'wake', null), ['amt']);
    assert.deepStrictEqual(power.plan(env({ ipkvm: true }, 'ipkvm'), 'off', null), ['ipkvm']);
    assert.deepStrictEqual(power.plan(env({ ipkvm: true }, 'ipkvm'), 'on', null), ['ipkvm']);
});

test('helpers: truncateIp, CIDR', function () {
    assert.strictEqual(truncateIp('198.51.100.77'), '198.51.100.0/24');
    assert.strictEqual(truncateIp('2001:db8:1234:5678::1'), '2001:db8:1234::/48');
    assert.strictEqual(truncateIp('::ffff:203.0.113.5'), '203.0.113.0/24');
    assert.ok(ipInCidr('192.0.2.9', '192.0.2.0/28'));
    assert.ok(!ipInCidr('192.0.2.99', '192.0.2.0/28'));
    assert.ok(ipInCidr('2001:db8::5', '2001:db8::/32'));
    assert.ok(isValidCidr('192.0.2.0/24') && isValidCidr('2001:db8::/48') && !isValidCidr('192.0.2.0/33') && !isValidCidr('nope'));
});

test('host and origin: exact matches only, never from Host', function () {
    const certs = { CommonName: 'outband.example.com' };
    const args = { port: 4431 };
    const d = { id: '' };
    const req = function (h) { return { headers: h }; };
    assert.ok(checkHost(req({ host: 'outband.example.com:4431' }), d, certs, args, false));
    assert.ok(!checkHost(req({ host: 'outband.example.com' }), d, certs, args, false));
    assert.ok(!checkHost(req({ host: 'outband.example.com:4431', 'x-forwarded-host': 'evil.example.net' }), d, certs, args, true));
    assert.ok(checkOrigin(req({ origin: 'https://outband.example.com:4431' }), d, certs, args));
    assert.ok(!checkOrigin(req({ origin: 'https://outband.example.com' }), d, certs, args));
    assert.ok(!checkOrigin(req({}), d, certs, args), 'Origin must be present');
    assert.ok(!checkOrigin(req({ origin: 'null' }), d, certs, args));
    assert.ok(!checkOrigin(req({ origin: 'https://outband.example.com:4431', host: 'x' }), { id: '', allowedorigin: true }, { CommonName: 'un-configured' }, args), 'placeholder name is never a name');
    assert.ok(!checkOrigin(req({ origin: 'https://evil.example.net' }), { id: '', allowedorigin: true }, certs, args), 'allowedOrigin true is an empty list');
});

test('redaction of URLs and headers', function () {
    assert.strictEqual(redactUrl('/a?ticket=1&x=2&access_token=3&token=4'), '/a?ticket=[redacted]&x=2&access_token=[redacted]&token=[redacted]');
    const h = redactHeaders({ Authorization: 'Bearer x', Cookie: 'a=b', 'Set-Cookie': 'c', 'Sec-WebSocket-Protocol': 'p', Host: 'h' });
    assert.deepStrictEqual(h, { Authorization: '[redacted]', Cookie: '[redacted]', 'Set-Cookie': '[redacted]', 'Sec-WebSocket-Protocol': '[redacted]', Host: 'h' });
});

test('2FA ignores the remember-this-device cookie', async function () {
    const h = await start({ users: { bob: { password: 'Bob-Pass-1', otpsecret: 'S', testcode: '123456' } } });
    try {
        let seen = null;
        h.core.hooks.checkUserOneTimePasswordRequired = function (d, user, req) { seen = req.headers; return !(req.headers.cookie || '').includes('twofactor='); };
        const c = h.client();
        c.jar.twofactor = 'remembered';
        const r = await c.login('bob', 'Bob-Pass-1');
        assert.strictEqual(r.body.authenticated, false, 'second factor still asked for');
        assert.deepStrictEqual(seen, {});
    } finally { await h.close(); }
});
