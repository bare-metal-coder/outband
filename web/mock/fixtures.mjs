// Mock data in /api/v1 shapes (api-spec/openapi.yaml). Example data only.
const now = Date.now();
const ago = (m) => new Date(now - m * 60_000).toISOString();

export const groups = [
  { id: 'grpLab0000000001', name: 'Lab', description: 'Bench machines', kind: 'agent', rights: { mask: 4294967295, names: ['admin'] }, device_count: 0 },
  { id: 'grpAmt0000000002', name: 'AMT only', description: 'Machines managed only through Intel AMT', kind: 'amt', rights: { mask: 4294967295, names: ['admin'] }, device_count: 0 },
];

const caps = (power, console = []) => ({ power, console });

function device(o) {
  return {
    host: null,
    os: null,
    ips: [],
    online: false,
    connectivity: { agent: false, amt_cira: false, amt_local: false, relay: false, mqtt: false },
    amt: { state: 'none', version: null, reachable: false },
    power: { state: 'unknown', since: null },
    last_seen: null,
    capabilities: caps([]),
    ...o,
  };
}

export const devices = [
  device({
    id: 'devWeb0100000001',
    name: 'web01',
    host: 'web01.example.com',
    group: { id: groups[0].id, name: groups[0].name },
    os: 'Ubuntu 24.04 LTS',
    ips: ['10.0.0.11'],
    online: true,
    connectivity: { agent: true, amt_cira: false, amt_local: true, relay: false, mqtt: false },
    amt: { state: 'provisioned', version: '16.1.25', reachable: true },
    power: { state: 'on', since: ago(600) },
    last_seen: ago(0),
    capabilities: caps(['on', 'off', 'reset', 'cycle', 'sleep', 'wake'], ['sol']),
  }),
  device({
    id: 'devNas0100000002',
    name: 'nas01',
    host: 'nas01.example.com',
    group: { id: groups[0].id, name: groups[0].name },
    os: 'Debian 12',
    ips: ['10.0.0.12'],
    online: true,
    connectivity: { agent: true, amt_cira: false, amt_local: false, relay: false, mqtt: false },
    power: { state: 'on', since: ago(3000) },
    last_seen: ago(0),
    capabilities: caps(['off', 'reset', 'sleep', 'wake']),
  }),
  device({
    id: 'devBmc0100000003',
    name: 'amt-node01',
    host: '10.0.0.21',
    group: { id: groups[1].id, name: groups[1].name },
    ips: ['10.0.0.21'],
    connectivity: { agent: false, amt_cira: false, amt_local: true, relay: false, mqtt: false },
    amt: { state: 'provisioned', version: '12.0.90', reachable: true },
    power: { state: 'off', since: ago(90) },
    last_seen: ago(1),
    capabilities: caps(['on', 'off', 'reset', 'cycle', 'wake'], ['sol']),
  }),
  device({
    id: 'devOld0100000004',
    name: 'old-desktop',
    group: { id: groups[0].id, name: groups[0].name },
    os: 'Windows 11 Pro',
    ips: ['10.0.0.30'],
    last_seen: ago(60 * 26),
    power: { state: 'off', since: ago(60 * 26) },
    capabilities: caps(['wake']),
  }),
];

for (const g of groups) g.device_count = devices.filter((d) => d.group.id === g.id).length;

export const detailExtra = {
  devWeb0100000001: { agent: { version: '1.1.32', type: 6, connected_at: ago(600) }, hardware: { manufacturer: 'ExampleCorp', model: 'Mini 7', serial: 'EX-0001', cpu: 'Intel Core i5-1340P', memory_mb: 32768 } },
};

export const users = {
  admin: { password: 'outband', twofa: false, user: { id: 'user//admin', name: 'admin', email: null, siteadmin: 4294967295 } },
  ops: { password: 'outband', twofa: true, user: { id: 'user//ops', name: 'ops', email: 'ops@example.com', siteadmin: 0 } },
};
export const OTP = '123456';

let eid = 1;
export const events = [];
export function makeEvent(device, action, message, user = null) {
  const e = { id: `ev${String(eid++).padStart(6, '0')}`, time: new Date().toISOString(), type: 'node', action, message, user, token_name: null, device_id: device?.id ?? null, group_id: device?.group.id ?? null, source_ip: null };
  events.unshift(e);
  return e;
}
makeEvent(devices[0], 'agentconnect', 'Agent connected');
makeEvent(devices[2], 'amtpower', 'Intel AMT reported power off');
