/**
 * The UI's device model. API responses are mapped into this shape in one
 * place (src/api/adapt.ts), so screens never depend on wire formats.
 */

export type Power = 'on' | 'off' | 'sleep' | 'unknown';

/**
 * Intel AMT as the UI shows it. `none` = no AMT, `unprovisioned` covers
 * provisioning too, `reachable`/`unreachable` are for a provisioned AMT.
 */
export type AmtState = 'none' | 'unprovisioned' | 'reachable' | 'unreachable' | 'unknown';

export type PowerKind = 'on' | 'off' | 'reset' | 'cycle' | 'sleep' | 'wake';
export type Channel = 'amt' | 'agent' | 'wol';

export interface Device {
  id: string;
  name: string;
  host: string | null;
  groupId: string;
  groupName: string;
  os: string | null;
  ips: string[];
  /** The agent is connected (in-band channel up). */
  online: boolean;
  amt: { state: AmtState; version: string | null; via: 'cira' | 'local' | null };
  power: Power;
  powerSince: string | null;
  /** ISO 8601, last time any channel saw the machine. */
  lastSeen: string | null;
  /** What the server says the caller may do now (rights, scope, reachability). */
  can: { power: PowerKind[]; console: string[] };
}

export interface DeviceDetail extends Device {
  description: string | null;
  tags: string[];
  agentVersion: string | null;
  hardware: { manufacturer: string | null; model: string | null; serial: string | null; cpu: string | null; memoryMb: number | null } | null;
}

export interface Group {
  id: string;
  name: string;
  description: string;
  kind: string;
  deviceCount: number;
}

export interface DeviceEvent {
  id: string;
  time: string;
  action: string;
  message: string;
  user: string | null;
  deviceId: string | null;
}

export interface PowerAction {
  kind: PowerKind;
  /** The path the server will use (inferred from its dispatch rules). */
  channel: Channel;
  label: string;
  /** Short explanation shown in the confirm dialog and palette. */
  detail: string;
  destructive: boolean;
}

/** Overall reachability, used for filtering and the summary counts. */
export type Reach = 'online' | 'oob' | 'offline';

export function reach(d: Device): Reach {
  if (d.online) return 'online';
  if (d.amt.state === 'reachable') return 'oob';
  return 'offline';
}

/** Display order: least disruptive first. */
const ORDER: PowerKind[] = ['on', 'wake', 'sleep', 'reset', 'cycle', 'off'];

/**
 * Describe one action the way the server will carry it out
 * (spec: on/cycle via AMT; off/reset via the agent when connected, else AMT;
 * sleep via the agent; wake via Wake-on-LAN plus AMT).
 */
export function describeAction(kind: PowerKind, online: boolean): PowerAction {
  switch (kind) {
    case 'on':
      return { kind, channel: 'amt', label: 'Power on', detail: 'Power on through Intel AMT.', destructive: false };
    case 'wake':
      return {
        kind,
        channel: 'wol',
        label: 'Wake',
        detail: 'Send Wake-on-LAN through peer agents, plus AMT power-up when reachable.',
        destructive: false,
      };
    case 'sleep':
      return { kind, channel: 'agent', label: 'Sleep', detail: 'Ask the OS to sleep through the agent.', destructive: true };
    case 'cycle':
      return {
        kind,
        channel: 'amt',
        label: 'Power cycle',
        detail: 'Hard power off, then on again, through Intel AMT. Unsaved work is lost.',
        destructive: true,
      };
    case 'off':
      return online
        ? { kind, channel: 'agent', label: 'Shut down', detail: 'Ask the OS to shut down through the agent.', destructive: true }
        : {
            kind,
            channel: 'amt',
            label: 'Power off (hard)',
            detail: 'Cut power through Intel AMT. The OS is not shut down cleanly.',
            destructive: true,
          };
    case 'reset':
      return online
        ? { kind, channel: 'agent', label: 'Restart', detail: 'Ask the OS to restart through the agent.', destructive: true }
        : {
            kind,
            channel: 'amt',
            label: 'Reset (hard)',
            detail: 'Hard reset through Intel AMT. Unsaved work is lost.',
            destructive: true,
          };
  }
}

/**
 * Power actions to offer now: the server's capabilities, narrowed by the
 * current power state so we never offer "on" for a running machine or
 * "off" for one that is already off. With an unknown state, all of the
 * server's capabilities are offered.
 */
export function availableActions(d: Device): PowerAction[] {
  const wantsOn = (k: PowerKind) => k === 'on' || k === 'wake';
  return ORDER.filter((k) => d.can.power.includes(k))
    .filter((k) => {
      if (d.power === 'on') return !wantsOn(k);
      if (d.power === 'off') return wantsOn(k);
      if (d.power === 'sleep') return k !== 'sleep';
      return true;
    })
    .map((k) => describeAction(k, d.online));
}

export type ReachFilter = 'all' | Reach;

/** Case-insensitive match on name, id, IPs, OS and group name. */
export function matches(d: Device, query: string, groupName = ''): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [d.name, d.id, d.host ?? '', d.os ?? '', groupName || d.groupName, ...d.ips].join('\n').toLowerCase();
  return q.split(/\s+/).every((term) => hay.includes(term));
}

export function filterDevices(
  list: readonly Device[],
  query: string,
  filter: ReachFilter,
  groupName: (id: string) => string = () => '',
): Device[] {
  return list.filter((d) => (filter === 'all' || reach(d) === filter) && matches(d, query, groupName(d.groupId)));
}

export function powerLabel(p: Power): string {
  return p === 'unknown' ? 'Unknown' : p === 'on' ? 'On' : p === 'off' ? 'Off' : 'Sleep';
}

export function amtLabel(s: AmtState): string {
  switch (s) {
    case 'none':
      return 'No AMT';
    case 'unprovisioned':
      return 'Not provisioned';
    case 'reachable':
      return 'Reachable';
    case 'unreachable':
      return 'Unreachable';
    case 'unknown':
      return 'Unknown';
  }
}

/** "just now", "5m ago", "3h ago", "2d ago", then a date. */
export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}
