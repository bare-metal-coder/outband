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
/** A way the server can carry a power action (the spec's `PowerPath`). */
export type Channel = 'agent' | 'amt' | 'wol' | 'mqtt' | 'ipkvm';

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
  /**
   * What the server says the caller may do now (rights, scope, reachability).
   * `via` is each action's default path; `paths` every path available now
   * (first entry is the default). Both can be empty on older servers.
   */
  can: {
    power: PowerKind[];
    via: Partial<Record<PowerKind, Channel>>;
    paths: Partial<Record<PowerKind, Channel[]>>;
    console: string[];
  };
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
  /** Who did it. `null` when the server gives no actor. */
  user: string | null;
  /** The actor is hidden by the server's privacy rules (a pseudonym, not a name). */
  redacted: boolean;
  tokenName: string | null;
  outcome: 'success' | 'denied' | 'failed' | null;
  deviceId: string | null;
}

/** One way to carry out an action: the unit the confirm dialog offers. */
export interface PowerOption {
  via: Channel;
  /** Names the action and the path, e.g. "Hard power off (Intel AMT)". */
  label: string;
  detail: string;
  /** A graceful OS operation (as opposed to cutting power in hardware). */
  graceful: boolean;
}

export interface PowerAction {
  kind: PowerKind;
  /** Short button label. */
  label: string;
  destructive: boolean;
  /** Always at least one. The first is the server's default path. */
  options: PowerOption[];
  /**
   * True when the request carries `via`, so the server uses exactly the path
   * the user confirmed (never a fallback). False for `wake` (its default is a
   * combination of Wake-on-LAN and AMT) and when the server gave no path info.
   */
  explicitVia: boolean;
}

export const channelName = (c: Channel | string): string =>
  ({ agent: 'agent', amt: 'Intel AMT', wol: 'Wake-on-LAN', mqtt: 'MQTT', ipkvm: 'IP-KVM / PDU' })[c as Channel] ?? c;

const BUTTON: Record<PowerKind, string> = {
  on: 'Power on',
  wake: 'Wake',
  sleep: 'Sleep',
  reset: 'Restart',
  cycle: 'Power cycle',
  off: 'Power off',
};

const DESTRUCTIVE: ReadonlySet<PowerKind> = new Set(['off', 'reset', 'cycle', 'sleep']);

/** Display order: least disruptive first. */
const ORDER: PowerKind[] = ['on', 'wake', 'sleep', 'reset', 'cycle', 'off'];

const KNOWN_CHANNELS: readonly Channel[] = ['agent', 'amt', 'wol', 'mqtt', 'ipkvm'];

/**
 * Describe one (action, path) pair the way the server will carry it out.
 * `off` and `reset` through the agent are graceful; through AMT (or an
 * IP-KVM/PDU port) they are hard. `cycle` is always a hard AMT cycle.
 */
export function describeOption(kind: PowerKind, via: Channel | null): PowerOption {
  const at = via ? ` (${channelName(via)})` : '';
  const hard = via !== null && via !== 'agent' && via !== 'mqtt';
  switch (kind) {
    case 'on':
      return { via: via ?? 'amt', label: `Power on${at}`, detail: `Power on through ${channelName(via ?? 'amt')}.`, graceful: false };
    case 'wake':
      return {
        via: via ?? 'wol',
        label: `Wake${at}`,
        detail:
          via === 'wol'
            ? 'Send Wake-on-LAN through peer agents.'
            : via
              ? `Power up through ${channelName(via)}.`
              : 'Send Wake-on-LAN through peer agents, plus an AMT power-up when AMT is reachable.',
        graceful: false,
      };
    case 'sleep':
      return { via: via ?? 'agent', label: `Sleep${at}`, detail: 'Ask the OS to sleep through the agent.', graceful: true };
    case 'cycle':
      return { via: via ?? 'amt', label: `Power cycle${at}`, detail: 'Hard power off, then on again, through Intel AMT. Unsaved work is lost.', graceful: false };
    case 'off':
      return hard
        ? { via: via ?? 'amt', label: `Hard power off${at}`, detail: 'Cuts power in hardware. The OS is not shut down cleanly and unsaved work is lost.', graceful: false }
        : { via: via ?? 'agent', label: `Shut down${at}`, detail: 'Asks the OS to shut down cleanly through the agent.', graceful: true };
    case 'reset':
      return hard
        ? { via: via ?? 'amt', label: `Hard reset${at}`, detail: 'Resets the machine in hardware. The OS is not restarted cleanly and unsaved work is lost.', graceful: false }
        : { via: via ?? 'agent', label: `Restart${at}`, detail: 'Asks the OS to restart cleanly through the agent.', graceful: true };
  }
}

