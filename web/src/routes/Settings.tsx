/** Settings. One section for now: "API tokens" (list, create, revoke). */
import { createMemo, createResource, createSignal, For, Show, type JSX } from 'solid-js';
import { reauth, sendReauthCode } from '../api/auth';
import { ApiError } from '../api/http';
import { createToken, listTokens, revokeToken, type CreatedToken } from '../api/v1';
import { relativeTime } from '../model/device';
import {
  createBody, formScopes, maxDays, needsStepUp, SCOPES, tokenStatus, validateTokenForm, type ApiToken, type Scope, type TokenForm,
} from '../model/token';
import { groups } from '../state/devices';
import { toast } from '../state/toasts';
import { Empty } from '../ui/Empty';
import { Layer } from '../ui/Layer';

const TOKEN_ERRORS: Record<string, string> = {
  token_limit: 'You already have 50 live tokens. Revoke one first.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
  insufficient_scope: 'This session cannot create tokens.',
  forbidden: 'Only a browser session can manage tokens.',
};

const dateOnly = (iso: string | null): string => (iso ? iso.slice(0, 10) : 'never');

/** Copy text; falls back to a hidden textarea where the async clipboard is unavailable. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      return document.execCommand('copy');
    } finally {
      ta.remove();
    }
  }
}

function SecretDialog(props: { created: CreatedToken; onClose: () => void }): JSX.Element {
  const [copied, setCopied] = createSignal(false);
  return (
    // Not dismissable: the secret can never be shown again, so only the button closes this.
    <Layer onClose={props.onClose} label="New API token" dismissable={false}>
      <div class="dialog dialog-wide" data-testid="secret-dialog">
        <h2>Token created</h2>
        <p class="muted">
          Copy <strong>{props.created.token.name}</strong> now. It is shown only once; Outband keeps just a hash and cannot show it again.
        </p>
        <div class="secret">
          <code class="mono" data-testid="secret">{props.created.secret}</code>
          <button class="btn" data-testid="copy-secret" onClick={async () => setCopied(await copyText(props.created.secret))}>
            {copied() ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div class="actions">
          <button class="btn btn-primary" data-testid="secret-done" onClick={props.onClose}>I have saved it</button>
        </div>
      </div>
    </Layer>
  );
}

/** Re-enter the password (and a second factor when asked): the spec's step-up for sensitive scopes. */
function StepUpDialog(props: { onDone: () => void; onCancel: () => void }): JSX.Element {
  const [step, setStep] = createSignal<'password' | 'code'>('password');
  const [methods, setMethods] = createSignal<string[]>([]);
  const [value, setValue] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await reauth(step() === 'password' ? { password: value() } : { code: value().replace(/\s+/g, '') });
      if (r.kind === 'ok') props.onDone();
      else if (r.kind === 'needs2fa') {
        setMethods(r.methods);
        setStep('code');
        setValue('');
      } else {
        setError(r.message);
        if (r.code === 'reauth_required') setStep('password'); // the 5 minutes for the code ran out
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Layer onClose={props.onCancel} label="Confirm it is you">
      <form class="dialog" onSubmit={submit} data-testid="stepup-dialog">
        <h2>Confirm it is you</h2>
        <p class="muted">
          {step() === 'password' ? 'Tokens that can control machines need a recent sign-in. Enter your password to continue.' : 'Enter your verification code.'}
        </p>
        <Show when={error()}>
          <div class="alert" role="alert" style={{ 'margin-top': '10px' }}>{error()}</div>
        </Show>
        <div class="field" style={{ 'margin-top': '12px' }}>
          <label for="stepup">{step() === 'password' ? 'Password' : 'Verification code'}</label>
          <input
            id="stepup"
            class="input"
            type={step() === 'password' ? 'password' : 'text'}
            autocomplete={step() === 'password' ? 'current-password' : 'one-time-code'}
            inputmode={step() === 'password' ? undefined : 'numeric'}
            value={value()}
            onInput={(e) => setValue(e.currentTarget.value)}
          />
        </div>
        <Show when={step() === 'code' && methods().find((m) => m === 'email' || m === 'sms' || m === 'messaging')}>
          {(m) => (
            <button type="button" class="linklike" onClick={() => void sendReauthCode(m()).then((ok) => setError(ok ? null : 'Could not send a code.'))}>
              Send me a code
            </button>
          )}
        </Show>
        <div class="actions">
          <button type="button" class="btn" onClick={props.onCancel}>Cancel</button>
          <button type="submit" class="btn btn-primary" disabled={busy() || value().trim().length < (step() === 'password' ? 1 : 4)} data-testid="stepup-submit">Continue</button>
        </div>
      </form>
    </Layer>
  );
}

