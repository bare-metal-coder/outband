/**
 * Thin fetch wrapper used by every Outband API call.
 *
 * - Same-origin cookies (the browser session).
 * - `X-Outband: 1` on every non-GET request (the server's CSRF check).
 * - JSON in, JSON out; non-2xx responses throw an ApiError carrying the
 *   status and the decoded body, so callers can branch on `error.status`.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** Seconds from the `Retry-After` header (429), when sent. */
  readonly retryAfter: number | null;

  constructor(status: number, body: unknown, message?: string, retryAfter: number | null = null) {
    super(message ?? errorMessage(body) ?? `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }

  /** The spec's stable error code (`{error: {code}}`), or null. */
  get code(): string | null {
    return errorCode(this.body);
  }

  /** `error.details`, e.g. `{path: 'amt'}` on a denied power path. */
  get details(): Record<string, unknown> | null {
    const e = (this.body as { error?: { details?: unknown } } | undefined)?.error;
    return e?.details && typeof e.details === 'object' ? (e.details as Record<string, unknown>) : null;
  }
}

export function errorCode(body: unknown): string | null {
  const e = (body as { error?: { code?: unknown } } | null | undefined)?.error;
  return e && typeof e.code === 'string' ? e.code : null;
}

/** Network failure: the request never got an HTTP response. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('Cannot reach the Outband server');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

function errorMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (typeof b.error === 'string') return b.error;
    if (b.error && typeof b.error === 'object' && typeof (b.error as Record<string, unknown>).message === 'string') {
      return (b.error as Record<string, string>).message;
    }
    if (typeof b.message === 'string') return b.message;
  }
  return undefined;
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Extra request headers (e.g. `Idempotency-Key`). */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Return the decoded body for these non-2xx statuses instead of throwing. */
  accept?: number[];
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (input, init) => fetch(input, init);

/** Swap the transport (tests). */
export function setFetch(f: FetchLike): void {
  fetchImpl = f;
}

export function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}${path.includes('?') ? '&' : '?'}${s}` : path;
}

export async function request<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  if (method !== 'GET') headers['X-Outband'] = '1';
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetchImpl(buildUrl(path, opts.query), {
      method,
      headers,
      body,
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new NetworkError(err);
  }

  const data = await decode(res);
  if (res.ok || opts.accept?.includes(res.status)) return data as T;
  const ra = Number(res.headers.get('retry-after'));
  throw new ApiError(res.status, data, undefined, Number.isFinite(ra) && ra > 0 ? ra : null);
}

async function decode(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}
