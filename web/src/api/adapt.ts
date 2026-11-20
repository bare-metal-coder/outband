/**
 * The only place that knows the /api/v1 wire shapes. Everything else uses
 * the UI model in src/model/device.ts. The spec is still a draft, so changes
 * should only need edits here.
 *
 * Per the spec, unknown fields are ignored and unknown enum values are
 * treated as "unknown".
 */
import type { components } from './schema';
import type { AmtState, Channel, Device, DeviceDetail, DeviceEvent, Group, Power, PowerKind } from '../model/device';
import type { ApiToken } from '../model/token';

type S = components['schemas'];
export type WireDevice = S['Device'];
export type WireDeviceDetail = S['DeviceDetail'];
export type WireGroup = S['Group'];
export type WireEvent = S['Event'];
export type WireToken = S['ApiToken'];

const POWER_KINDS: readonly PowerKind[] = ['on', 'off', 'reset', 'cycle', 'sleep', 'wake'];
const CHANNELS: readonly Channel[] = ['agent', 'amt', 'wol', 'mqtt', 'ipkvm'];

const isKind = (k: string): k is PowerKind => POWER_KINDS.includes(k as PowerKind);
const isChannel = (c: unknown): c is Channel => CHANNELS.includes(c as Channel);

/** Open enums: unknown actions and paths are dropped, never guessed. */
function adaptCapabilities(c: WireDevice['capabilities'] | undefined): Device['can'] {
  const via: Device['can']['via'] = {};
  for (const [k, v] of Object.entries(c?.power_via ?? {})) if (isKind(k) && isChannel(v)) via[k] = v;
  const paths: Device['can']['paths'] = {};
  for (const [k, v] of Object.entries(c?.power_paths ?? {})) {
    if (isKind(k) && Array.isArray(v)) paths[k] = v.filter(isChannel);
  }
  return { power: (c?.power ?? []).filter(isKind), via, paths, console: [...(c?.console ?? [])] };
}

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
    can: adaptCapabilities(w.capabilities),
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
    // Without the `audit` scope the server sends a pseudonym and `redacted: true`.
    user: w.user ? (w.user.redacted ? null : (w.user.name ?? null)) : null,
    redacted: Boolean(w.user?.redacted),
    tokenName: w.token_name ?? null,
    outcome: w.outcome === 'success' || w.outcome === 'denied' || w.outcome === 'failed' ? w.outcome : null,
    deviceId: w.device_id ?? null,
  };
}

export function adaptToken(w: WireToken): ApiToken {
  return {
    id: w.id,
    name: w.name,
    prefix: w.prefix,
    scopes: [...w.scopes],
    groupIds: w.groups ? [...w.groups] : null,
    allowedIps: w.allowed_ips ? [...w.allowed_ips] : null,
    createdAt: w.created_at,
    expiresAt: w.expires_at,
    lastUsedAt: w.last_used_at ?? null,
    revokedAt: w.revoked_at ?? null,
  };
}

/** Stream messages after adaptation. */
export type LiveUpdate =
  | { kind: 'device'; device: Device }
  | { kind: 'power'; id: string; power: Power; since: string | null }
  | { kind: 'removed'; id: string }
  | { kind: 'event'; event: DeviceEvent }
  | { kind: 'resync' }
  | { kind: 'closed'; reason: string }
  | { kind: 'ready' };

/**
 * The stream message types this version of the spec defines. The set is open
 * (`StreamOther` stands for any other type), and the generated schema cannot
 * express "not one of these" (openapi-typescript drops `not: {enum}`), so we
 * narrow with an explicit guard before any switch.
 */
export const STREAM_TYPES = ['ready', 'device.updated', 'device.power', 'device.removed', 'event.created', 'resync', 'closed'] as const;
export type KnownStreamType = (typeof STREAM_TYPES)[number];

export const isKnownStreamType = (t: unknown): t is KnownStreamType => STREAM_TYPES.includes(t as KnownStreamType);

/**
 * Map one SSE message to a LiveUpdate. The `data:` line is the envelope
 * `{type, data}`; its `type` equals the SSE `event:` field and wins if they
 * differ. Types we do not know return null (the spec lets servers add some
 * within v1), so they are ignored.
 */
export function adaptStream(data: unknown): LiveUpdate | null {
  const env = data && typeof data === 'object' ? (data as { type?: unknown; data?: unknown }) : null;
  if (!env || typeof env.type !== 'string') return null;
  const t = env.type;
  if (!isKnownStreamType(t)) return null; // StreamOther: MUST be ignored
  const body = (env.data && typeof env.data === 'object' ? env.data : null) as Record<string, unknown> | null;
  switch (t) {
    case 'ready':
      return { kind: 'ready' };
    case 'resync':
      return { kind: 'resync' };
    case 'closed':
      return { kind: 'closed', reason: typeof body?.reason === 'string' ? body.reason : 'unknown' };
    case 'device.updated':
      return body && typeof body.id === 'string' ? { kind: 'device', device: adaptDevice(body as unknown as WireDevice) } : null;
    case 'device.power': {
      if (!body || typeof body.id !== 'string') return null;
      const p = body.power as { state?: string; since?: string | null } | undefined;
      return { kind: 'power', id: body.id, power: adaptPower(p?.state), since: p?.since ?? null };
    }
    case 'device.removed':
      return body && typeof body.id === 'string' ? { kind: 'removed', id: body.id } : null;
    case 'event.created':
      return body && typeof body.id === 'string' ? { kind: 'event', event: adaptEvent(body as unknown as WireEvent) } : null;
  }
}
