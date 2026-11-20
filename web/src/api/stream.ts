/**
 * Live updates over Server-Sent Events, with our own reconnect policy.
 *
 * The browser's EventSource retries by itself, but with a fixed delay and no
 * way to observe it. We close on error and reopen with exponential backoff,
 * passing the last seen event id so the server can replay what we missed.
 */
import { backoffDelay, type BackoffOptions } from './backoff';

export type StreamStatus = 'idle' | 'connecting' | 'live' | 'down';

export interface StreamMessage {
  type: string;
  data: unknown;
  id: string | null;
}

/** The subset of EventSource we use, so tests can inject a fake. */
export interface EventSourceLike {
  onopen: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface StreamOptions {
  url: string;
  /** Named SSE event types to listen for, in addition to unnamed `message`. */
  events?: string[];
  onMessage: (msg: StreamMessage) => void;
  onStatus?: (status: StreamStatus) => void;
  /** Query parameter used to resume after a reconnect (default `last_event_id`). */
  resumeParam?: string;
  /**
   * Called when the stream is live again after a drop. Resume is best effort,
   * so callers should refetch anything they cannot afford to miss.
   */
  onReconnect?: () => void;
  /** After this many failed attempts in a row, report `down` (still retrying). */
  downAfter?: number;
  /**
   * EventSource hides the HTTP status of a failed connect, so after an error
   * we ask this probe (e.g. GET /session) whether to go on: `retry: false`
   * stops for good (signed out, 403), and `afterMs` (a Retry-After) is a
   * minimum wait. A probe that throws counts as retry.
   */
  probe?: () => Promise<{ retry: boolean; afterMs?: number }>;
  /** The backoff resets only after a stream has stayed open this long (default 60 s). */
  stableMs?: number;
  backoff?: BackoffOptions;
  factory?: EventSourceFactory;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface Stream {
  readonly status: () => StreamStatus;
  /** Reconnect now (e.g. the tab became visible again). */
  kick(): void;
  close(): void;
}

const defaultFactory: EventSourceFactory = (url) =>
  new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike;

export function parseData(raw: string): unknown {
  if (raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function createStream(opts: StreamOptions): Stream {
  const factory = opts.factory ?? defaultFactory;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const downAfter = opts.downAfter ?? 4;
  const resumeParam = opts.resumeParam ?? 'last_event_id';
  let everLive = false;

  let status: StreamStatus = 'idle';
  let source: EventSourceLike | null = null;
  let timer: unknown = null;
  let attempt = 0;
  let stableTimer: unknown = null;
  const stableMs = opts.stableMs ?? 60_000;
  const clearStable = () => {
    if (stableTimer !== null) clearTimer(stableTimer);
    stableTimer = null;
  };
  let lastId: string | null = null;
  let closed = false;

  const setStatus = (s: StreamStatus) => {
    if (s === status) return;
    status = s;
    opts.onStatus?.(s);
  };

  const url = () => {
    if (!lastId) return opts.url;
    const sep = opts.url.includes('?') ? '&' : '?';
    return `${opts.url}${sep}${encodeURIComponent(resumeParam)}=${encodeURIComponent(lastId)}`;
  };

  const deliver = (type: string) => (ev: MessageEvent) => {
    if (ev.lastEventId) lastId = ev.lastEventId;
    opts.onMessage({ type, data: parseData(typeof ev.data === 'string' ? ev.data : ''), id: ev.lastEventId || null });
  };

  const open = () => {
    timer = null;
    if (closed) return;
    if (status !== 'down') setStatus('connecting');
    const es = factory(url());
    source = es;
    es.onopen = () => {
      if (source !== es) return;
      clearStable();
      stableTimer = setTimer(() => {
        stableTimer = null;
        attempt = 0;
      }, stableMs);
      setStatus('live');
      if (everLive) opts.onReconnect?.();
      everLive = true;
    };
    es.onerror = () => {
      if (source !== es) return;
      clearStable();
      es.close();
      source = null;
      if (!opts.probe) return scheduleRetry();
      void opts
        .probe()
        .catch(() => ({ retry: true }) as { retry: boolean; afterMs?: number })
        .then((r) => {
          if (closed) return;
          if (!r.retry) {
            setStatus('down');
            return;
          }
          scheduleRetry(r.afterMs ?? 0);
        });
    };
    es.onmessage = deliver('message');
    for (const type of opts.events ?? []) es.addEventListener(type, deliver(type));
  };

  const scheduleRetry = (minMs = 0) => {
    if (closed) return;
    attempt += 1;
    setStatus(attempt >= downAfter ? 'down' : 'connecting');
    timer = setTimer(open, Math.max(minMs, backoffDelay(attempt - 1, opts.backoff)));
  };

  open();

  return {
    status: () => status,
    kick() {
      if (closed || source) return;
      if (timer !== null) clearTimer(timer);
      open();
    },
    close() {
      closed = true;
      clearStable();
      if (timer !== null) clearTimer(timer);
      timer = null;
      source?.close();
      source = null;
      setStatus('idle');
    },
  };
}
