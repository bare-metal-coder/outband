import { createSignal, Show, type JSX } from 'solid-js';
import { login, send2faCode, verify2fa, type LoginResult } from '../api/auth';
import { BrandMark } from '../ui/Icon';
import { refreshSession, session, setSignedOutReason, signedOutReason } from '../state/session';

const METHOD_HINT: Record<string, string> = {
  otp: 'the code from your authenticator app',
  backup: 'one of your backup codes',
  email: 'the code we emailed you',
  sms: 'the code we texted you',
  messaging: 'the code we messaged you',
  yubikey: 'your YubiKey (touch it)',
};

/** Username/password, then a second-factor step when the server asks. */
export function Login(): JSX.Element {
  const [step, setStep] = createSignal<'password' | '2fa'>(session()?.pending2fa ? '2fa' : 'password');
  const [methods, setMethods] = createSignal<string[]>(session()?.methods ?? []);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [username, setUsername] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [code, setCode] = createSignal('');

  const handle = async (r: LoginResult) => {
    if (r.kind === 'ok') {
      setSignedOutReason(null);
      await refreshSession();
    } else if (r.kind === 'needs2fa') {
      setMethods(r.methods);
      setStep('2fa');
      setPassword('');
    } else {
      setError(r.message);
      if (r.code === 'no_pending_login') setStep('password');
    }
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy()) return;
    setError(null);
    setBusy(true);
    try {
      await handle(step() === 'password' ? await login(username(), password()) : await verify2fa(code().replace(/\s+/g, '')));
    } finally {
      setBusy(false);
    }
  };

  const hint = () => {
    const m = methods().filter((x) => METHOD_HINT[x]);
    return m.length ? `Enter ${m.map((x) => METHOD_HINT[x]).join(', or ')}.` : 'Enter your verification code.';
  };
  const sendable = () => methods().find((m) => m === 'email' || m === 'sms' || m === 'messaging');

  return (
    <div class="auth">
      <div class="auth-card">
        <div class="auth-head">
          <span class="brand">
            <BrandMark /> Outband
          </span>
          <h1>{step() === 'password' ? `Sign in to ${session()?.serverName ?? 'Outband'}` : 'Two-step verification'}</h1>
          <p class="muted">{step() === 'password' ? 'Out-of-band management for your machines.' : hint()}</p>
        </div>
        <form class="panel auth-form" onSubmit={submit} novalidate>
          <Show when={signedOutReason() && !error()}>
            <div class="notice" role="status" data-testid="signed-out">{signedOutReason()}</div>
          </Show>
          <Show when={error()}>
            <div class="alert" role="alert" data-testid="login-error">
              {error()}
            </div>
          </Show>
          <Show
            when={step() === 'password'}
            fallback={
              <div class="field">
                <label for="code">Verification code</label>
                <input
                  id="code"
                  class="input input-otp"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  autofocus
                  required
                  maxLength={64}
                  aria-invalid={error() ? 'true' : undefined}
                  value={code()}
                  onInput={(e) => setCode(e.currentTarget.value)}
                />
              </div>
            }
          >
            <div class="field">
              <label for="username">Username</label>
              <input
                id="username"
                class="input"
                autocomplete="username"
                autofocus
                required
                aria-invalid={error() ? 'true' : undefined}
                value={username()}
                onInput={(e) => setUsername(e.currentTarget.value)}
              />
            </div>
            <div class="field">
              <label for="password">Password</label>
              <input
                id="password"
                class="input"
                type="password"
                autocomplete="current-password"
                required
                aria-invalid={error() ? 'true' : undefined}
                value={password()}
                onInput={(e) => setPassword(e.currentTarget.value)}
              />
            </div>
          </Show>
          <button
            class="btn btn-primary btn-block"
            type="submit"
            disabled={busy() || (step() === 'password' ? !username() || !password() : code().trim().length < 4)}
          >
            <Show when={busy()}>
              <span class="spinner" aria-hidden="true" />
            </Show>
            {step() === 'password' ? 'Sign in' : 'Verify'}
          </button>
        </form>
        <Show when={step() === '2fa'}>
          <div class="auth-foot">
            <button class="linklike" onClick={() => { setStep('password'); setCode(''); setError(null); }}>
              Use a different account
            </button>
            <Show when={sendable()}>
              {(m) => (
                <button class="linklike" onClick={() => void send2faCode(m()).then((ok) => setError(ok ? null : 'Could not send a code.'))}>
                  Send me a code
                </button>
              )}
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
