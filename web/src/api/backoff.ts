/**
 * Reconnect timing from the spec (`streamEvents`, "Retry timing"): wait the base
 * (5 s) plus a random 0-5 s, double the base after each failed attempt up to
 * 60 s. The caller resets `attempt` after a stream stayed open for 60 s.
 * `attempt` is 0-based.
 */
export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  jitterMs?: number;
  random?: () => number;
}

export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 5000;
  const max = opts.maxMs ?? 60_000;
  const jitter = opts.jitterMs ?? 5000;
  const random = opts.random ?? Math.random;
  return Math.round(Math.min(max, base * 2 ** Math.max(0, attempt)) + random() * jitter);
}
