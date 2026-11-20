#!/usr/bin/env node
// Outband mock server: /api/v1 per api-spec/openapi.yaml, SSE stream, and
// optionally the built app (--static <dir>) with SPA fallback.
//
//   node mock/server.mjs [--port 4480] [--static ../public/app]
//
// Users: admin/outband (no 2FA), ops/outband (2FA code 123456).
// Test hooks: POST /__mock/emit {id, power} or {id, online} pushes a stream update.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { devices, detailExtra, groups, users, OTP, events, makeEvent } from './fixtures.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const PORT = Number(opt('--port', process.env.MOCK_PORT ?? 4480));
const STATIC = opt('--static', null);
const QUIET = args.includes('--quiet');

const sessions = new Map(); // sid -> { user, pending }
const clients = new Set();
let seq = 0;

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Outband-API-Version': '1.0.0-draft.1', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const err = (res, status, code, message) => json(res, status, { error: { code, message } });

function sid(req) {
  const m = /(?:^|;\s*)xid=([^;]+)/.exec(req.headers.cookie ?? '');
  return m ? m[1] : null;
}
function current(req) {
  const s = sid(req);
  return s ? sessions.get(s) : undefined;
}
async function body(req) {
  let raw = '';
  for await (const c of req) raw += c;
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
}

function broadcast(type, data) {
  const id = ++seq;
  const frame = `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ type, data })}\n\n`;
  for (const c of clients) c.write(frame);
}

const find = (id) => devices.find((d) => d.id === id);

