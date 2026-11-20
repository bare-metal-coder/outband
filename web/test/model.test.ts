import { describe, expect, it } from 'vitest';
import { adaptAmt, adaptDevice, adaptEvent, adaptPower, adaptStream, adaptToken, isKnownStreamType, STREAM_TYPES } from '../src/api/adapt';
import { availableActions, filterDevices, filtersFromSearch, filtersToSearch, NO_FILTERS, reach, relativeTime, sections } from '../src/model/device';
import { createBody, maxDays, needsStepUp, tokenStatus, validateTokenForm, type TokenForm } from '../src/model/token';
import { match } from '../src/route-match';
import { users, wireDevice, makeFixtures } from '../mock/fixtures.mjs';

const fx = makeFixtures();
const wire = (name: string, user: { deny: string[] } = users.admin) => wireDevice(fx.devices.find((d: { name: string }) => d.name === name), user);
const dev = (name: string, user: { deny: string[] } = users.admin) => adaptDevice(wire(name, user) as Parameters<typeof adaptDevice>[0]);
const [web, nas, amtOnly, old, edge] = ['web01', 'nas01', 'amt-node01', 'old-desktop', 'edge-gw'].map((n) => dev(n));

describe('adapt', () => {
  it('maps power states, treating unknown values as unknown', () => {
    expect(['on', 'sleep', 'hibernate', 'soft_off', 'off', 'present', 'bogus', undefined].map(adaptPower)).toEqual([
      'on', 'sleep', 'sleep', 'off', 'off', 'unknown', 'unknown', 'unknown',
    ]);
  });
  it('maps AMT state and reachability', () => {
    expect(adaptAmt({ state: 'provisioned', version: '1', reachable: true })).toBe('reachable');
    expect(adaptAmt({ state: 'provisioned', version: '1', reachable: false })).toBe('unreachable');
    expect(adaptAmt({ state: 'provisioning', version: null, reachable: false })).toBe('unprovisioned');
    expect(adaptAmt({ state: 'none', version: null, reachable: false })).toBe('none');
  });
  it('maps a wire device with capabilities and paths', () => {
    expect(web).toMatchObject({ name: 'web01', online: true, power: 'on', groupName: 'Lab', amt: { state: 'reachable', via: 'local' } });
    expect(web!.can.via.off).toEqual(['agent']);
    expect(web!.can.paths.off).toEqual(['agent', 'amt']);
  });
  it('copes with absent ips and unknown enum values', () => {
    const w = { ...wire('web01'), ips: undefined, capabilities: { power: ['off', 'levitate'], power_via: { off: ['agent'], levitate: ['agent'], reset: ['carrier-pigeon'] }, power_paths: { off: ['agent', 'telepathy'] }, console: ['sol', 'x'] } };
    const d = adaptDevice(w as never);
    expect(d.ips).toEqual([]);
    expect(d.can).toEqual({ power: ['off'], via: { off: ['agent'], reset: [] }, paths: { off: ['agent'] }, console: ['sol', 'x'] });
  });
  it('hides a redacted actor and keeps the outcome', () => {
    const base = { id: 'e1', time: 't', type: 'node', action: 'a', message: 'm', token_id: null, token_name: null, device_id: null, group_id: null };
    expect(adaptEvent({ ...base, user: { id: 'u_3f9a1c2b', name: null, redacted: true }, outcome: 'denied' } as never)).toMatchObject({ user: null, redacted: true, outcome: 'denied' });
    expect(adaptEvent({ ...base, user: { id: 'alice', name: 'alice', redacted: false }, outcome: 'new-thing' } as never)).toMatchObject({ user: 'alice', outcome: null });
  });
  it('maps a token', () => {
    const t = adaptToken({ id: 'tok_x', name: 'n', owner: { id: 'a', name: 'a' }, prefix: 'obt_ABCD', scopes: ['read'], groups: null, allowed_ips: null, created_at: 'c', expires_at: '2999-01-01T00:00:00Z', last_used_at: null, revoked_at: null });
    expect(t).toMatchObject({ groupIds: null, lastUsedAt: null });
    expect(tokenStatus(t)).toBe('active');
    expect(tokenStatus({ ...t, revokedAt: 'x' })).toBe('revoked');
    expect(tokenStatus({ ...t, expiresAt: '2000-01-01T00:00:00Z' })).toBe('expired');
  });
});

