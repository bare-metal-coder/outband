/** Browser session and login (/api/v1/session, /api/v1/auth/*). */
import { ApiError, request } from './http';
import { API } from './v1';

export interface SessionUser {
  id: string;
  name: string;
  email: string | null;
  admin: boolean;
}

export interface Session {
  authenticated: boolean;
  user: SessionUser | null;
  serverName: string;
  serverVersion: string | null;
  /** A password was accepted and a second factor is pending. */
  pending2fa: boolean;
  methods: string[];
}

export type LoginResult =
  | { kind: 'ok'; user: SessionUser }
  | { kind: 'needs2fa'; methods: string[] }
  | { kind: 'error'; code: string; message: string };

export const authPaths = {
  session: `${API}/session`,
  login: `${API}/auth/login`,
  twofa: `${API}/auth/2fa`,
  logout: `${API}/auth/logout`,
};

interface WireUser {
  id: string;
  name: string;
  email?: string | null;
  siteadmin?: number | boolean;
}

const FULL_ADMIN = 0xffffffff;

function adaptUser(u: WireUser): SessionUser {
  return {
    id: u.id,
    name: u.name,
    email: u.email ?? null,
    admin: u.siteadmin === true || u.siteadmin === FULL_ADMIN,
  };
}

interface WireSession {
  authenticated: boolean;
  user: WireUser | null;
  server?: { name?: string; version?: string };
  twofa?: { required?: boolean; methods?: string[] };
}

export async function getSession(signal?: AbortSignal): Promise<Session> {
  const s = await request<WireSession>('GET', authPaths.session, { signal });
  return {
    authenticated: Boolean(s.authenticated && s.user),
    user: s.user ? adaptUser(s.user) : null,
    serverName: s.server?.name || 'Outband',
    serverVersion: s.server?.version ?? null,
    pending2fa: Boolean(s.twofa?.required),
    methods: s.twofa?.methods ?? [],
  };
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Wrong username or password.',
  invalid_token: 'That code was not accepted. Check it and try again.',
  no_pending_login: 'Your sign-in expired. Enter your password again.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  locked_out: 'This account is temporarily locked. Try again later.',
  csrf_failed: 'The server rejected this request. Reload the page and try again.',
};

function failure(err: unknown, fallback: string): LoginResult {
  if (err instanceof ApiError) {
    const body = err.body as { error?: { code?: string; message?: string } } | undefined;
    const code = body?.error?.code ?? (err.status === 429 ? 'rate_limited' : `http_${err.status}`);
    return { kind: 'error', code, message: MESSAGES[code] ?? body?.error?.message ?? fallback };
  }
  return { kind: 'error', code: 'network', message: err instanceof Error ? err.message : fallback };
}

interface WireLogin {
  authenticated?: boolean;
  user?: WireUser;
  needs2fa?: boolean;
  methods?: string[];
}

function toResult(body: WireLogin | undefined, fallback: string): LoginResult {
  if (body?.authenticated && body.user) return { kind: 'ok', user: adaptUser(body.user) };
  if (body?.needs2fa) return { kind: 'needs2fa', methods: body.methods ?? [] };
  return { kind: 'error', code: 'unexpected', message: fallback };
}

export async function login(username: string, password: string): Promise<LoginResult> {
  try {
    return toResult(await request<WireLogin>('POST', authPaths.login, { body: { username, password } }), 'Sign-in failed.');
  } catch (err) {
    return failure(err, 'Wrong username or password.');
  }
}

export async function verify2fa(token: string): Promise<LoginResult> {
  try {
    return toResult(await request<WireLogin>('POST', authPaths.twofa, { body: { token } }), 'That code was not accepted.');
  } catch (err) {
    return failure(err, 'That code was not accepted.');
  }
}

/** Ask the server to send a code by email/SMS (202 on success). */
export async function send2faCode(method: string): Promise<boolean> {
  try {
    await request<void>('POST', authPaths.twofa, { body: { method, send: true } });
    return true;
  } catch {
    return false;
  }
}

export async function logout(): Promise<void> {
  await request<void>('POST', authPaths.logout);
}
