import { createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import { availableActions, channelName, matches, type Device, type PowerAction } from '../model/device';
import { navigate } from '../router';
import { devices, groupName } from '../state/devices';
import { requestPower } from '../state/power';
import { ChannelLights } from './Lights';
import { Layer } from './Layer';

type Item =
  | { kind: 'device'; id: string; device: Device }
  | { kind: 'action'; id: string; device: Device; action: PowerAction };

const [open, setOpen] = createSignal(false);
export const openPalette = (): void => {
  setOpen(true);
};

/**
 * Cmd/Ctrl-K: jump to a device, or type "<device> <action>" to run a valid
 * power action on it. Actions go through the same confirm step as buttons.
 */
export function Palette(): JSX.Element {
  const [q, setQ] = createSignal('');
  const [sel, setSel] = createSignal(0);

  const items = createMemo<Item[]>(() => {
    const query = q().trim().toLowerCase();
    const words = query.split(/\s+/).filter(Boolean);
    const out: Item[] = [];
    for (const d of devices()) {
      const actions = availableActions(d);
      // "web01 restart": a device term plus an action term.
      const hit = (a: PowerAction, w: string) => a.kind === w || [a.label, ...a.options.map((o) => o.label)].some((l) => l.toLowerCase().startsWith(w));
      const actionHits = actions.filter((a) => words.some((w) => hit(a, w)));
      const devTerms = words.filter((w) => !actions.some((a) => hit(a, w)));
      if (!matches(d, devTerms.join(' '), groupName(d.groupId))) continue;
      if (actionHits.length && devTerms.length) {
        for (const a of actionHits) out.push({ kind: 'action', id: `${d.id}:${a.kind}`, device: d, action: a });
      } else if (!actionHits.length) {
        out.push({ kind: 'device', id: d.id, device: d });
      }
      if (out.length >= 50) break;
    }
    return out;
  });

  const close = () => {
    setOpen(false);
    setQ('');
    setSel(0);
  };

  const run = (it: Item | undefined) => {
    if (!it) return;
    close();
    if (it.kind === 'device') navigate(`/devices/${encodeURIComponent(it.id)}`);
    else requestPower(it.device, it.action);
  };

  const onKey = (e: KeyboardEvent) => {
    const n = items().length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => (n ? (s + 1) % n : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => (n ? (s - 1 + n) % n : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(items()[sel()]);
    }
  };

  return (
    <Show when={open()}>
      <Layer onClose={close} label="Command palette">
        <div class="palette" data-testid="palette">
          <div class="palette-input">
            <input
              autofocus
              placeholder="Jump to a device, or type a device and an action (web01 restart)"
              aria-label="Search devices and actions"
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={items()[sel()] ? `pi-${sel()}` : undefined}
              value={q()}
              onInput={(e) => {
                setQ(e.currentTarget.value);
                setSel(0);
              }}
              onKeyDown={onKey}
            />
            <span class="kbd">esc</span>
          </div>
          <ul class="palette-list" id="palette-list" role="listbox">
            <Show when={items().length} fallback={<li class="empty">No matching devices or actions</li>}>
              <For each={items()}>
                {(it, i) => (
                  <li
                    id={`pi-${i()}`}
                    role="option"
                    class="palette-item"
                    aria-selected={sel() === i()}
                    onMouseMove={() => setSel(i())}
                    onClick={() => run(it)}
                  >
                    <Show
                      when={it.kind === 'action' && it}
                      fallback={
                        <>
                          <span>{it.device.name}</span>
                          <span class="muted mono">{groupName(it.device.groupId)}</span>
                          <span class="hint">
                            <ChannelLights device={it.device} power={false} />
                          </span>
                        </>
                      }
                    >
                      {(a) => (
                        <>
                          <span>{a().action.label}</span>
                          <span class="muted">{a().device.name}</span>
                          <span class="hint state">{a().action.options.map((o) => channelName(o.via)).join(' / ')}</span>
                        </>
                      )}
                    </Show>
                  </li>
                )}
              </For>
            </Show>
          </ul>
          <div class="palette-foot">
            <span><span class="kbd">↑</span> <span class="kbd">↓</span> move</span>
            <span><span class="kbd">enter</span> open or run</span>
            <span><span class="kbd">esc</span> close</span>
          </div>
        </div>
      </Layer>
    </Show>
  );
}
