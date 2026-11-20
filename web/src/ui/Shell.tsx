import { onCleanup, type JSX } from 'solid-js';
import { streamStatus } from '../state/devices';
import { BrandMark, Icon } from './Icon';
import { openPalette, Palette } from './Palette';
import { UserMenu } from './UserMenu';
import { ConfirmPower } from './ConfirmPower';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

/** Signed-in chrome: carrier line, top bar, palette, confirm layer. */
export function Shell(props: { children: JSX.Element }): JSX.Element {
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    const typing = t.closest('input,textarea,select,[contenteditable]');
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openPalette();
    } else if (e.key === '/' && !typing) {
      e.preventDefault();
      openPalette();
    }
  };
  document.addEventListener('keydown', onKey);
  onCleanup(() => document.removeEventListener('keydown', onKey));

  const statusText = () =>
    ({ idle: 'Live updates off', connecting: 'Connecting to live updates', live: 'Live updates connected', down: 'Live updates down, retrying' })[
      streamStatus()
    ];

  return (
    <div class="shell">
      <a class="skip" href="#main">
        Skip to content
      </a>
      <div class="carrier" data-state={streamStatus()} role="status" aria-label={statusText()} title={statusText()} data-testid="carrier" />
      <header class="topbar">
        <a class="brand" href="/">
          <BrandMark />
          Outband
        </a>
        <span class="spacer" />
        <button class="search-trigger" onClick={openPalette} aria-label="Search devices and actions" aria-keyshortcuts="Control+K Meta+K /">
          <Icon name="search" />
          <span class="label">Search or run…</span>
          <span class="kbd">{isMac ? '⌘K' : 'Ctrl K'}</span>
        </button>
        <UserMenu />
      </header>
      <main id="main" class="main" tabindex="-1">
        {props.children}
      </main>
      <Palette />
      <ConfirmPower />
    </div>
  );
}