function CreateDialog(props: { onClose: () => void; onCreated: (c: CreatedToken) => void }): JSX.Element {
  const [form, setForm] = createSignal<TokenForm>({ name: '', mode: 'profile', scopes: ['read'], groups: [], days: 90 });
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [stepUp, setStepUp] = createSignal(false);
  const patch = (p: Partial<TokenForm>) => setForm((f) => ({ ...f, ...p }));
  const max = createMemo(() => maxDays(formScopes(form())));
  const toggle = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      props.onCreated(await createToken(createBody(form())));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'reauth_required') setStepUp(true);
      else setError(err instanceof ApiError ? (TOKEN_ERRORS[err.code ?? ''] ?? err.message) : err instanceof Error ? err.message : 'Could not create the token.');
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: Event) => {
    e.preventDefault();
    const problem = validateTokenForm(form());
    if (problem) return setError(problem);
    void send();
  };

  return (
    <>
      <Layer onClose={props.onClose} label="Create API token">
        <form class="dialog dialog-wide" onSubmit={submit} novalidate data-testid="create-dialog">
          <h2>Create API token</h2>
          <Show when={error()}>
            <div class="alert" role="alert" data-testid="create-error" style={{ margin: '10px 0' }}>{error()}</div>
          </Show>
          <div class="field">
            <label for="tname">Name</label>
            <input id="tname" class="input" maxLength={64} placeholder="home-automation" value={form().name} onInput={(e) => patch({ name: e.currentTarget.value })} />
          </div>
          <fieldset class="field">
            <legend>Permissions</legend>
            <label class="choice" data-checked={String(form().mode === 'profile')}>
              <input type="radio" name="mode" checked={form().mode === 'profile'} onChange={() => patch({ mode: 'profile', days: Math.min(form().days, 90) })} data-testid="mode-profile" />
              <span><span class="choice-label">Device power</span><span class="muted choice-detail">Read devices, and power them on and off. The profile for automation.</span></span>
            </label>
            <label class="choice" data-checked={String(form().mode === 'custom')}>
              <input type="radio" name="mode" checked={form().mode === 'custom'} onChange={() => patch({ mode: 'custom' })} data-testid="mode-custom" />
              <span><span class="choice-label">Choose scopes</span><span class="muted choice-detail">Pick exactly what the token may do.</span></span>
            </label>
          </fieldset>
          <Show when={form().mode === 'custom'}>
            <div class="scopes" role="group" aria-label="Scopes">
              <For each={SCOPES}>
                {(s) => (
                  <label class="scope">
                    <input type="checkbox" checked={form().scopes.includes(s.id)} onChange={() => patch({ scopes: toggle<Scope>(form().scopes, s.id) })} data-testid={`scope-${s.id}`} />
                    <span><span class="mono">{s.id}</span> <span class="muted">{s.detail}</span></span>
                  </label>
                )}
              </For>
            </div>
          </Show>
          <fieldset class="field">
            <legend>Limit to groups <span class="muted">(optional{formScopes(form()).includes('console') ? ', required for console' : ''})</span></legend>
            <div class="scopes">
              <For each={groups()} fallback={<span class="muted">No groups.</span>}>
                {(g) => (
                  <label class="scope">
                    <input type="checkbox" checked={form().groups.includes(g.id)} onChange={() => patch({ groups: toggle(form().groups, g.id) })} />
                    <span>{g.name}</span>
                  </label>
                )}
              </For>
            </div>
          </fieldset>
          <div class="field">
            <label for="tdays">Expires in (days, at most {max()})</label>
            <input id="tdays" class="input" type="number" min="1" max={max()} value={form().days} style={{ width: '120px' }} onInput={(e) => patch({ days: Number(e.currentTarget.value) })} />
          </div>
          <Show when={needsStepUp(formScopes(form()))}>
            <p class="muted">You may be asked to confirm your password.</p>
          </Show>
          <div class="actions">
            <button type="button" class="btn" onClick={props.onClose}>Cancel</button>
            <button type="submit" class="btn btn-primary" disabled={busy()} data-testid="create-submit">
              <Show when={busy()}><span class="spinner" aria-hidden="true" /></Show>
              Create token
            </button>
          </div>
        </form>
      </Layer>
      <Show when={stepUp()}>
        <StepUpDialog
          onCancel={() => setStepUp(false)}
          onDone={() => {
            setStepUp(false);
            void send();
          }}
        />
      </Show>
    </>
  );
}

