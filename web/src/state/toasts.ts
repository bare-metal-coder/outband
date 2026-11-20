import { createSignal } from 'solid-js';

export type ToastKind = 'success' | 'error' | 'info';
export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
}

const [toasts, setToasts] = createSignal<Toast[]>([]);
export { toasts };
let next = 1;

export function dismiss(id: number): void {
  setToasts((list) => list.filter((t) => t.id !== id));
}

/** Successes and info clear after 4s; errors stay until dismissed. */
export function toast(kind: ToastKind, title: string, body?: string): number {
  const id = next++;
  setToasts((list) => [...list.slice(-3), { id, kind, title, body }]);
  if (kind !== 'error') setTimeout(() => dismiss(id), 4000);
  return id;
}
