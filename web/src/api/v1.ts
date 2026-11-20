/** Typed calls to /api/v1, returning UI-model objects. */
import { request } from './http';
import { adaptDevice, adaptDeviceDetail, adaptEvent, adaptGroup, adaptToken, type WireToken, type WireDevice, type WireDeviceDetail, type WireEvent, type WireGroup } from './adapt';
import type { components } from './schema';
import type { Channel, Device, DeviceDetail, DeviceEvent, Group, PowerKind } from '../model/device';
import type { ApiToken } from '../model/token';

export const API = '/api/v1';
const enc = encodeURIComponent;

interface Page<T> {
  items: T[];
  next_cursor?: string | null;
}

export async function listGroups(signal?: AbortSignal): Promise<Group[]> {
  const page = await request<Page<WireGroup>>('GET', `${API}/groups`, { signal });
  return page.items.map(adaptGroup);
}

/** Every visible device, following cursors (pages of 200). */
export async function listAllDevices(signal?: AbortSignal): Promise<Device[]> {
  const out: Device[] = [];
  let cursor: string | null | undefined;
  for (let i = 0; i < 100; i++) {
    const page = await request<Page<WireDevice>>('GET', `${API}/devices`, { query: { limit: 200, cursor }, signal });
    out.push(...page.items.map(adaptDevice));
    cursor = page.next_cursor;
    if (!cursor) break;
  }
  return out;
}

export async function getDevice(id: string, signal?: AbortSignal): Promise<DeviceDetail> {
  return adaptDeviceDetail(await request<WireDeviceDetail>('GET', `${API}/devices/${enc(id)}`, { signal }));
}

export interface EventsPage {
  items: DeviceEvent[];
  /** Pass to the next call; `null` on the last page. */
  next: string | null;
}

export async function listDeviceEvents(id: string, opts: { limit?: number; cursor?: string | null; signal?: AbortSignal } = {}): Promise<EventsPage> {
  const page = await request<Page<WireEvent>>('GET', `${API}/devices/${enc(id)}/events`, {
    query: { limit: opts.limit ?? 25, cursor: opts.cursor },
    signal: opts.signal,
  });
  return { items: page.items.map(adaptEvent), next: page.next_cursor ?? null };
}

export type PowerResult = components['schemas']['PowerResult'];

/** A fresh `Idempotency-Key`: lets a retry of the same action not dispatch twice. */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  c?.getRandomValues?.(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('') || String(Date.now());
}

/**
 * Dispatch a power action. `via` is sent only when the user picked one of
 * several paths; without it the server uses the action's default path.
 */
export function powerAction(id: string, action: PowerKind, opts: { via?: Channel; key?: string } = {}): Promise<PowerResult> {
  return request<PowerResult>('POST', `${API}/devices/${enc(id)}/power`, {
    body: opts.via ? { action, via: opts.via } : { action },
    headers: { 'Idempotency-Key': opts.key ?? newIdempotencyKey() },
  });
}

export async function listTokens(signal?: AbortSignal): Promise<ApiToken[]> {
  const out: ApiToken[] = [];
  let cursor: string | null | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await request<Page<WireToken>>('GET', `${API}/auth/tokens`, { query: { limit: 200, cursor }, signal });
    out.push(...page.items.map(adaptToken));
    cursor = page.next_cursor;
    if (!cursor) break;
  }
  return out;
}

export interface CreatedToken {
  token: ApiToken;
  /** Shown once, never again. */
  secret: string;
}

export async function createToken(body: Record<string, unknown>): Promise<CreatedToken> {
  const r = await request<{ token: WireToken; secret: string }>('POST', `${API}/auth/tokens`, { body });
  return { token: adaptToken(r.token), secret: r.secret };
}

export async function revokeToken(id: string): Promise<void> {
  await request<void>('DELETE', `${API}/auth/tokens/${enc(id)}`);
}

export const streamUrl = `${API}/stream`;
