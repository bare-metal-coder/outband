import { describe, expect, it } from 'vitest';
import { createStream, parseData, type EventSourceLike } from '../src/api/stream';
import { backoffDelay } from '../src/api/backoff';

class FakeES implements EventSourceLike {
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  listeners = new Map<string, (ev: MessageEvent) => void>();
  closed = false;
  constructor(public url: string) {}
  addEventListener(type: string, l: (ev: MessageEvent) => void) {
    this.listeners.set(type, l);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: string, id = '') {
    const ev = { data, lastEventId: id } as MessageEvent;
    (type === 'message' ? this.onmessage : this.listeners.get(type))?.(ev);
  }
}

function harness(extra: Partial<Parameters<typeof createStream>[0]> = {}) {
  const sources: FakeES[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const statuses: string[] = [];
  const msgs: unknown[] = [];
  let reconnects = 0;
  const s = createStream({
    url: '/api/v1/stream',
    events: ['device.power'],
    factory: (u) => {
      const es = new FakeES(u);
      sources.push(es);
      return es;
    },
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => {},
    backoff: { random: () => 0 },
    onStatus: (x) => statuses.push(x),
    onMessage: (m) => msgs.push(m),
    onReconnect: () => reconnects++,
    ...extra,
  });
  return { s, sources, timers, statuses, msgs, reconnects: () => reconnects };
}

describe('backoff', () => {
  it('grows exponentially and caps', () => {
    const r = { random: () => 1, baseMs: 500, maxMs: 4000 };
    expect([0, 1, 2, 3, 4, 10].map((a) => backoffDelay(a, r))).toEqual([500, 1000, 2000, 4000, 4000, 4000]);
    expect(backoffDelay(0, { random: () => 0 })).toBe(250);
  });
});

describe('stream', () => {
  it('parses JSON data and keeps plain text', () => {
    expect(parseData('{"a":1}')).toEqual({ a: 1 });
    expect(parseData('hi')).toBe('hi');
    expect(parseData('')).toBeNull();
  });

  it('goes live, delivers named events, and resumes with last_event_id after an error', () => {
    const h = harness();
    expect(h.statuses).toEqual(['connecting']);
    h.sources[0]!.onopen?.(new Event('open'));
    expect(h.s.status()).toBe('live');
    h.sources[0]!.emit('device.power', '{"type":"device.power","data":{"id":"x"}}', '41');
    expect(h.msgs).toEqual([{ type: 'device.power', data: { type: 'device.power', data: { id: 'x' } }, id: '41' }]);

    h.sources[0]!.onerror?.(new Event('error'));
    expect(h.sources[0]!.closed).toBe(true);
    expect(h.s.status()).toBe('connecting');
    expect(h.timers).toHaveLength(1);
    h.timers[0]!.fn();
    expect(h.sources[1]!.url).toBe('/api/v1/stream?last_event_id=41');
    h.sources[1]!.onopen?.(new Event('open'));
    expect(h.reconnects()).toBe(1);
  });

  it('reports down after repeated failures and backs off further each time', () => {
    const h = harness({ downAfter: 3 });
    for (let i = 0; i < 3; i++) {
      h.sources[i]!.onerror?.(new Event('error'));
      h.timers[i]!.fn();
    }
    expect(h.timers.map((t) => t.ms)).toEqual([250, 500, 1000]);
    expect(h.statuses).toContain('down');
    h.sources[3]!.onopen?.(new Event('open'));
    expect(h.s.status()).toBe('live');
  });

  it('close stops retries and ignores late callbacks', () => {
    const h = harness();
    const first = h.sources[0]!;
    h.s.close();
    expect(first.closed).toBe(true);
    first.onerror?.(new Event('error'));
    expect(h.timers).toHaveLength(0);
    expect(h.s.status()).toBe('idle');
  });
});