function TokenRow(props: { t: ApiToken; onRevoke: (t: ApiToken) => void }): JSX.Element {
  const status = () => tokenStatus(props.t);
  const groupNames = () => (props.t.groupIds ? props.t.groupIds.map((id) => groups().find((g) => g.id === id)?.name ?? 'unknown group').join(', ') : 'all groups');
  return (
    <li class="token" data-status={status()} data-testid="token-row">
      <div class="t-main">
        <span class="t-name">{props.t.name}</span>
        <span class="mono muted">{props.t.prefix}...</span>
        <Show when={status() !== 'active'}><span class="state" data-bad={status() === 'revoked'}>{status()}</span></Show>
      </div>
      <div class="t-scopes">
        <For each={props.t.scopes}>{(s) => <span class="chip-static mono">{s}</span>}</For>
      </div>
      <div class="t-meta muted">
        {groupNames()} | expires {dateOnly(props.t.expiresAt)} | last used {props.t.lastUsedAt ? relativeTime(props.t.lastUsedAt) : 'never'}
      </div>
      <div class="t-act">
        <Show when={status() === 'active'}>
          <button class="btn btn-danger" aria-label={`Revoke ${props.t.name}`} data-testid="revoke" onClick={() => props.onRevoke(props.t)}>Revoke</button>
        </Show>
      </div>
    </li>
  );
}

function Tokens(): JSX.Element {
  const [tokens, { refetch }] = createResource(() => listTokens());
  const [creating, setCreating] = createSignal(false);
  const [created, setCreated] = createSignal<CreatedToken | null>(null);
  const [revoking, setRevoking] = createSignal<ApiToken | null>(null);

  const doRevoke = async () => {
    const t = revoking();
    setRevoking(null);
    if (!t) return;
    try {
      await revokeToken(t.id);
      toast('success', `Revoked ${t.name}`, 'It stops working at once.');
    } catch (err) {
      toast('error', `Could not revoke ${t.name}`, err instanceof Error ? err.message : undefined);
    }
    void refetch();
  };

  return (
    <>
      <div class="page-head">
        <h2 class="grow" style={{ 'font-size': '15px' }}>API tokens</h2>
        <button class="btn btn-primary" data-testid="new-token" onClick={() => setCreating(true)}>Create token</button>
      </div>
      <p class="muted" style={{ 'margin-bottom': '12px' }}>Tokens let scripts and automation use the Outband API as you, limited to the scopes you give them.</p>
      <Show when={!tokens.error} fallback={<div class="alert" role="alert">Could not load tokens. <button class="linklike" onClick={() => void refetch()}>Retry</button></div>}>
        <Show when={tokens()} fallback={<div class="skeleton" />}>
          {(list) => (
            <Show when={list().length} fallback={<Empty icon="terminal" title="No API tokens"><p>Create one for scripts or automation.</p></Empty>}>
              <ul class="panel tokens" data-testid="tokens">
                <For each={list()}>{(t) => <TokenRow t={t} onRevoke={setRevoking} />}</For>
              </ul>
            </Show>
          )}
        </Show>
      </Show>
      <Show when={creating()}>
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            setCreated(c);
            void refetch();
          }}
        />
      </Show>
      <Show when={created()}>{(c) => <SecretDialog created={c()} onClose={() => setCreated(null)} />}</Show>
      <Show when={revoking()}>
        {(t) => (
          <Layer onClose={() => setRevoking(null)} label="Revoke token" role="alertdialog">
            <div class="dialog" data-testid="revoke-dialog">
              <h2>Revoke <span class="mono">{t().name}</span>?</h2>
              <p class="muted">Anything using this token stops working immediately. This cannot be undone.</p>
              <div class="actions">
                <button class="btn" onClick={() => setRevoking(null)}>Cancel</button>
                <button class="btn btn-danger" data-testid="confirm-revoke" onClick={() => void doRevoke()}>Revoke</button>
              </div>
            </div>
          </Layer>
        )}
      </Show>
    </>
  );
}

export default function Settings(_props: { section?: string }): JSX.Element {
  return (
    <>
      <div class="page-head"><h1 class="grow">Settings</h1></div>
      <nav class="tabs" aria-label="Settings sections">
        <a href="/settings/tokens" aria-current="page">API tokens</a>
      </nav>
      <Tokens />
    </>
  );
}
