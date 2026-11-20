import { createSignal } from 'solid-js';

export type ThemePref = 'system' | 'dark' | 'light';
const KEY = 'outband.theme';

function load(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch {
    /* storage unavailable */
  }
  return 'system';
}

const [theme, setThemeSignal] = createSignal<ThemePref>(load());
export { theme };

function apply(t: ThemePref) {
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
}

apply(theme());

export function setTheme(t: ThemePref): void {
  setThemeSignal(t);
  apply(t);
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* storage unavailable */
  }
}