function setPower(d, state) {
  d.power = { state, since: new Date().toISOString() };
  broadcast('device.power', { id: d.id, power: d.power });
}

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (m !== 'GET' && m !== 'HEAD' && req.headers['x-outband'] !== '1') return err(res, 403, 'csrf_failed', 'Missing X-Outband header');

  if (p === '/api/v1/health') return json(res, 200, { status: 'ok' });

  if (p === '/api/v1/session' && m === 'GET') {
    const s = current(req);
    return json(res, 200, {
      authenticated: Boolean(s?.user),
      user: s?.user ?? null,
      auth_method: s?.user ? 'cookie' : null,
      scopes: s?.user ? ['read', 'power', 'console'] : [],
      server: s?.user ? { name: 'Outband (mock)', version: '1.3.1' } : { name: 'Outband (mock)' },
      twofa: { required: Boolean(s?.pending), methods: s?.pending ? ['otp', 'backup'] : [] },
    });
  }

  if (p === '/api/v1/auth/login' && m === 'POST') {
    const b = await body(req);
    if (!b || typeof b.username !== 'string' || typeof b.password !== 'string') return err(res, 400, 'invalid_request', 'username and password are required');
    const u = users[b.username];
    if (!u || u.password !== b.password) return err(res, 401, 'invalid_credentials', 'Invalid username or password');
    const id = randomBytes(16).toString('hex');
    const cookie = `xid=${id}; Path=/; HttpOnly; SameSite=Strict`;
    if (u.twofa) {
      sessions.set(id, { pending: u.user });
      return json(res, 200, { authenticated: false, needs2fa: true, methods: ['otp', 'backup'] }, { 'Set-Cookie': cookie });
    }
    sessions.set(id, { user: u.user });
    return json(res, 200, { authenticated: true, user: u.user }, { 'Set-Cookie': cookie });
  }

  if (p === '/api/v1/auth/2fa' && m === 'POST') {
    const s = current(req);
    const b = await body(req);
    if (!s?.pending) return err(res, 401, 'no_pending_login', 'No pending login');
    if (b?.send) return json(res, 202, undefined);
    if (b?.token !== OTP) return err(res, 401, 'invalid_token', 'Invalid code');
    s.user = s.pending;
    delete s.pending;
    return json(res, 200, { authenticated: true, user: s.user });
  }

  if (p === '/api/v1/auth/logout' && m === 'POST') {
    const s = sid(req);
    if (s) sessions.delete(s);
    res.writeHead(204, { 'Set-Cookie': 'xid=; Path=/; Max-Age=0' });
    return res.end();
  }

  const s = current(req);
  if (!s?.user) return err(res, 401, 'unauthenticated', 'Sign in first');

  if (p === '/api/v1/server') return json(res, 200, { name: 'Outband (mock)', version: '1.3.1', outband_version: '0.1.0', api_version: '1.0.0-draft.1', features: { amt: true, twofa: true, api_tokens: true, console_kinds: ['sol'], legacy_ui: true } });
  if (p === '/api/v1/groups') return json(res, 200, { items: groups });

  if (p === '/api/v1/devices') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const items = devices.filter((d) => !q || d.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
    return json(res, 200, { items, next_cursor: null });
  }

  let mm = /^\/api\/v1\/devices\/([^/]+)(?:\/(power|events))?$/.exec(p);
  if (mm) {
    const d = find(decodeURIComponent(mm[1]));
    if (!d) return err(res, 404, 'not_found', 'Device not found');
    if (!mm[2] && m === 'GET') {
      return json(res, 200, { ...d, rights: { mask: 4294967295, names: ['admin'] }, description: null, tags: [], agent: null, hardware: null, ...(detailExtra[d.id] ?? {}) });
    }
    if (mm[2] === 'events') return json(res, 200, { items: events.filter((e) => e.device_id === d.id).slice(0, Number(url.searchParams.get('limit') ?? 50)), next_cursor: null });
    if (mm[2] === 'power' && m === 'POST') {
      const b = await body(req);
      const action = b?.action;
      if (!['on', 'off', 'reset', 'cycle', 'sleep', 'wake'].includes(action)) return err(res, 400, 'invalid_request', 'Unknown action');
      if (!d.capabilities.power.includes(action)) return err(res, 409, 'not_reachable', 'No path can carry this action now');
      const via = action === 'on' || action === 'cycle' ? ['amt'] : action === 'wake' ? ['wol'] : d.online ? ['agent'] : ['amt'];
      const ev = makeEvent(d, 'poweraction', `Power action "${action}" via ${via.join('+')}`, { id: s.user.id, name: s.user.name });
      broadcast('event.created', ev);
      setTimeout(() => {
        if (action === 'on' || action === 'wake') setPower(d, 'on');
        else if (action === 'off') setPower(d, 'off');
        else if (action === 'sleep') setPower(d, 'sleep');
      }, 600);
      return json(res, 202, { device_id: d.id, action, via, status: 'dispatched', event_id: ev.id });
    }
  }

  if (p === '/api/v1/events') return json(res, 200, { items: events.slice(0, 50), next_cursor: null });

  if (p === '/api/v1/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`retry: 2000\nid: ${++seq}\nevent: ready\ndata: ${JSON.stringify({ type: 'ready', data: { server_time: new Date().toISOString() } })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  return err(res, 404, 'not_found', 'No such endpoint');
}

async function mockHook(req, res) {
  const b = await body(req);
  const d = b && find(b.id);
  if (!d) return err(res, 404, 'not_found', 'no device');
  if (b.power) setPower(d, b.power);
  if (typeof b.online === 'boolean') {
    d.online = b.online;
    d.connectivity.agent = b.online;
    d.last_seen = new Date().toISOString();
    broadcast('device.updated', d);
  }
  return json(res, 200, { ok: true });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

async function serveStatic(req, res, url) {
  const root = resolve(STATIC);
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!QUIET) console.log(req.method, url.pathname);
  try {
    if (url.pathname === '/__mock/emit' && req.method === 'POST') return await mockHook(req, res);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (STATIC) return await serveStatic(req, res, url);
    err(res, 404, 'not_found', 'Mock serves /api only (use --static to serve the app)');
  } catch (e) {
    console.error(e);
    err(res, 500, 'internal', 'mock error');
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`outband mock on http://127.0.0.1:${PORT}${STATIC ? ` serving ${STATIC}` : ''}`));
