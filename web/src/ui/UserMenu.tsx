import { createSignal, onCleanup, Show, type JSX } from 'solid-js';
import { session, signOut } from '../state/session';
import { setTheme, theme, type ThemePref } from '../state/theme';
import { Icon } from './Icon';

export function UserMenu(): JSX.Element {
  const [open, setOpen] = createSignal(false);
  let wrap!: HTMLDivElement;
  const onDoc = (e: MouseEvent) => {
    if (!wrap.contains(e.target as Node)) setOpen(false);
  };
  document.addEventListener('mousedown', onDoc);
  onCleanup(() => document.removeEventListener('mousedown', onDoc));

  const themes: { id: ThemePref; label: string }[] = [
    { id: 'system', label: 'System' },
    { id: 'dark', label: 'Dark' },
    { id: 'light', label: 'Light' },
  ];

  return (
    <div class="menu-wrap" ref={wrap} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button
        class="btn btn-ghost btn-icon"
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-label="User menu"
        data-testid="user-menu"
        onClick={() => setOpen(!open())}
      >
        <Icon name="user" />
      </button>
      <Show when={open()}>
        <div class="menu" role="menu">
          <div class="menu-head">
            <div style={{ 'font-weight': 600 }}>{session()?.user?.name}</div>
            <div class="muted mono">{session()?.user?.admin ? 'site admin' : 'user'}</div>
          </div>
          <div class="seg" role="group" aria-label="Theme">
            {themes.map((t) => (
              <button aria-pressed={theme() === t.id} onClick={() => setTheme(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <div class="menu-sep" />
          <button class="menu-item" role="menuitem" data-testid="logout" onClick={() => void signOut()}>
            <Icon name="logout" /> Sign out
          </button>
        </div>
      </Show>
    </div>
  );
}
