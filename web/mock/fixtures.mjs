// Mock data in /api/v1 shapes (api-spec/openapi.yaml, 1.0.0-draft.4). Example data only.

export const ALL_SCOPES = ['read', 'power_on', 'power_off', 'console', 'identity', 'audit'];
export const FULL = 4294967295;

export const users = {
  admin: { password: 'outband', twofa: false, deny: [], user: { id: 'admin', name: 'admin', email: 'admin@example.com', siteadmin: FULL } },
  ops: { password: 'outband', twofa: true, deny: [], user: { id: 'ops', name: 'ops', email: 'ops@example.com', siteadmin: 0 } },
  // A user whose rights exclude Intel AMT (MeshCentral NOAMT): never sees an AMT path.
  guest: { password: 'outband', twofa: false, deny: ['amt'], user: { id: 'guest', name: 'guest', email: null, siteadmin: 0 } },
};
export const OTP = '123456';

const minutes = (m) => new Date(Date.now() - m * 60_000).toISOString();

const GROUPS = [
  { id: 'grpLab0000000001', name: 'Lab', description: 'Bench machines', kind: 'agent' },
  { id: 'grpAmt0000000002', name: 'AMT only', description: 'Machines managed only through Intel AMT', kind: 'amt' },
  { id: 'grpEdge000000003', name: 'Edge', description: '', kind: 'agent' },
];

function dev(o) {
  return {
    host: null,
    os: null,
    ips: [],
    online: false,
    connectivity: { agent: false, amt_cira: false, amt_local: false, relay: false, mqtt: false },
    amt: { state: 'none', version: null, reachable: false },
    power: { state: 'unknown', since: null },
    last_seen: null,
    console: [],
    ...o,
  };
}

/** A fresh copy of all mock state (the server resets to this between runs). */
export function makeFixtures() {
  const g = (i) => ({ id: GROUPS[i].id, name: GROUPS[i].name });
  const devices = [
    dev({
      id: 'devWeb0100000001', name: 'web01', host: 'web01.example.com', group: g(0), os: 'Ubuntu 24.04 LTS', ips: ['10.0.0.11'], online: true,
      connectivity: { agent: true, amt_cira: false, amt_local: true, relay: false, mqtt: false },
      amt: { state: 'provisioned', version: '16.1.25', reachable: true },
      power: { state: 'on', since: minutes(600) }, last_seen: minutes(0), console: ['sol'],
    }),
    dev({
      id: 'devNas0100000002', name: 'nas01', host: 'nas01.example.com', group: g(0), os: 'Debian 12', ips: ['10.0.0.12'], online: true,
      connectivity: { agent: true, amt_cira: false, amt_local: false, relay: false, mqtt: false },
      power: { state: 'on', since: minutes(3000) }, last_seen: minutes(0),
    }),
    dev({
      id: 'devDb010000000003', name: 'db01', host: 'db01.example.com', group: g(0), os: 'Debian 12', ips: ['10.0.0.13'], online: true,
      connectivity: { agent: true, amt_cira: true, amt_local: false, relay: false, mqtt: false },
      amt: { state: 'provisioned', version: '15.0.40', reachable: true },
      power: { state: 'on', since: minutes(9000) }, last_seen: minutes(0), console: ['sol'],
    }),
    dev({
      id: 'devBmc0100000004', name: 'amt-node01', host: '10.0.0.21', group: g(1), ips: ['10.0.0.21'],
      connectivity: { agent: false, amt_cira: false, amt_local: true, relay: false, mqtt: false },
      amt: { state: 'provisioned', version: '12.0.90', reachable: true },
      power: { state: 'off', since: minutes(90) }, last_seen: minutes(1), console: ['sol'],
    }),
    dev({
      id: 'devOld0100000005', name: 'old-desktop', group: g(0), os: 'Windows 11 Pro', ips: ['10.0.0.30'],
      last_seen: minutes(60 * 26), power: { state: 'off', since: minutes(60 * 26) },
    }),
    dev({
      id: 'devEdge010000006', name: 'edge-gw', host: 'edge-gw.example.com', group: g(2), os: 'Alpine 3.20', ips: ['10.0.0.40'], online: true,
      connectivity: { agent: true, amt_cira: false, amt_local: false, relay: false, mqtt: false },
      amt: { state: 'unprovisioned', version: '11.8.50', reachable: false },
      power: { state: 'sleep', since: minutes(30) }, last_seen: minutes(2),
    }),
  ];
  const groups = GROUPS.map((x) => ({
    ...x,
    rights: { mask: FULL, names: ['admin'] },
    device_count: devices.filter((d) => d.group.id === x.id).length,
  }));
  const detail = {
    devWeb0100000001: {
      agent: { version: '1.1.32', type: 6, connected_at: minutes(600) },
      hardware: { manufacturer: 'ExampleCorp', model: 'Mini 7', serial: 'EX-0001', cpu: 'Intel Core i5-1340P', memory_mb: 32768 },
    },
    devBmc0100000004: { agent: null, hardware: { manufacturer: 'ExampleCorp', model: 'NUC 12', serial: 'EX-0004', cpu: 'Intel Core i7-1260P', memory_mb: 16384 } },
  };

  const events = [];
  let n = 1;
  const add = (d, action, message, minutesAgo, extra = {}) => {
    events.unshift({
      id: `evt_${String(n++).padStart(6, '0')}`, time: minutes(minutesAgo), type: 'node', action, message,
      user: null, token_id: null, token_name: null, device_id: d?.id ?? null, group_id: d?.group.id ?? null,
      action_id: null, outcome: 'success', ...extra,
    });
  };
  // Oldest first (unshift reverses): 60 events on web01 so the list pages.
  for (let i = 0; i < 60; i++) {
    add(devices[0], i % 3 ? 'agentconnect' : 'agentdisconnect', i % 3 ? 'Agent connected' : 'Agent disconnected', 3000 - i * 45);
  }
  add(devices[3], 'amtpower', 'Intel AMT reported power off', 90);
  add(devices[0], 'agentconnect', 'Agent connected', 10);
  return { groups, devices, detail, events, nextEventId: () => n++ };
}

/** What `caller` may do with a device now, as `capabilities` (scope, rights and reachability). */
export function capabilitiesFor(d, caller) {
  const denied = caller?.deny ?? [];
  const agent = d.online;
  const amt = d.amt.reachable && !denied.includes('amt');
  const paths = {};
  const hard = [...(agent ? ['agent'] : []), ...(amt ? ['amt'] : [])];
  if (amt) paths.on = ['amt'];
  paths.wake = ['wol'];
  if (agent) paths.sleep = ['agent'];
  if (hard.length) {
    paths.off = hard;
    paths.reset = hard;
  }
  if (amt) paths.cycle = ['amt'];
  const power = Object.keys(paths);
  const via = Object.fromEntries(power.map((k) => [k, paths[k][0]]));
  return { power, power_via: via, power_paths: paths, console: amt ? d.console : [] };
}

/** A device as the API sends it. `redactIps` models a read-only token. */
export function wireDevice(d, caller) {
  const { console: _c, ...rest } = d;
  return { ...rest, capabilities: capabilitiesFor(d, caller) };
}

export const { devices } = makeFixtures();
