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
  /** Scopes of the credential (a browser session holds them all). */
  scopes: string[];
}

export type LoginResult =
  | { kind: 'ok'; user: SessionUser }
  | { kind: 'needs2fa'; methods: string[]; expiresAt: string | null }
  | { kind: 'error'; code: string; message: string };

export const authPaths = {
  session: `${API}/session`,
  login: `${API}/auth/login`,
  twofa: `${API}/auth/2fa`,
  logout: `${API}/auth/logout`,
  reauth: `${API}/auth/reauth`,
};

interface WireUser {
  id: string;
  name: string;
  email?: string | null;
  siteadmin?: number;
}

const FULL_ADMIN = 0xffffffff;

function adaptUser(u: WireUser): SessionUser {
  return { id: u.id, name: u.name, email: u.email ?? null, admin: u.siteadmin === FULL_ADMIN };
}

interface WireTwoFactor {
  required?: boolean;
  methods?: string[];
  expires_at?: string | null;
}

interface WireSession {
  authenticated: boolean;
  user: WireUser | null;
  scopes?: string[];
  server?: { name?: string; version?: string };
  twofa?: WireTwoFactor;
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
    scopes: s.scopes ?? [],
  };
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Wrong username or password.',
  invalid_code: 'That code was not accepted. Check it and try again.',
  no_pending_login: 'Your sign-in expired. Enter your password again.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  reauth_required: 'Enter your password again first.',
  csrf_failed: 'The server rejected this request. Reload the page and try again.',
  unavailable: 'The Outband API is not available on this server.',
  invalid_host: 'This address is not one the server is configured for.',
};

function failure(err: unknown, fallback: string): LoginResult {
  if (err instanceof ApiError) {
    const code = err.code ?? (err.status === 429 ? 'rate_limited' : `http_${err.status}`);
    const body = err.body as { error?: { message?: string } } | undefined;
    return { kind: 'error', code, message: MESSAGES[code] ?? body?.error?.message ?? fallback };
  }
  return { kind: 'error', code: 'network', message: err instanceof Error ? err.message : fallback };
}

/** `LoginResult` in the spec: success, or a pending login that needs a second factor. */
interface WireLogin {
  authenticated?: boolean;
  user?: WireUser;
  twofa?: WireTwoFactor;
}

function toResult(body: WireLogin | undefined, fallback: string): LoginResult {
  if (body?.authenticated && body.user) return { kind: 'ok', user: adaptUser(body.user) };
  if (body?.authenticated === false && body.twofa?.required) {
    return { kind: 'needs2fa', methods: body.twofa.methods ?? [], expiresAt: body.twofa.expires_at ?? null };
  }
  return { kind: 'error', code: 'unexpected', message: fallback };
}

export async function login(username: string, password: string): Promise<LoginResult> {
  try {
    return toResult(await request<WireLogin>('POST', authPaths.login, { body: { username, password } }), 'Sign-in failed.');
  } catch (err) {
    return failure(err, 'Wrong username or password.');
  }
}

export async function verify2fa(code: string, method?: string): Promise<LoginResult> {
  try {
    const body = method ? { code, method } : { code };
    return toResult(await request<WireLogin>('POST', authPaths.twofa, { body }), 'That code was not accepted.');
  } catch (err) {
    return failure(err, 'That code was not accepted.');
  }
}

export type ReauthResult = { kind: 'ok' } | { kind: 'needs2fa'; methods: string[] } | { kind: 'error'; code: string; message: string };

/**
 * Step-up (spec `reauth`, draft.6): re-check the password, then a second
 * factor when the user has one, on the EXISTING session (no new session or
 * cookie). Step 1 `{password}`: 204 when done, or 200 with `twofa.required`
 * and the methods. Step 2 `{code[, method]}` within 5 minutes: 204.
 * `{method, send: true}`: 202. Wire details stay in this function.
 */
export async function reauth(step: { password: string } | { code: string; method?: string }): Promise<ReauthResult> {
  try {
    const body = await request<{ twofa?: WireTwoFactor } | undefined>('POST', authPaths.reauth, { body: step });
    if (body?.twofa?.required) return { kind: 'needs2fa', methods: body.twofa.methods ?? [] };
    return { kind: 'ok' };
  } catch (err) {
    const r = failure(err, 'That was not accepted.');
    return r.kind === 'error' ? r : { kind: 'error', code: 'unexpected', message: 'That was not accepted.' };
  }
}

/** Have a step-up code sent (email, SMS or messaging). */
export async function sendReauthCode(method: string): Promise<boolean> {
  try {
    await request<void>('POST', authPaths.reauth, { body: { method, send: true } });
    return true;
  } catch {
    return false;
  }
}

/** Ask the server to send a code by email/SMS/messaging (202 on success). */
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
