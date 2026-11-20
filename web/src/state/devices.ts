/**
 * Device store: one fetch of groups and devices, then live updates from the
 * SSE stream. Rows update in place (fine-grained), so a power change on one
 * device re-renders only its lights.
 */
import { batch, createMemo, createSignal } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { adaptStream, STREAM_TYPES, type LiveUpdate } from '../api/adapt';
import { ApiError } from '../api/http';
import { getSession } from '../api/auth';
import { createStream, type Stream, type StreamStatus } from '../api/stream';
import { listAllDevices, listGroups, streamUrl } from '../api/v1';
import type { Device, DeviceEvent, Group } from '../model/device';

interface State {
  byId: Record<string, Device>;
  groups: Record<string, Group>;
}

const [state, setState] = createStore<State>({ byId: {}, groups: {} });
const [loaded, setLoaded] = createSignal(false);
const [loadError, setLoadError] = createSignal<string | null>(null);
const [streamStatus, setStreamStatus] = createSignal<StreamStatus>('idle');

export { loaded, loadError, streamStatus };

export const devices = createMemo(() =>
  Object.values(state.byId).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
);
export const groups = createMemo(() => Object.values(state.groups).sort((a, b) => a.name.localeCompare(b.name)));
export const deviceById = (id: string): Device | undefined => state.byId[id];
export const groupName = (id: string): string => state.groups[id]?.name ?? '';

type EventListener = (e: DeviceEvent) => void;
const eventListeners = new Set<EventListener>();
export function onLiveEvent(fn: EventListener): () => void {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

let onClosed: (reason: string, terminal: boolean) => void = () => {};
export function setClosedHandler(fn: (reason: string, terminal: boolean) => void): void {
  onClosed = fn;
}

export async function reload(): Promise<void> {
  try {
    const [g, d] = await Promise.all([listGroups(), listAllDevices()]);
    batch(() => {
      setState('groups', reconcile(Object.fromEntries(g.map((x) => [x.id, x]))));
      setState('byId', reconcile(Object.fromEntries(d.map((x) => [x.id, x]))));
      setLoadError(null);
      setLoaded(true);
    });
  } catch (err) {
    if (err instanceof ApiError && err.credentialEnded) return onUnauthorized();
    setLoadError(err instanceof Error ? err.message : 'Could not load devices');
    setLoaded(true);
  }
}

/** Merge a single device (e.g. from a detail fetch) into the store. */
export function upsertDevice(d: Device): void {
  setState('byId', d.id, reconcile(d));
}

export function apply(u: LiveUpdate): void {
  switch (u.kind) {
    case 'device':
      upsertDevice(u.device);
      break;
    case 'power':
      if (state.byId[u.id]) batch(() => {
        setState('byId', u.id, 'power', u.power);
        setState('byId', u.id, 'powerSince', u.since);
      });
      break;
    case 'removed':
      setState('byId', u.id, undefined as unknown as Device);
      break;
    case 'event':
      for (const fn of eventListeners) fn(u.event);
      break;
    case 'resync':
      void reload();
      break;
    case 'closed':
      // Terminal reasons (revoked, expired, locked, logout): stop for good. Others are retried with backoff.
      if (u.terminal) stream?.close();
      onClosed(u.reason, u.terminal);
      break;
    case 'ready':
      break;
  }
}

let stream: Stream | null = null;

export function start(): void {
  if (stream) return;
  void reload();
  stream = createStream({
    url: streamUrl,
    events: [...STREAM_TYPES],
    onStatus: setStreamStatus,
    // After a failed connect: signed out (401 unauthenticated) means stop and go to login; 429/503 honour Retry-After.
    probe: async () => {
      try {
        const s = await getSession();
        if (!s.authenticated) {
          onUnauthorized();
          return { retry: false };
        }
        return { retry: true };
      } catch (err) {
        if (err instanceof ApiError && err.credentialEnded) {
          onUnauthorized();
          return { retry: false };
        }
        if (err instanceof ApiError && err.status === 403) return { retry: false };
        return { retry: true, afterMs: err instanceof ApiError && err.retryAfter ? err.retryAfter * 1000 : 0 };
      }
    },
    onReconnect: () => void reload(),
    onMessage: (m) => {
      const u = adaptStream(m.data);
      if (u) apply(u);
    },
  });
  document.addEventListener('visibilitychange', kick);
}

function kick() {
  if (document.visibilityState === 'visible') stream?.kick();
}

export function stop(): void {
  stream?.close();
  stream = null;
  document.removeEventListener('visibilitychange', kick);
  batch(() => {
    setState({ byId: {}, groups: {} });
    setLoaded(false);
    setLoadError(null);
  });
}
