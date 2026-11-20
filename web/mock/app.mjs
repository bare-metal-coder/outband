// Outband mock: /api/v1 per api-spec/openapi.yaml (1.0.0-draft.5).
// createMock({ static }) returns an http.Server (call .listen yourself).
//
// Users: admin/outband, ops/outband (2FA code 123456), guest/outband (no AMT right).
// Test hooks (not part of the API), all POST JSON under /__mock/:
//   reset                      restore all state
//   emit {id, power?|online?}  change a device and push the stream event
//   silent {id, amt_reachable} change a device without telling clients (stale UI)
//   deny {paths:[...]}         server-side deny these paths for power (403 forbidden)
//   event {id, message}        push an event.created for a device
//   unknown {}                 push an event of a type no client knows
//   age-session                make sessions' last_auth stale (forces step-up)
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { ALL_SCOPES, FULL, OTP, capabilitiesFor, makeFixtures, users, wireDevice } from './fixtures.mjs';

const API_VERSION = '1.0.0-draft.5';
const STEP_UP_MS = 15 * 60_000;
const SCOPE_LIST = new Set(ALL_SCOPES);

export function createMock(opts = {}) {
  let S;
  const sessions = new Map(); // sid -> { user, pending, lastAuth, lastAuth2fa, codes }
  const streams = new Set(); // { res, sid, types }
  let buffer = []; // { id, type, frame }
  let seq = 0;
  let bans = 0;
  let denyPaths = [];
  const powerLog = new Map(); // device id -> timestamps
  const idem = new Map(); // credential|key -> { body, result }

  const reset = () => {
    S = { ...makeFixtures(), tokens: new Map() };
    bans = 0;
    denyPaths = [];
    powerLog.clear();
    idem.clear();
    buffer = [];
  };
  reset();

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Outband-API-Version': API_VERSION, 'Outband-Request-Id': `req_${randomBytes(4).toString('hex')}`, ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const err = (res, status, code, message, details, headers) => json(res, status, { error: { code, message, ...(details ? { details } : {}) } }, headers);

  const cookieSid = (req) => /(?:^|;\s*)xid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? null;
  const current = (req) => sessions.get(cookieSid(req) ?? '');
  async function readBody(req) {
    let raw = '';
    for await (const c of req) raw += c;
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const setCookie = (sid) => `xid=${sid}; Path=/; HttpOnly; SameSite=Lax`;

  function broadcast(type, data) {
    const id = ++seq;
    const frame = `event: ${type}\nid: ${id}\ndata: ${JSON.stringify({ type, data })}\n\n`;
    buffer.push({ id, type, frame });
    if (buffer.length > 200) buffer.shift();
    for (const c of streams) if (!c.types || c.types.has(type)) c.res.write(frame);
  }

  const find = (id) => S.devices.find((d) => d.id === id);
  const pushDevice = (d) => broadcast('device.updated', wireDevice(d, null));
  function setPower(d, state) {
    d.power = { state, since: new Date().toISOString() };
    broadcast('device.power', { id: d.id, power: d.power });
  }
  function addEvent(d, action, message, extra = {}) {
    const e = {
      id: `evt_${String(S.nextEventId()).padStart(6, '0')}`, time: new Date().toISOString(), type: 'node', action, message,
      user: null, token_id: null, token_name: null, device_id: d?.id ?? null, group_id: d?.group.id ?? null, action_id: null, outcome: 'success', ...extra,
    };
    S.events.unshift(e);
    broadcast('event.created', e);
    return e;
  }

  const page = (items, url, key = (x) => x.id) => {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
    const cur = url.searchParams.get('cursor');
    let start = 0;
    if (cur) {
      const i = items.findIndex((x) => key(x) === cur);
      start = i < 0 ? items.length : i + 1;
    }
    const slice = items.slice(start, start + limit);
    return { items: slice, next_cursor: start + limit < items.length ? key(slice[slice.length - 1]) : null };
  };

  const newToken = () => `obt_${randomBytes(33).toString('base64url').slice(0, 43)}`;
  const fresh = (s) => {
    const ok = (t) => Date.now() - t < STEP_UP_MS;
    return ok(s.lastAuth) && (!users[s.user.name].twofa || ok(s.lastAuth2fa));
  };

  async function api(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    if (m === 'OPTIONS') return err(res, 403, 'csrf_failed', 'OPTIONS is not allowed');
    if (m !== 'GET' && m !== 'HEAD') {
      if (req.headers['x-outband'] !== '1') return err(res, 403, 'csrf_failed', 'Missing X-Outband header');
      if (!(req.headers['content-type'] ?? '').includes('application/json') && Number(req.headers['content-length'] ?? 0) > 0) {
        return err(res, 415, 'unsupported_media_type', 'Send application/json');
      }
    }
    if (p === '/api/v1/health') return json(res, 200, { status: 'ok' });

    if (p === '/api/v1/session' && m === 'GET') {
      const s = current(req);
      const on = Boolean(s?.user);
      return json(res, 200, {
        authenticated: on,
        user: s?.user ?? null,
        auth_method: on ? 'cookie' : null,
        scopes: on ? ALL_SCOPES : [],
        server: on ? { name: 'Outband (mock)', version: '1.3.1' } : { name: 'Outband (mock)' },
        twofa: s?.pending ? { required: true, methods: ['otp', 'email'], expires_at: new Date(s.expires).toISOString() } : { required: false },
      });
    }

    if (p === '/api/v1/auth/login' && m === 'POST') {
      const b = await readBody(req);
      const bad = b === null || typeof b.username !== 'string' || typeof b.password !== 'string' || Object.keys(b).some((k) => !['username', 'password'].includes(k));
      if (bad) return err(res, 400, 'invalid_request', 'username and password are required');
      if (bans >= 10) return err(res, 429, 'rate_limited', 'Too many failed logins', undefined, { 'Retry-After': '900' });
      const u = users[b.username];
      if (!u || u.password !== b.password) {
        bans++;
        return err(res, 401, 'invalid_credentials', 'Invalid username or password');
      }
      bans = 0;
      const sid = randomBytes(16).toString('hex');
      if (u.twofa) {
        sessions.set(sid, { pending: u, expires: Date.now() + 5 * 60_000, codes: 0, lastAuth: Date.now() });
        return json(res, 200, { authenticated: false, twofa: { required: true, methods: ['otp', 'email'], expires_at: new Date(Date.now() + 300_000).toISOString() } }, { 'Set-Cookie': setCookie(sid) });
      }
      sessions.set(sid, { user: u.user, lastAuth: Date.now(), lastAuth2fa: 0 });
      return json(res, 200, { authenticated: true, user: u.user }, { 'Set-Cookie': setCookie(sid) });
    }

    if (p === '/api/v1/auth/2fa' && m === 'POST') {
      const old = cookieSid(req);
      const s = current(req);
      const b = await readBody(req);
      if (b === null) return err(res, 400, 'invalid_request', 'Bad JSON');
      if (!s?.pending || Date.now() > s.expires) return err(res, 401, 'no_pending_login', 'No pending login');
      if (b.send) return json(res, 202, undefined);
      if (typeof b.code !== 'string' || b.code.length < 4) return err(res, 400, 'invalid_request', 'code is required', { field: 'code' });
      if (b.code !== OTP) {
        if (++s.codes >= 5) sessions.delete(old);
        return err(res, 401, 'invalid_code', 'Invalid code');
      }
      sessions.delete(old);
      const sid = randomBytes(16).toString('hex');
      sessions.set(sid, { user: s.pending.user, lastAuth: Date.now(), lastAuth2fa: Date.now() });
      return json(res, 200, { authenticated: true, user: s.pending.user }, { 'Set-Cookie': setCookie(sid) });
    }

    if (p === '/api/v1/auth/logout' && m === 'POST') {
      const sid = cookieSid(req);
      for (const c of [...streams]) {
        if (c.sid === sid) {
          c.res.write(`event: closed\nid: ${++seq}\ndata: ${JSON.stringify({ type: 'closed', data: { reason: 'logout' } })}\n\n`);
          c.res.end();
          streams.delete(c);
        }
      }
      if (sid) sessions.delete(sid);
      res.writeHead(204, { 'Set-Cookie': 'xid=; Path=/; Max-Age=0' });
      return res.end();
    }

    const s = current(req);
    if (!s?.user) return err(res, 401, 'unauthenticated', 'Sign in first', undefined, { 'WWW-Authenticate': 'Bearer realm="outband"' });
    const caller = users[s.user.name];

    if (p === '/api/v1/server') {
      return json(res, 200, { name: 'Outband (mock)', version: '1.3.1', outband_version: '0.1.0', api_version: API_VERSION, features: { amt: true, twofa: { available: true, ip_exemptions: false, methods: ['otp', 'email'] }, api_tokens: true, console_kinds: ['sol'], legacy_ui: true } });
    }
    if (p === '/api/v1/groups') return json(res, 200, page([...S.groups].sort((a, b) => a.name.localeCompare(b.name)), url));

    if (p === '/api/v1/auth/tokens' && m === 'GET') {
      const mine = [...S.tokens.values()].filter((t) => t.owner.id === s.user.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return json(res, 200, page(mine, url));
    }
    if (p === '/api/v1/auth/tokens' && m === 'POST') {
      const b = await readBody(req);
      const allowed = ['name', 'scopes', 'profile', 'expires_in_days', 'groups', 'allowed_ips'];
      const bad = (field, msg) => err(res, 400, 'invalid_request', msg, { field });
      if (b === null || Object.keys(b).some((k) => !allowed.includes(k))) return bad('body', 'Unknown or malformed fields');
      if (typeof b.name !== 'string' || !/^[\x20-\x7E]{1,64}$/.test(b.name)) return bad('name', 'name must be 1-64 printable characters');
      if (Boolean(b.scopes) === Boolean(b.profile)) return bad('scopes', 'Give exactly one of scopes or profile');
      let scopes;
      if (b.profile) {
        if (b.profile !== 'device_power') return bad('profile', 'Unknown profile');
        scopes = ['read', 'power_on', 'power_off'];
      } else {
        if (!Array.isArray(b.scopes) || !b.scopes.length || b.scopes.some((x) => !SCOPE_LIST.has(x)) || new Set(b.scopes).size !== b.scopes.length) return bad('scopes', 'Bad scopes');
        scopes = b.scopes;
      }
      const days = b.expires_in_days ?? 90;
      const max = scopes.includes('console') ? 30 : scopes.some((x) => x.startsWith('power_') || x === 'audit') ? 90 : 365;
      if (!Number.isInteger(days) || days < 1 || days > max) return bad('expires_in_days', `At most ${max} days with these scopes`);
      if (b.groups !== undefined && (!Array.isArray(b.groups) || !b.groups.length || b.groups.some((g) => !S.groups.some((x) => x.id === g)))) return bad('groups', 'Unknown group');
      if (scopes.includes('console') && !b.groups) return bad('groups', 'A console token needs groups');
      if (scopes.some((x) => !['read', 'identity'].includes(x)) && !fresh(s)) return err(res, 401, 'reauth_required', 'Confirm your password to continue');
      const live = [...S.tokens.values()].filter((t) => t.owner.id === s.user.id && !t.revoked_at && Date.parse(t.expires_at) > Date.now());
      if (live.length >= 50) return err(res, 409, 'token_limit', 'You have 50 live tokens');
      const secret = newToken();
      const token = {
        id: `tok_${randomBytes(6).toString('hex')}`, name: b.name, owner: { id: s.user.id, name: s.user.name }, prefix: secret.slice(0, 8), scopes,
        groups: b.groups ?? null, allowed_ips: b.allowed_ips ?? null, created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + days * 86_400_000).toISOString(), last_used_at: null, revoked_at: null,
      };
      S.tokens.set(token.id, token);
      return json(res, 201, { token, secret });
    }
    let mm = /^\/api\/v1\/auth\/tokens\/([^/]+)$/.exec(p);
    if (mm && m === 'DELETE') {
      const t = S.tokens.get(decodeURIComponent(mm[1]));
      if (!t || t.owner.id !== s.user.id) return err(res, 404, 'not_found', 'Token not found');
      t.revoked_at ??= new Date().toISOString();
      res.writeHead(204);
      return res.end();
    }

    if (p === '/api/v1/devices') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const st = url.searchParams.get('status');
      const grp = url.searchParams.get('group');
      const items = S.devices
        .filter((d) => (!q || d.name.toLowerCase().includes(q) || (d.host ?? '').toLowerCase().includes(q)) && (!grp || d.group.id === grp) &&
          (!st || (st === 'online' ? d.online : st === 'offline' ? !d.online : d.amt.reachable)))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((d) => wireDevice(d, caller));
      return json(res, 200, page(items, url));
    }

    mm = /^\/api\/v1\/devices\/([^/]+)(?:\/(power|events))?$/.exec(p);
    if (mm) {
      const d = find(decodeURIComponent(mm[1]));
      if (!d) return err(res, 404, 'not_found', 'Device not found');
      if (!mm[2] && m === 'GET') {
        return json(res, 200, { ...wireDevice(d, caller), rights: { mask: FULL, names: ['admin'] }, description: null, tags: [], agent: null, hardware: null, ...(S.detail[d.id] ?? {}) });
      }
      if (mm[2] === 'events' && m === 'GET') return json(res, 200, page(S.events.filter((e) => e.device_id === d.id), url));
      if (mm[2] === 'power' && m === 'POST') return power(req, res, d, caller, s);
    }

    if (p === '/api/v1/events') return json(res, 200, page(S.events, url));

    if (p === '/api/v1/stream') {
      const types = url.searchParams.get('types');
      const last = req.headers['last-event-id'] ?? url.searchParams.get('last_event_id');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 5000\n\n');
      const c = { res, sid: cookieSid(req), types: types ? new Set(types.split(',')) : null };
      // `ready` is always sent, also on a resume and whatever `types` says.
      res.write(`event: ready\ndata: ${JSON.stringify({ type: 'ready', data: { server_time: new Date().toISOString() } })}\n\n`);
      if (last) {
        const n = Number(last);
        const known = buffer.length && buffer[0].id <= n + 1 && n <= seq;
        if (!known && n !== seq) res.write(`event: resync\nid: ${++seq}\ndata: ${JSON.stringify({ type: 'resync', data: {} })}\n\n`);
        else for (const b of buffer) if (b.id > n && (!c.types || c.types.has(b.type))) res.write(b.frame);
      }
      streams.add(c);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(ping);
        streams.delete(c);
      });
      return;
    }
    return err(res, 404, 'not_found', 'No such endpoint');
  }

  async function power(req, res, d, caller, s) {
    const b = await readBody(req);
    const ACTIONS = ['on', 'off', 'reset', 'cycle', 'sleep', 'wake'];
    const VIA = ['agent', 'amt', 'wol', 'mqtt', 'ipkvm'];
    if (b === null || !ACTIONS.includes(b.action) || (b.via !== undefined && !VIA.includes(b.via)) || Object.keys(b).some((k) => !['action', 'via'].includes(k))) {
      return err(res, 400, 'invalid_request', 'Bad action or via', { field: 'action' });
    }
    const key = req.headers['idempotency-key'];
    const ikey = key ? `${s.user.id}|${key}` : null;
    if (ikey && idem.has(ikey)) {
      const prev = idem.get(ikey);
      if (prev.body !== JSON.stringify(b)) return err(res, 409, 'idempotency_conflict', 'Same key, different body');
      return json(res, 202, prev.result);
    }
    const caps = capabilitiesFor(d, caller);
    const allowedPaths = caps.power_paths[b.action] ?? [];
    if (b.via && (caller.deny.includes(b.via) || denyPaths.includes(b.via))) return err(res, 403, 'forbidden', 'Not allowed on this path', { path: b.via });
    const paths = b.via ? (allowedPaths.includes(b.via) ? [b.via] : []) : allowedPaths.length ? [b.action === 'off' || b.action === 'reset' ? (allowedPaths.includes('agent') ? 'agent' : null) : allowedPaths[0]].filter(Boolean) : [];
    if (!paths.length) return err(res, 409, 'not_reachable', 'No path can carry this action now');
    const log = (powerLog.get(d.id) ?? []).filter((t) => Date.now() - t < 60_000);
    if (log.length >= 6) return err(res, 429, 'rate_limited', 'Too many power actions on this device', undefined, { 'Retry-After': '30' });
    log.push(Date.now());
    powerLog.set(d.id, log);
    const action_id = `act_${randomBytes(4).toString('hex')}`;
    const result = { action_id, device_id: d.id, action: b.action, paths, status: 'dispatched' };
    if (ikey) idem.set(ikey, { body: JSON.stringify(b), result });
    addEvent(d, 'outband.power', `Power action "${b.action}" dispatched through ${paths.join(' and ')}`, { user: { id: s.user.id, name: s.user.name, redacted: false }, action_id });
    setTimeout(() => {
      if (b.action === 'on' || b.action === 'wake') setPower(d, 'on');
      else if (b.action === 'off') setPower(d, 'off');
      else if (b.action === 'sleep') setPower(d, 'sleep');
    }, 600);
    return json(res, 202, result);
  }

  async function hook(req, res, name) {
    const b = (await readBody(req)) ?? {};
    const d = b.id ? find(b.id) : null;
    if (name === 'reset') reset();
    else if (name === 'age-session') for (const x of sessions.values()) x.lastAuth = x.lastAuth2fa = 0;
    else if (name === 'deny') denyPaths = b.paths ?? [];
    else if (name === 'unknown') broadcast('device.firmware', { id: b.id ?? 'devWeb0100000001', version: '9.9' });
    else if (!d) return err(res, 404, 'not_found', 'no device');
    else if (name === 'emit') {
      if (b.power) setPower(d, b.power);
      if (typeof b.online === 'boolean') {
        d.online = d.connectivity.agent = b.online;
        d.last_seen = new Date().toISOString();
        pushDevice(d);
      }
    } else if (name === 'silent') {
      if (typeof b.amt_reachable === 'boolean') d.amt.reachable = b.amt_reachable;
    } else if (name === 'event') addEvent(d, 'agentconnect', b.message ?? 'Agent connected');
    return json(res, 200, { ok: true });
  }

  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
  async function serveStatic(res, url) {
    const root = resolve(opts.static);
    let file = resolve(join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) return err(res, 400, 'invalid_request', 'bad path');
    try {
      if (!(await stat(file)).isFile()) throw new Error('dir');
    } catch {
      file = join(root, 'index.html');
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!opts.quiet) console.log(req.method, url.pathname);
    try {
      if (url.pathname.startsWith('/__mock/') && req.method === 'POST') return await hook(req, res, url.pathname.slice(8));
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (opts.static) return await serveStatic(res, url);
      err(res, 404, 'not_found', 'Mock serves /api only (use --static to serve the app)');
    } catch (e) {
      console.error(e);
      err(res, 500, 'internal', 'mock error');
    }
  });
}
