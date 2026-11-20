import { createSignal } from 'solid-js';
import { getSession, logout as apiLogout, type Session } from '../api/auth';

/** undefined = not loaded yet. */
const [session, setSession] = createSignal<Session | undefined>(undefined);
const [sessionError, setSessionError] = createSignal<string | null>(null);

export { session, sessionError };

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

export function markSignedOut(): void {
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
