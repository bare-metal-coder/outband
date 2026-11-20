// The mock server is the contract the UI and E2E run against, so its spec behaviours are tested too.
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMock } from '../mock/app.mjs';

let base = '';
const server = createMock({ quiet: true });
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => void server.close());

async function call(method: string, path: string, opts: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(method !== 'GET' ? { 'X-Outband': '1', 'Content-Type': 'application/json' } : {}), ...(opts.cookie ? { Cookie: opts.cookie } : {}), ...opts.headers },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const hook = (name: string, body: unknown = {}) => call('POST', `/__mock/${name}`, { body });

async function signIn(user = 'admin') {
  const r = await call('POST', '/api/v1/auth/login', { body: { username: user, password: 'outband' } });
  if (r.json.authenticated) return r.cookie!;
  const t = await call('POST', '/api/v1/auth/2fa', { cookie: r.cookie, body: { code: '123456' } });
  return t.cookie!;
}

beforeEach(async () => void (await hook('reset')));

describe('mock: auth', () => {
  it('login failures are {error:{code,message}}', async () => {
    const r = await call('POST', '/api/v1/auth/login', { body: { username: 'admin', password: 'x' } });
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: { code: 'invalid_credentials', message: expect.any(String) } });
  });
  it('requires X-Outband on POST', async () => {
    const res = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect((await res.json()).error.code).toBe('csrf_failed');
  });
  it('2FA: pending login, invalid_code, then success with a new session', async () => {
    const r = await call('POST', '/api/v1/auth/login', { body: { username: 'ops', password: 'outband' } });
    expect(r.json).toMatchObject({ authenticated: false, twofa: { required: true, methods: ['otp', 'email'] } });
    expect((await call('GET', '/api/v1/devices', { cookie: r.cookie })).status).toBe(401);
    const bad = await call('POST', '/api/v1/auth/2fa', { cookie: r.cookie, body: { code: '000000' } });
    expect(bad.json.error.code).toBe('invalid_code');
    expect((await call('POST', '/api/v1/auth/2fa', { cookie: r.cookie, body: { method: 'email', send: true } })).status).toBe(202);
    const ok = await call('POST', '/api/v1/auth/2fa', { cookie: r.cookie, body: { code: '123456' } });
    expect(ok.json).toMatchObject({ authenticated: true, user: { id: 'ops' } });
    expect(ok.cookie).not.toBe(r.cookie);
  });
  it('429 rate_limited with Retry-After after repeated failures', async () => {
    for (let i = 0; i < 10; i++) await call('POST', '/api/v1/auth/login', { body: { username: 'admin', password: 'x' } });
    const r = await call('POST', '/api/v1/auth/login', { body: { username: 'admin', password: 'outband' } });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('900');
  });
});

