/** Typed calls to /api/v1, returning UI-model objects. */
import { request } from './http';
import { adaptDevice, adaptDeviceDetail, adaptEvent, adaptGroup, type WireDevice, type WireDeviceDetail, type WireEvent, type WireGroup } from './adapt';
import type { components } from './schema';
import type { Device, DeviceDetail, DeviceEvent, Group, PowerKind } from '../model/device';

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

export async function listDeviceEvents(id: string, limit = 25, signal?: AbortSignal): Promise<DeviceEvent[]> {
  const page = await request<Page<WireEvent>>('GET', `${API}/devices/${enc(id)}/events`, { query: { limit }, signal });
  return page.items.map(adaptEvent);
}

export type PowerResult = components['schemas']['PowerResult'];

export function powerAction(id: string, action: PowerKind): Promise<PowerResult> {
  return request<PowerResult>('POST', `${API}/devices/${enc(id)}/power`, { body: { action } });
}

export const streamUrl = `${API}/stream`;
