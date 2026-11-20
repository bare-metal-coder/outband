import { For, type JSX } from 'solid-js';
import { dismiss, toasts } from '../state/toasts';
import { Icon } from './Icon';

export function Toasts(): JSX.Element {
  return (
    <div class="toasts" role="region" aria-label="Notifications">
      <For each={toasts()}>
        {(t) => (
          <div class="toast" data-kind={t.kind} role={t.kind === 'error' ? 'alert' : 'status'}>
            <div class="body">
              <div class="title">{t.title}</div>
              {t.body && <div class="muted">{t.body}</div>}
            </div>
            <button class="btn btn-ghost btn-icon" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <Icon name="x" />
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