describe('mock: devices and power', () => {
  it('lists {items,next_cursor} with last-segment ids and pages with cursors', async () => {
    const c = await signIn();
    const p1 = await call('GET', '/api/v1/devices?limit=4', { cookie: c });
    expect(p1.json.items).toHaveLength(4);
    expect(p1.json.next_cursor).toBeTruthy();
    const p2 = await call('GET', `/api/v1/devices?limit=4&cursor=${p1.json.next_cursor}`, { cookie: c });
    expect(p2.json.items).toHaveLength(2);
    expect(p2.json.next_cursor).toBeNull();
  });
  it('graceful by default, hard only with via=amt; 202 with action_id and paths', async () => {
    const c = await signIn();
    const a = await call('POST', '/api/v1/devices/devWeb0100000001/power', { cookie: c, body: { action: 'off' } });
    expect(a.status).toBe(202);
    expect(a.json).toMatchObject({ action_id: expect.stringMatching(/^act_/), paths: ['agent'], status: 'dispatched' });
    const b = await call('POST', '/api/v1/devices/devWeb0100000001/power', { cookie: c, body: { action: 'off', via: 'amt' } });
    expect(b.json.paths).toEqual(['amt']);
  });
  it('409 not_reachable when the path cannot carry it, 403 forbidden with details.path when the right is missing', async () => {
    const c = await signIn();
    const r = await call('POST', '/api/v1/devices/devNas0100000002/power', { cookie: c, body: { action: 'off', via: 'amt' } });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('not_reachable');
    const g = await signIn('guest');
    const f = await call('POST', '/api/v1/devices/devWeb0100000001/power', { cookie: g, body: { action: 'off', via: 'amt' } });
    expect(f.status).toBe(403);
    expect(f.json.error).toMatchObject({ code: 'forbidden', details: { path: 'amt' } });
  });
  it('Idempotency-Key: same body replays, different body conflicts', async () => {
    const c = await signIn();
    const idemKey = ['retry', 'test', Date.now()].join('-');
    const send = (action: string) => call('POST', '/api/v1/devices/devWeb0100000001/power', { cookie: c, body: { action }, headers: { 'Idempotency-Key': idemKey } });
    const a = await send('off');
    const b = await send('off');
    expect(b.json.action_id).toBe(a.json.action_id);
    expect((await send('reset')).json.error.code).toBe('idempotency_conflict');
  });
  it('429 after 6 power actions a minute on one device', async () => {
    const c = await signIn();
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await call('POST', '/api/v1/devices/devWeb0100000001/power', { cookie: c, body: { action: 'reset' } })).status;
    expect(last).toBe(429);
  });
  it('device events page newest first', async () => {
    const c = await signIn();
    const p1 = await call('GET', '/api/v1/devices/devWeb0100000001/events?limit=25', { cookie: c });
    expect(p1.json.items).toHaveLength(25);
    const p2 = await call('GET', `/api/v1/devices/devWeb0100000001/events?limit=25&cursor=${p1.json.next_cursor}`, { cookie: c });
    expect(p2.json.items[0].id).not.toBe(p1.json.items[24].id);
  });
});

describe('mock: tokens and step-up', () => {
  const create = (cookie: string, body: unknown) => call('POST', '/api/v1/auth/tokens', { cookie, body });
  it('read-only needs no step-up; power does, once the sign-in is stale', async () => {
    const c = await signIn('ops');
    expect((await create(c, { name: 'r', scopes: ['read'] })).status).toBe(201);
    expect((await create(c, { name: 'p', profile: 'device_power' })).status).toBe(201); // fresh sign-in counts
    await hook('age-session');
    expect((await create(c, { name: 'r2', scopes: ['read', 'identity'] })).status).toBe(201);
    const stale = await create(c, { name: 'p2', profile: 'device_power' });
    expect(stale.status).toBe(401);
    expect(stale.json.error.code).toBe('reauth_required');
    expect((await create(c, { name: 'a', scopes: ['audit'] })).json.error.code).toBe('reauth_required');
    // Step-up on the same session: password (202: code needed), wrong code, right code (204). No new cookie.
    expect((await call('POST', '/api/v1/auth/reauth', { cookie: c, body: { password: 'nope' } })).json.error.code).toBe('invalid_credentials');
    const pw = await call('POST', '/api/v1/auth/reauth', { cookie: c, body: { password: 'outband' } });
    expect(pw.status).toBe(202);
    expect(pw.json.twofa.required).toBe(true);
    expect(pw.cookie).toBeUndefined();
    expect((await create(c, { name: 'p2', profile: 'device_power' })).json.error.code).toBe('reauth_required'); // not done yet
    expect((await call('POST', '/api/v1/auth/reauth', { cookie: c, body: { code: '000000' } })).json.error.code).toBe('invalid_code');
    expect((await call('POST', '/api/v1/auth/reauth', { cookie: c, body: { code: '123456' } })).status).toBe(204);
    expect((await create(c, { name: 'p2', profile: 'device_power' })).status).toBe(201);
  });
  it('reauth needs a session, and works without a second factor for users who have none', async () => {
    expect((await call('POST', '/api/v1/auth/reauth', { body: { password: 'outband' } })).status).toBe(401);
    const c = await signIn('admin');
    await hook('age-session');
    expect((await call('POST', '/api/v1/auth/reauth', { cookie: c, body: { password: 'outband' } })).status).toBe(204);
    expect((await create(c, { name: 'p', profile: 'device_power' })).status).toBe(201);
  });
  it('shows the secret once; lists without it; revoke keeps the row', async () => {
    const c = await signIn();
    const made = await create(c, { name: 'auto', profile: 'device_power', expires_in_days: 30 });
    expect(made.json.secret).toMatch(/^obt_[A-Za-z0-9_-]{43}$/);
    const list = await call('GET', '/api/v1/auth/tokens', { cookie: c });
    expect(JSON.stringify(list.json)).not.toContain(made.json.secret);
    expect(list.json.items[0]).toMatchObject({ scopes: ['read', 'power_on', 'power_off'], revoked_at: null });
    expect((await call('DELETE', `/api/v1/auth/tokens/${made.json.token.id}`, { cookie: c })).status).toBe(204);
    const after = await call('GET', '/api/v1/auth/tokens', { cookie: c });
    expect(after.json.items[0].revoked_at).toBeTruthy();
    expect((await call('DELETE', '/api/v1/auth/tokens/tok_nonexistent', { cookie: c })).status).toBe(404);
  });
  it('enforces lifetime limits, console groups, one of scopes/profile, unknown fields', async () => {
    const c = await signIn();
    const bad = async (b: unknown) => (await create(c, b)).json.error?.code;
    expect(await bad({ name: 'x', scopes: ['read', 'audit'], expires_in_days: 91 })).toBe('invalid_request');
    expect(await bad({ name: 'x', scopes: ['console'], expires_in_days: 30 })).toBe('invalid_request');
    expect(await bad({ name: 'x', scopes: ['read'], profile: 'device_power' })).toBe('invalid_request');
    expect(await bad({ name: 'x', scopes: ['read'], extra: 1 })).toBe('invalid_request');
  });
  it('409 token_limit at 50 live tokens', async () => {
    const c = await signIn();
    for (let i = 0; i < 50; i++) expect((await create(c, { name: `t${i}`, scopes: ['read'] })).status).toBe(201);
    expect((await create(c, { name: 'one-more', scopes: ['read'] })).json.error.code).toBe('token_limit');
  });
});

