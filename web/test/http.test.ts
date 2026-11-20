import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, NetworkError, buildUrl, request, setFetch } from '../src/api/http';

afterEach(() => setFetch((i, init) => fetch(i, init)));

describe('http', () => {
  it('sends X-Outband and same-origin credentials on POST, not on GET', async () => {
    const seen: RequestInit[] = [];
    setFetch(async (_u, init) => {
      seen.push(init);
      return new Response('{"ok":1}', { headers: { 'content-type': 'application/json' } });
    });
    await request('GET', '/a');
    await request('POST', '/b', { body: { x: 1 } });
    expect((seen[0]!.headers as Record<string, string>)['X-Outband']).toBeUndefined();
    expect((seen[1]!.headers as Record<string, string>)['X-Outband']).toBe('1');
    expect(seen[1]!.credentials).toBe('same-origin');
    expect(seen[1]!.body).toBe('{"x":1}');
  });
  it('throws ApiError with the spec error message', async () => {
    setFetch(async () => new Response('{"error":{"code":"not_found","message":"Device not found"}}', { status: 404, headers: { 'content-type': 'application/json' } }));
    await expect(request('GET', '/x')).rejects.toMatchObject({ status: 404, message: 'Device not found' });
    await expect(request('GET', '/x')).rejects.toBeInstanceOf(ApiError);
  });
  it('wraps transport failures', async () => {
    setFetch(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(request('GET', '/x')).rejects.toBeInstanceOf(NetworkError);
  });
  it('builds query strings, skipping empty values', () => {
    expect(buildUrl('/d', { limit: 200, cursor: undefined, q: 'a b' })).toBe('/d?limit=200&q=a+b');
  });
});
