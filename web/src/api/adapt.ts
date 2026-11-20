/**
 * The only place that knows the /api/v1 wire shapes. Everything else uses
 * the UI model in src/model/device.ts. The spec is still a draft, so changes
 * should only need edits here.
 *
 * Per the spec, unknown fields are ignored and unknown enum values are
 * treated as "unknown".
 */
import type { components } from './schema';
import type { AmtState, Device, DeviceDetail, DeviceEvent, Group, Power, PowerKind } from '../model/device';

type S = components['schemas'];
export type WireDevice = S['Device'];
export type WireDeviceDetail = S['DeviceDetail'];
export type WireGroup = S['Group'];
export type WireEvent = S['Event'];

const POWER_KINDS: readonly PowerKind[] = ['on', 'off', 'reset', 'cycle', 'sleep', 'wake'];

export function adaptPower(state: string | undefined | null): Power {
  switch (state) {
    case 'on':
      return 'on';
    case 'sleep':
    case 'hibernate':
      return 'sleep';
    case 'soft_off':
    case 'off':
      return 'off';
    default:
      return 'unknown';
  }
}

export function adaptAmt(amt: WireDevice['amt'] | undefined): AmtState {
  if (!amt) return 'unknown';
  switch (amt.state) {
    case 'none':
      return 'none';
    case 'unprovisioned':
    case 'provisioning':
      return 'unprovisioned';
    case 'provisioned':
      return amt.reachable ? 'reachable' : 'unreachable';
    default:
      return amt.reachable ? 'reachable' : 'unknown';
  }
}

export function adaptDevice(w: WireDevice): Device {
  const conn = w.connectivity;
  return {
    id: w.id,
    name: w.name || w.host || w.id,
    host: w.host ?? null,
    groupId: w.group?.id ?? '',
    groupName: w.group?.name ?? '',
    os: w.os ?? null,
    ips: Array.isArray(w.ips) ? w.ips : [],
    online: Boolean(w.online),
    amt: {
      state: adaptAmt(w.amt),
      version: w.amt?.version ?? null,
      via: conn?.amt_cira ? 'cira' : conn?.amt_local ? 'local' : null,
    },
    power: adaptPower(w.power?.state),
    powerSince: w.power?.since ?? null,
    lastSeen: w.last_seen ?? null,
    can: {
      power: (w.capabilities?.power ?? []).filter((k): k is PowerKind => POWER_KINDS.includes(k as PowerKind)),
      console: [...(w.capabilities?.console ?? [])],
    },
  };
}

export function adaptDeviceDetail(w: WireDeviceDetail): DeviceDetail {
  const hw = w.hardware;
  return {
    ...adaptDevice(w),
    description: w.description ?? null,
    tags: w.tags ?? [],
    agentVersion: w.agent?.version ?? null,
    hardware: hw
      ? {
          manufacturer: hw.manufacturer ?? null,
          model: hw.model ?? null,
          serial: hw.serial ?? null,
          cpu: hw.cpu ?? null,
          memoryMb: hw.memory_mb ?? null,
        }
      : null,
  };
}

export function adaptGroup(w: WireGroup): Group {
  return { id: w.id, name: w.name, description: w.description ?? '', kind: w.kind, deviceCount: w.device_count ?? 0 };
}

export function adaptEvent(w: WireEvent): DeviceEvent {
  return {
    id: w.id,
    time: w.time,
    action: w.action,
    message: w.message,
    user: w.user?.name ?? null,
    deviceId: w.device_id ?? null,
  };
}

/** Stream messages after adaptation. */
export type LiveUpdate =
  | { kind: 'device'; device: Device }
  | { kind: 'power'; id: string; power: Power }
  | { kind: 'removed'; id: string }
  | { kind: 'event'; event: DeviceEvent }
  | { kind: 'resync' }
  | { kind: 'ready' };

export const STREAM_TYPES = ['ready', 'device.updated', 'device.power', 'device.removed', 'event.created', 'resync'];

/** Map one SSE message (`event:` type + JSON `StreamEvent` data) to a LiveUpdate. */
export function adaptStream(type: string, data: unknown): LiveUpdate | null {
  const env = data && typeof data === 'object' ? (data as { type?: string; data?: unknown }) : null;
  const t = env?.type ?? type;
  const body = (env && 'data' in env ? env.data : data) as Record<string, unknown> | null;
  switch (t) {
    case 'ready':
      return { kind: 'ready' };
    case 'resync':
      return { kind: 'resync' };
    case 'device.updated':
      return body && typeof body.id === 'string' ? { kind: 'device', device: adaptDevice(body as unknown as WireDevice) } : null;
    case 'device.power': {
      if (!body || typeof body.id !== 'string') return null;
      const p = body.power;
      const state = typeof p === 'string' ? p : (p as { state?: string } | undefined)?.state;
      return { kind: 'power', id: body.id, power: adaptPower(state) };
    }
    case 'device.removed':
      return body && typeof body.id === 'string' ? { kind: 'removed', id: body.id } : null;
    case 'event.created':
      return body && typeof body.id === 'string' ? { kind: 'event', event: adaptEvent(body as unknown as WireEvent) } : null;
    default:
      return null;
  }
}
