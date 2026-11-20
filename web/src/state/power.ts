/** One flow for every power action: choose a path and confirm if needed, call, toast. */
import { createSignal } from 'solid-js';
import { ApiError } from '../api/http';
import { newIdempotencyKey, powerAction } from '../api/v1';
import { channelName, pathsName, type Device, type PowerAction, type PowerOption } from '../model/device';
import { toast } from './toasts';

export interface PendingConfirm {
  device: Device;
  action: PowerAction;
}

const [pending, setPending] = createSignal<PendingConfirm | null>(null);
/** Index into `pending().action.options`: what the user picked in the dialog. */
const [choice, setChoice] = createSignal(0);
const [busy, setBusy] = createSignal<string | null>(null);
export { pending, choice, setChoice, busy };

/** Plain-language reasons for the spec's power errors. */
export function powerErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return err instanceof Error ? err.message : 'Unknown error';
  const path = typeof err.details?.path === 'string' ? channelName(err.details.path) : null;
  switch (err.code) {
    case 'not_reachable': {
      const avail = Array.isArray(err.details?.available_paths) ? (err.details.available_paths as string[]).map(channelName) : [];
      if (avail.length || (path && typeof err.details?.available_paths !== 'undefined')) {
        return `The default path (${path ?? 'unknown'}) cannot carry this right now. ${avail.length ? `Available: ${avail.join(', ')}.` : 'No other path is available.'} Nothing was sent.`;
      }
      return `${path ?? 'That path'} cannot carry this action right now. Nothing was sent.`;
    }
    case 'forbidden':
      return path ? `You do not have the right to do this through ${path}. Nothing was sent.` : 'You do not have the right to do this on this device.';
    case 'insufficient_scope':
      return 'Your credential does not allow this power action.';
    case 'rate_limited':
      return err.retryAfter ? `Too many power actions. Try again in ${err.retryAfter}s.` : 'Too many power actions. Wait a moment and try again.';
    case 'not_found':
      return 'This device no longer exists or you cannot see it.';
    case 'idempotency_conflict':
      return 'That request was already sent with different details. Try again.';
    case 'unauthenticated':
    case 'token_revoked':
    case 'token_expired':
      return 'Your session ended. Sign in again.';
    case 'bearer_disabled':
      return 'API token access is switched off on this server for now.';
    case 'reauth_required':
      return 'Confirm your password to continue.';
    default:
      return err.message;
  }
}

/**
 * Start an action. Every power action, however mild, waits for confirm():
 * a stray key in the palette must never power a machine on or off.
 */
export function requestPower(device: Device, action: PowerAction): void {
  if (busy() !== null) return;
  setChoice(0);
  setPending({ device, action });
}

export function cancelConfirm(): void {
  setPending(null);
}

export async function confirmPending(): Promise<void> {
  const p = pending();
  if (!p) return;
  const opt = p.action.options[choice()] ?? p.action.options[0]!;
  setPending(null);
  await run(p.device, p.action, opt);
}

async function run(device: Device, action: PowerAction, opt: PowerOption): Promise<void> {
  setBusy(device.id);
  try {
    const res = await powerAction(device.id, action.kind, { via: opt.via ?? undefined, key: newIdempotencyKey() });
    const paths = res.paths.length ? pathsName(res.paths as never) : pathsName(opt.paths) || 'the server default';
    toast('success', `${opt.label} sent to ${device.name}`, `Dispatched via ${paths}. The state updates when the device responds.`);
  } catch (err) {
    toast('error', `${opt.label} failed on ${device.name}`, powerErrorMessage(err));
  } finally {
    setBusy(null);
  }
}