describe('stream messages', () => {
  const env = (type: string, data: unknown) => ({ type, data });
  it('maps every known type from the envelope', () => {
    expect(adaptStream(env('device.power', { id: 'a', power: { state: 'off', since: 's' } }))).toEqual({ kind: 'power', id: 'a', power: 'off', since: 's' });
    expect(adaptStream(env('device.removed', { id: 'a' }))).toEqual({ kind: 'removed', id: 'a' });
    expect(adaptStream(env('resync', {}))).toEqual({ kind: 'resync' });
    expect(adaptStream(env('ready', { server_time: 't' }))).toEqual({ kind: 'ready' });
    expect(adaptStream(env('closed', { reason: 'logout' }))).toEqual({ kind: 'closed', reason: 'logout', terminal: true });
    for (const r of ['revoked', 'expired', 'locked']) expect(adaptStream(env('closed', { reason: r }))).toMatchObject({ terminal: true });
    for (const r of ['disabled', 'rights', 'shutdown', 'something-new']) expect(adaptStream(env('closed', { reason: r }))).toMatchObject({ terminal: false });
    expect(adaptStream(env('device.updated', wire('web01')))).toMatchObject({ kind: 'device', device: { name: 'web01' } });
  });
  it('ignores unknown types (StreamOther) and malformed messages', () => {
    expect(adaptStream(env('device.firmware', { id: 'a' }))).toBeNull();
    expect(adaptStream(env('', {}))).toBeNull();
    expect(adaptStream({ type: 5, data: {} })).toBeNull();
    expect(adaptStream('not json')).toBeNull();
    expect(adaptStream(null)).toBeNull();
    expect(adaptStream({ data: { id: 'a' } })).toBeNull();
  });
  it('narrows with an explicit known-type guard', () => {
    for (const t of STREAM_TYPES) expect(isKnownStreamType(t)).toBe(true);
    for (const t of ['device.firmware', 'READY', '', undefined, 3, null]) expect(isKnownStreamType(t)).toBe(false);
  });
});

describe('power actions (draft.6 capabilities)', () => {
  const kinds = (d: typeof web) => availableActions(d!).map((a) => `${a.kind}:${a.options.map((o) => o.via ?? 'default').join('+')}`);
  it('running agent + AMT: the default first (no via), then the AMT path as via=amt', () => {
    expect(kinds(web)).toEqual(['sleep:default', 'reset:default+amt', 'cycle:default', 'off:default+amt']);
    const off = availableActions(web!).find((a) => a.kind === 'off')!;
    expect(off.options.map((o) => o.label)).toEqual(['Shut down (agent)', 'Hard power off (Intel AMT)']);
    expect(off.options.map((o) => o.graceful)).toEqual([true, false]);
    expect(off.options.map((o) => o.via)).toEqual([null, 'amt']);
  });
  it('agent only (nas01): one graceful default; no AMT choice', () => {
    expect(kinds(nas)).toEqual(['sleep:default', 'reset:default', 'off:default']);
  });
  it('AMT-only machine that is off: power on, and wake with the default plus each single path', () => {
    expect(kinds(amtOnly)).toEqual(['on:default', 'wake:default+wol+amt']);
    const wake = availableActions(amtOnly!).find((a) => a.kind === 'wake')!;
    expect(wake.options.map((o) => o.label)).toEqual(['Wake (Wake-on-LAN + Intel AMT)', 'Wake (Wake-on-LAN)', 'Wake (Intel AMT)']);
    expect(wake.options[0]!.paths).toEqual(['wol', 'amt']);
  });
  it('default unavailable (agent offline, AMT reachable): off and reset are offered only through via=amt', () => {
    const onNow = { ...amtOnly!, power: 'on' as const };
    expect(onNow.can.power).not.toContain('off');
    expect(onNow.can.paths.off).toEqual(['amt']);
    expect(kinds(onNow)).toEqual(['reset:amt', 'cycle:default', 'off:amt']);
    const off = availableActions(onNow).find((a) => a.kind === 'off')!;
    expect(off.options).toHaveLength(1);
    expect(off.options[0]).toMatchObject({ via: 'amt', label: 'Hard power off (Intel AMT)', graceful: false });
    expect(off.destructive).toBe(true);
  });
  it('MQTT-only device: off is offered only as via=mqtt (spec draft.7)', () => {
    const m = { ...nas!, can: { power: [], via: {}, paths: { off: ['mqtt' as const] }, console: [] } };
    const off = availableActions(m).find((a) => a.kind === 'off')!;
    expect(off.options).toEqual([expect.objectContaining({ via: 'mqtt', label: 'Shut down (MQTT)' })]);
  });
  it('a user without the AMT right is never offered an AMT path', () => {
    expect(kinds(dev('web01', users.guest))).toEqual(['sleep:default', 'reset:default', 'off:default']);
  });
  it('offline machine: only wake. Sleeping machine: no sleep', () => {
    expect(kinds(old)).toEqual(['wake:default']);
    expect(kinds(edge)).toEqual(['wake:default', 'reset:default', 'off:default']);
  });
  it('never offers what the server does not allow; with no path info it sends no via', () => {
    expect(kinds({ ...nas!, can: { power: [], via: {}, paths: {}, console: [] } })).toEqual([]);
    const bare = availableActions({ ...nas!, can: { power: ['off'], via: {}, paths: {}, console: [] } });
    expect(bare[0]!.options).toHaveLength(1);
    expect(bare[0]!.options[0]).toMatchObject({ via: null, label: 'Shut down' });
  });
});

