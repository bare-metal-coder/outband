import { describe, expect, it } from 'vitest';
import { adaptDevice, adaptStream, adaptPower, adaptAmt } from '../src/api/adapt';
import { availableActions, filterDevices, reach, relativeTime } from '../src/model/device';
import { match } from '../src/route-match';
import { devices as wire } from '../mock/fixtures.mjs';

const [web, nas, amtOnly, old] = wire.map((w: unknown) => adaptDevice(w as Parameters<typeof adaptDevice>[0]));

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
  it('maps a wire device', () => {
    expect(web).toMatchObject({ name: 'web01', online: true, power: 'on', groupName: 'Lab', amt: { state: 'reachable', via: 'local' } });
  });
  it('maps stream messages', () => {
    expect(adaptStream('device.power', { type: 'device.power', data: { id: 'a', power: { state: 'off' } } })).toEqual({ kind: 'power', id: 'a', power: 'off' });
    expect(adaptStream('device.removed', { type: 'device.removed', data: { id: 'a' } })).toEqual({ kind: 'removed', id: 'a' });
    expect(adaptStream('resync', { type: 'resync', data: {} })).toEqual({ kind: 'resync' });
    expect(adaptStream('nope', {})).toBeNull();
  });
});

describe('power actions', () => {
  const kinds = (d: typeof web) => availableActions(d!).map((a) => `${a.kind}:${a.channel}`);
  it('running agent + AMT: graceful agent off/reset, AMT cycle, no power on', () => {
    expect(kinds(web)).toEqual(['sleep:agent', 'reset:agent', 'cycle:amt', 'off:agent']);
  });
  it('AMT-only machine that is off: power on or wake', () => {
    expect(kinds(amtOnly)).toEqual(['on:amt', 'wake:wol']);
    const onNow = { ...amtOnly!, power: 'on' as const };
    expect(kinds(onNow)).toEqual(['reset:amt', 'cycle:amt', 'off:amt']);
    expect(availableActions(onNow).find((a) => a.kind === 'off')).toMatchObject({ label: 'Power off (hard)', destructive: true });
  });
  it('offline machine: only wake', () => {
    expect(kinds(old)).toEqual(['wake:wol']);
  });
  it('never offers what the server does not allow', () => {
    expect(kinds({ ...nas!, can: { power: [], console: [] } })).toEqual([]);
  });
});

describe('filtering', () => {
  const all = [web!, nas!, amtOnly!, old!];
  it('derives reach', () => {
    expect(all.map(reach)).toEqual(['online', 'online', 'oob', 'offline']);
  });
  it('filters by text and reach', () => {
    expect(filterDevices(all, 'ubuntu', 'all').map((d) => d.name)).toEqual(['web01']);
    expect(filterDevices(all, '10.0.0.2', 'all').map((d) => d.name)).toEqual(['amt-node01']);
    expect(filterDevices(all, '', 'oob').map((d) => d.name)).toEqual(['amt-node01']);
    expect(filterDevices(all, 'lab', 'online').map((d) => d.name)).toEqual(['web01', 'nas01']);
  });
  it('formats relative time', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    expect(relativeTime('2026-01-01T11:59:50Z', now)).toBe('just now');
    expect(relativeTime('2026-01-01T11:55:00Z', now)).toBe('5m ago');
    expect(relativeTime('2026-01-01T09:00:00Z', now)).toBe('3h ago');
    expect(relativeTime(null, now)).toBe('never');
  });
});

describe('route matching', () => {
  it('matches params and optional segments', () => {
    expect(match('/devices/:id/:tab?', '/devices/abc')).toEqual({ id: 'abc' });
    expect(match('/devices/:id/:tab?', '/devices/a%40b/events')).toEqual({ id: 'a@b', tab: 'events' });
    expect(match('/devices/:id', '/devices')).toBeNull();
    expect(match('/', '/x')).toBeNull();
  });
});