/** Build the action: its paths come from `power_paths`, else `power_via`, else the spec's defaults. */
function buildAction(d: Device, kind: PowerKind): PowerAction {
  const known = (list: readonly string[] | undefined): Channel[] =>
    (list ?? []).filter((c): c is Channel => KNOWN_CHANNELS.includes(c as Channel));
  let paths = known(d.can.paths[kind]);
  if (!paths.length && d.can.via[kind]) paths = [d.can.via[kind]!];
  // Without path info, describe the default path the spec gives for the action.
  const options = paths.length ? paths.map((p) => describeOption(kind, p)) : [describeOption(kind, null)];
  return { kind, label: BUTTON[kind], destructive: DESTRUCTIVE.has(kind), options, explicitVia: paths.length > 0 && kind !== 'wake' };
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
    .map((k) => buildAction(d, k));
}

/** Overall reachability, used for the summary counts. */
export type Reach = 'online' | 'oob' | 'offline';

export function reach(d: Device): Reach {
  if (d.online) return 'online';
  if (d.amt.state === 'reachable') return 'oob';
  return 'offline';
}

/** Status chips follow the spec's `status`: online = agent connected, amt = AMT reachable, offline = no agent. */
export type StatusFilter = 'online' | 'amt' | 'offline';
export type PowerFilter = 'on' | 'off' | 'sleep';

export interface Filters {
  query: string;
  status: StatusFilter | null;
  power: PowerFilter | null;
}

export const NO_FILTERS: Filters = { query: '', status: null, power: null };

export function statusMatch(d: Device, s: StatusFilter): boolean {
  return s === 'online' ? d.online : s === 'offline' ? !d.online : d.amt.state === 'reachable';
}

/** Case-insensitive match on name, id, host, IPs, OS and group name. */
export function matches(d: Device, query: string, groupName = ''): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [d.name, d.id, d.host ?? '', d.os ?? '', groupName || d.groupName, ...d.ips].join('\n').toLowerCase();
  return q.split(/\s+/).every((term) => hay.includes(term));
}

export function filterDevices(list: readonly Device[], f: Filters, groupName: (id: string) => string = () => ''): Device[] {
  return list.filter(
    (d) =>
      (!f.status || statusMatch(d, f.status)) &&
      (!f.power || d.power === f.power) &&
      matches(d, f.query, groupName(d.groupId)),
  );
}

export interface Section {
  groupId: string;
  name: string;
  devices: Device[];
}

/** Group devices into sections ordered by group name; devices keep their order. */
export function sections(list: readonly Device[], groupName: (id: string) => string = () => ''): Section[] {
  const by = new Map<string, Section>();
  for (const d of list) {
    let s = by.get(d.groupId);
    if (!s) {
      s = { groupId: d.groupId, name: groupName(d.groupId) || d.groupName || 'No group', devices: [] };
      by.set(d.groupId, s);
    }
    s.devices.push(d);
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Parse `?q=&status=&power=` (unknown values are dropped). */
export function filtersFromSearch(search: string): Filters {
  const p = new URLSearchParams(search);
  const status = p.get('status');
  const power = p.get('power');
  return {
    query: p.get('q') ?? '',
    status: status === 'online' || status === 'amt' || status === 'offline' ? status : null,
    power: power === 'on' || power === 'off' || power === 'sleep' ? power : null,
  };
}

export function filtersToSearch(f: Filters): string {
  const p = new URLSearchParams();
  if (f.query.trim()) p.set('q', f.query.trim());
  if (f.status) p.set('status', f.status);
  if (f.power) p.set('power', f.power);
  const s = p.toString();
  return s ? `?${s}` : '';
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
