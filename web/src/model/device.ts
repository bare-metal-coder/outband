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
   * `via`: per action, the paths its default (no `via`) dispatches on now.
   * An action whose default is unavailable is absent from `power` and `via`.
   * `paths`: every single path `via` can use now (may list actions that are
   * not in `power`, e.g. a hard power-off when the agent is offline).
   */
  can: {
    power: PowerKind[];
    via: Partial<Record<PowerKind, Channel[]>>;
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
  /**
   * The `via` to send: exactly one path. `null` sends no `via`, so the server
   * uses the action's default, which may dispatch on several paths.
   */
  via: Channel | null;
  /** The paths this option goes out on (the default's paths, or the one chosen). Empty when unknown. */
  paths: Channel[];
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
  /** Always at least one. The default (when available) comes first. */
  options: PowerOption[];
}

export const channelName = (c: Channel | string): string =>
  ({ agent: 'agent', amt: 'Intel AMT', wol: 'Wake-on-LAN', mqtt: 'MQTT', ipkvm: 'IP-KVM / PDU' })[c as Channel] ?? c;

/** "Intel AMT", or "Wake-on-LAN + Intel AMT". */
export const pathsName = (paths: readonly Channel[]): string => paths.map(channelName).join(' + ');

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
 * Describe an action carried out on `paths`. `off` and `reset` are graceful on
 * the agent (or MQTT) and hard on AMT or an IP-KVM/PDU port; `cycle` is always
 * a hard AMT cycle. `only` marks a single path picked out of a multi-path default.
 */
export function describeOption(kind: PowerKind, paths: readonly Channel[], via: Channel | null, only = false): PowerOption {
  const at = paths.length ? ` (${pathsName(paths)})` : '';
  const hard = paths.some((p) => p === 'amt' || p === 'ipkvm');
  const base = { via, paths: [...paths] };
  switch (kind) {
    case 'on':
      return { ...base, label: `Power on${at}`, detail: `Power on through ${paths.length ? pathsName(paths) : 'Intel AMT'}.`, graceful: false };
    case 'wake':
      return {
        ...base,
        label: `Wake${at}`,
        detail: only ? `Use ${pathsName(paths)} only.` : `Send ${paths.length ? pathsName(paths) : 'Wake-on-LAN, plus an AMT power-up when AMT is reachable'}.`,
        graceful: false,
      };
    case 'sleep':
      return { ...base, label: `Sleep${at}`, detail: 'Ask the OS to sleep.', graceful: true };
    case 'cycle':
      return { ...base, label: `Power cycle${at}`, detail: 'Hard power off, then on again, through Intel AMT. Unsaved work is lost.', graceful: false };
    case 'off':
      return hard
        ? { ...base, label: `Hard power off${at}`, detail: 'Cuts power in hardware. The OS is not shut down cleanly and unsaved work is lost.', graceful: false }
        : { ...base, label: `Shut down${at}`, detail: 'Asks the OS to shut down cleanly.', graceful: true };
    case 'reset':
      return hard
        ? { ...base, label: `Hard reset${at}`, detail: 'Resets the machine in hardware. The OS is not restarted cleanly and unsaved work is lost.', graceful: false }
        : { ...base, label: `Restart${at}`, detail: 'Asks the OS to restart cleanly.', graceful: true };
  }
}

const known = (list: readonly string[] | undefined): Channel[] => (list ?? []).filter((c): c is Channel => KNOWN_CHANNELS.includes(c as Channel));

/**
 * Build the choices for one action.
 * - Default available (`power_via`): first the default (no `via`; the server
 *   dispatches on exactly those paths), then every other single path from
 *   `power_paths` (sent as `via`, one path).
 * - Default unavailable (absent from `power`): only the single paths in
 *   `power_paths`, each sent as `via`. Never a request without `via`, which
 *   the server would refuse with 409.
 * - No path information at all (old server): one default option, no `via`.
 */
function buildAction(d: Device, kind: PowerKind): PowerAction {
  const def = known(d.can.via[kind]);
  const paths = known(d.can.paths[kind]);
  const options: PowerOption[] = [];
  if (d.can.power.includes(kind)) options.push(describeOption(kind, def, null));
  const single = def.length === 1 ? def[0] : null;
  for (const p of paths) {
    if (p === single) continue; // already the default
    options.push(describeOption(kind, [p], p, def.length > 1));
  }
  if (!options.length) options.push(describeOption(kind, [], null));
  return { kind, label: BUTTON[kind], destructive: DESTRUCTIVE.has(kind), options };
}

/**
 * Power actions to offer now: what the server says is possible (default
 * available, or reachable through some single path), narrowed by the current
 * power state so we never offer "on" for a running machine or "off" for one
 * that is already off. With an unknown state, everything possible is offered.
 */
export function availableActions(d: Device): PowerAction[] {
  const wantsOn = (k: PowerKind) => k === 'on' || k === 'wake';
  const possible = (k: PowerKind) => d.can.power.includes(k) || known(d.can.paths[k]).length > 0;
  return ORDER.filter(possible)
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
