import { onCleanup, onMount, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';

/**
 * A modal layer: scrim, Esc and outside click close it, Tab is trapped
 * inside, and focus returns to where it was when the layer closes.
 */
export function Layer(props: {
  onClose: () => void;
  label: string;
  role?: 'dialog' | 'alertdialog';
  children: JSX.Element;
  initialFocus?: () => HTMLElement | undefined;
  /** false: Escape and a backdrop click do not close it (for things that must be dismissed deliberately). Default true. */
  dismissable?: boolean;
}): JSX.Element {
  let box!: HTMLDivElement;
  const previous = document.activeElement as HTMLElement | null;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (props.dismissable !== false) props.onClose();
    } else if (e.key === 'Tab') {
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  onMount(() => {
    const target = props.initialFocus?.() ?? box.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
  });
  onCleanup(() => previous?.focus?.());

  return (
    <Portal>
      <div
        class="scrim"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget && props.dismissable !== false) props.onClose();
        }}
        onKeyDown={onKey}
      >
        <div ref={box} role={props.role ?? 'dialog'} aria-modal="true" aria-label={props.label} style={{ width: '100%', display: 'contents' }}>
          {props.children}
        </div>
      </div>
    </Portal>
  );
}
