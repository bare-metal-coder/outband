import { createSignal } from 'solid-js';
import { getSession, logout as apiLogout, type Session } from '../api/auth';

/** undefined = not loaded yet. */
const [session, setSession] = createSignal<Session | undefined>(undefined);
const [sessionError, setSessionError] = createSignal<string | null>(null);

/** Why we were signed out by the server (terminal stream `closed`), shown on the login screen. */
const [signedOutReason, setSignedOutReason] = createSignal<string | null>(null);

export { session, sessionError, signedOutReason, setSignedOutReason };

const REASONS: Record<string, string> = {
  revoked: 'Your session was revoked. Sign in again.',
  expired: 'Your session expired. Sign in again.',
  locked: 'This account is locked.',
  logout: 'You were signed out.',
};

export async function refreshSession(): Promise<Session | undefined> {
  try {
    const s = await getSession();
    setSession(s);
    setSessionError(null);
    return s;
  } catch (err) {
    setSessionError(err instanceof Error ? err.message : 'Cannot reach the server');
    return undefined;
  }
}

export function markSignedOut(reason?: string): void {
  setSignedOutReason(reason ? (REASONS[reason] ?? 'You were signed out.') : null);
  const s = session();
  setSession({
    authenticated: false,
    user: null,
    serverName: s?.serverName ?? 'Outband',
    serverVersion: null,
    pending2fa: false,
    methods: [],
    scopes: [],
  });
}

export async function signOut(): Promise<void> {
  try {
    await apiLogout();
  } finally {
    markSignedOut();
  }
}
