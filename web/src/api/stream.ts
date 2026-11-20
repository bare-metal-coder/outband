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
      attempt = 0;
      setStatus('live');
      if (everLive) opts.onReconnect?.();
      everLive = true;
    };
    es.onerror = () => {
      if (source !== es) return;
      es.close();
      source = null;
      scheduleRetry();
    };
    es.onmessage = deliver('message');
    for (const type of opts.events ?? []) es.addEventListener(type, deliver(type));
  };

  const scheduleRetry = () => {
    if (closed) return;
    attempt += 1;
    setStatus(attempt >= downAfter ? 'down' : 'connecting');
    timer = setTimer(open, backoffDelay(attempt - 1, opts.backoff));
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
      if (timer !== null) clearTimer(timer);
      timer = null;
      source?.close();
      source = null;
      setStatus('idle');
    },
  };
}
