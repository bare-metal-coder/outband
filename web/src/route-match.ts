/** Pure route pattern matching, kept apart from the DOM-bound router. */
/** Match `/devices/:id/:tab?` style patterns. Returns params or null. */
export function match(pattern: string, pathname: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = pathname.split('/').filter(Boolean);
  const params: Record<string, string> = {};
  for (let i = 0; i < Math.max(p.length, s.length); i++) {
    const seg = p[i];
    const val = s[i];
    if (seg === undefined) return null;
    const optional = seg.endsWith('?');
    if (seg.startsWith(':')) {
      if (val === undefined) {
        if (optional) continue;
        return null;
      }
      params[seg.slice(1).replace(/\?$/, '')] = decodeURIComponent(val);
    } else if (seg !== val) return null;
  }
  return params;
}
