import type { JSX } from 'solid-js';

/** Stroke icons on a 24px grid (hand-drawn paths, no icon font). */
const PATHS = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-4.35-4.35',
  power: 'M12 3v8M6.4 6.4a8 8 0 1 0 11.2 0',
  chevronRight: 'm9 6 6 6-6 6',
  chevronDown: 'm6 9 6 6 6-6',
  arrowLeft: 'M19 12H5m6-6-6 6 6 6',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8a7 7 0 0 1 14 0',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4',
  x: 'M6 6l12 12M18 6 6 18',
  check: 'm5 12 5 5 9-10',
  alert: 'M12 8v5m0 3.5v.01M10.3 3.9 2.6 17.3A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.7L13.7 3.9a2 2 0 0 0-3.4 0z',
  terminal: 'M4 5h16v14H4zM7.5 9.5 10 12l-2.5 2.5M12 15h4',
  server: 'M4 4h16v6H4zm0 10h16v6H4zM8 7h.01M8 17h.01',
  restart: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  monitor: 'M3 4h18v12H3zM8 20h8m-4-4v4',
  filter: 'M4 5h16l-6 8v6l-4-2v-4z',
  signal: 'M5 18v-3m5 3v-7m5 7V8m5 10V4',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon(props: { name: IconName; class?: string; title?: string }): JSX.Element {
  return (
    <svg
      class={`icon ${props.class ?? ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={props.title ? undefined : 'true'}
      role={props.title ? 'img' : undefined}
    >
      {props.title && <title>{props.title}</title>}
      <path d={PATHS[props.name]} />
    </svg>
  );
}

/** The Outband mark: a carrier wave stepping outside its band. */
export function BrandMark(props: { class?: string }): JSX.Element {
  return (
    <svg class={props.class ?? 'brand-mark'} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2.5" y="6.5" width="13" height="11" rx="2" stroke="currentColor" stroke-width="1.6" opacity="0.45" />
      <path d="M5 12h3l2-3.5 2.5 7 2.5-5.5 1.5 2H22" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" />
      <circle cx="21" cy="12" r="1.6" fill="currentColor" />
    </svg>
  );
}