describe('mock: stream', () => {
  async function open(cookie: string, path = '/api/v1/stream', headers: Record<string, string> = {}) {
    const ctl = new AbortController();
    const res = await fetch(base + path, { headers: { Cookie: cookie, ...headers }, signal: ctl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    return {
      async until(re: RegExp) {
        for (let i = 0; i < 50 && !re.test(buf); i++) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value);
        }
        return buf;
      },
      close: () => ctl.abort(),
    };
  }
  it('sends retry first, then ready, then envelopes whose type equals event:, including an unknown type', async () => {
    const c = await signIn();
    const s = await open(c);
    const first = await s.until(/event: ready/);
    expect(first.startsWith('retry: 5000')).toBe(true);
    await hook('unknown');
    await hook('emit', { id: 'devWeb0100000001', power: 'off' });
    const out = await s.until(/event: device\.power/);
    expect(out).toContain('event: device.firmware');
    expect(out).toContain('"type":"device.firmware"');
    expect(out).toMatch(/event: device\.power\nid: \d+\ndata: \{"type":"device\.power","data":\{"id":"devWeb0100000001","power":\{"state":"off"/);
    s.close();
  });
  it('always sends ready, ignores unknown type names in ?types=, and resumes with last_event_id', async () => {
    const c = await signIn();
    const s = await open(c, '/api/v1/stream?types=device.power,nonsense');
    await s.until(/event: ready/);
    await hook('emit', { id: 'devWeb0100000001', power: 'sleep' });
    const seen = await s.until(/device\.power/);
    const id = /id: (\d+)\ndata: \{"type":"device.power"/.exec(seen)![1];
    s.close();
    await hook('emit', { id: 'devWeb0100000001', power: 'on' });
    const r = await open(c, `/api/v1/stream?last_event_id=${id}`);
    const replay = await r.until(/"state":"on"/);
    expect(replay).toContain('event: ready');
    expect(replay).toContain('"state":"on"');
    r.close();
  });
});