describe('filtering and sections', () => {
  const all = [web!, nas!, amtOnly!, old!, edge!];
  it('derives reach', () => {
    expect(all.map(reach)).toEqual(['online', 'online', 'oob', 'offline', 'online']);
  });
  it('filters by text, status and power', () => {
    const f = (o: Partial<typeof NO_FILTERS>) => filterDevices(all, { ...NO_FILTERS, ...o }).map((d) => d.name);
    expect(f({ query: 'ubuntu' })).toEqual(['web01']);
    expect(f({ query: '10.0.0.2' })).toEqual(['amt-node01']);
    expect(f({ status: 'amt' })).toEqual(['web01', 'amt-node01']);
    expect(f({ status: 'offline' })).toEqual(['amt-node01', 'old-desktop']);
    expect(f({ status: 'online', power: 'sleep' })).toEqual(['edge-gw']);
    expect(f({ power: 'off', query: 'desk' })).toEqual(['old-desktop']);
  });
  it('groups by group name', () => {
    expect(sections(all).map((s) => `${s.name}:${s.devices.length}`)).toEqual(['AMT only:1', 'Edge:1', 'Lab:3']);
  });
  it('round-trips filters through the URL', () => {
    const f = { query: 'web 01', status: 'amt' as const, power: 'on' as const };
    expect(filtersFromSearch(filtersToSearch(f))).toEqual(f);
    expect(filtersFromSearch('?status=bogus&power=x')).toEqual(NO_FILTERS);
    expect(filtersToSearch(NO_FILTERS)).toBe('');
  });
  it('formats relative time', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    expect(relativeTime('2026-01-01T11:59:50Z', now)).toBe('just now');
    expect(relativeTime('2026-01-01T11:55:00Z', now)).toBe('5m ago');
    expect(relativeTime('2026-01-01T09:00:00Z', now)).toBe('3h ago');
    expect(relativeTime(null, now)).toBe('never');
  });
});

describe('token form', () => {
  const form = (o: Partial<TokenForm> = {}): TokenForm => ({ name: 'ci', mode: 'profile', scopes: ['read'], groups: [], days: 90, ...o });
  it('applies the spec lifetime limits (audit joined the 90-day class in draft.5)', () => {
    expect(maxDays(['read', 'identity'])).toBe(365);
    expect(maxDays(['read', 'audit'])).toBe(90);
    expect(maxDays(['power_on'])).toBe(90);
    expect(maxDays(['console', 'power_on'])).toBe(30);
  });
  it('needs step-up for everything but read and identity', () => {
    expect(needsStepUp(['read', 'identity'])).toBe(false);
    expect(needsStepUp(['read', 'audit'])).toBe(true);
    expect(needsStepUp(['read', 'power_on'])).toBe(true);
  });
  it('validates', () => {
    expect(validateTokenForm(form())).toBeNull();
    expect(validateTokenForm(form({ name: ' ' }))).toMatch(/name/);
    expect(validateTokenForm(form({ mode: 'custom', scopes: [] }))).toMatch(/scope/);
    expect(validateTokenForm(form({ mode: 'custom', scopes: ['console'], days: 30 }))).toMatch(/group/);
    expect(validateTokenForm(form({ mode: 'custom', scopes: ['console'], groups: ['g'], days: 31 }))).toMatch(/30/);
    expect(validateTokenForm(form({ days: 91 }))).toMatch(/90/);
  });
  it('builds the request: profile or scopes, never both', () => {
    expect(createBody(form({ groups: ['g1'] }))).toEqual({ name: 'ci', expires_in_days: 90, profile: 'device_power', groups: ['g1'] });
    expect(createBody(form({ mode: 'custom', scopes: ['read', 'audit'], days: 10 }))).toEqual({ name: 'ci', expires_in_days: 10, scopes: ['read', 'audit'] });
  });
});

describe('route matching', () => {
  it('matches params and optional segments', () => {
    expect(match('/devices/:id/:tab?', '/devices/abc')).toEqual({ id: 'abc' });
    expect(match('/devices/:id/:tab?', '/devices/a%40b/events')).toEqual({ id: 'a@b', tab: 'events' });
    expect(match('/devices/:id', '/devices')).toBeNull();
    expect(match('/settings/:section?', '/settings/tokens')).toEqual({ section: 'tokens' });
    expect(match('/', '/x')).toBeNull();
  });
});
