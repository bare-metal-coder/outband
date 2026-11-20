/** A tiny history router: a path signal, pattern matching and link interception. */
import { createSignal } from 'solid-js';

const [path, setPath] = createSignal(location.pathname);
const [search, setSearch] = createSignal(location.search);

export { path, search };

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const url = new URL(to, location.origin);
  if (url.pathname + url.search === location.pathname + location.search) return;
  if (opts.replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  setPath(url.pathname);
  setSearch(url.search);
  window.scrollTo(0, 0);
}

addEventListener('popstate', () => {
  setPath(location.pathname);
  setSearch(location.search);
});

// Intercept same-origin <a href> clicks so links do not reload the app.
document.addEventListener('click', (ev) => {
  if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  const a = (ev.target as Element | null)?.closest?.('a');
  if (!a || a.target || a.hasAttribute('download') || a.dataset.external !== undefined) return;
  const href = a.getAttribute('href');
  if (!href || !href.startsWith('/')) return;
  ev.preventDefault();
  navigate(href);
});

export { match } from './route-match';
