/** Exponential backoff with full jitter. attempt is 0-based. */
export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  random?: () => number;
}

export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 500;
  const max = opts.maxMs ?? 30_000;
  const random = opts.random ?? Math.random;
  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt));
  // Full jitter, but never below half the ceiling so reconnects are not instant.
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}
