/** One flow for every power action: confirm if destructive, call, toast. */
import { createSignal } from 'solid-js';
import { ApiError } from '../api/http';
import { powerAction } from '../api/v1';
import type { Device, PowerAction } from '../model/device';
import { toast } from './toasts';

export interface PendingConfirm {
  device: Device;
  action: PowerAction;
}

const [pending, setPending] = createSignal<PendingConfirm | null>(null);
const [busy, setBusy] = createSignal<string | null>(null);
export { pending, busy };

const CHANNEL: Record<PowerAction['channel'], string> = { agent: 'agent', amt: 'Intel AMT', wol: 'Wake-on-LAN' };
export const channelName = (c: PowerAction['channel']): string => CHANNEL[c];

const ERRORS: Record<string, string> = {
  not_reachable: 'No channel can carry this action right now.',
  forbidden: 'You do not have the right to do this on this device.',
  insufficient_scope: 'Your credential does not allow power actions.',
  rate_limited: 'Too many power actions. Wait a moment and try again.',
  not_found: 'This device no longer exists or you cannot see it.',
};

/** Start an action. Destructive ones wait for confirm(). */
export function requestPower(device: Device, action: PowerAction): void {
  if (action.destructive) setPending({ device, action });
  else void run(device, action);
}

export function cancelConfirm(): void {
  setPending(null);
}

export async function confirmPending(): Promise<void> {
  const p = pending();
  if (!p) return;
  setPending(null);
  await run(p.device, p.action);
}

async function run(device: Device, action: PowerAction): Promise<void> {
  setBusy(device.id);
  try {
    const res = await powerAction(device.id, action.kind);
    const via = res.via?.length ? res.via.join(' + ') : CHANNEL[action.channel];
    toast('success', `${action.label} sent to ${device.name}`, `Dispatched via ${via}. The state updates when the device responds.`);
  } catch (err) {
    let msg = err instanceof Error ? err.message : 'Unknown error';
    if (err instanceof ApiError) {
      const code = (err.body as { error?: { code?: string } } | undefined)?.error?.code;
      if (code && ERRORS[code]) msg = ERRORS[code];
    }
    toast('error', `${action.label} failed on ${device.name}`, msg);
  } finally {
    setBusy(null);
  }
}
