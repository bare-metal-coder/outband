/**
 * Devices screen: SHELL ONLY. The full list (groups, search/filter chips,
 * dense table, j/k navigation, 375px stacked rows) is built once the /api/v1
 * spec is signed off. It already reads the live store, so the data path works.
 */
import { For, Show, type JSX } from 'solid-js';
import { relativeTime } from '../model/device';
import { devices, loaded, loadError } from '../state/devices';
import { ChannelLights } from '../ui/Lights';
import { Empty } from '../ui/Empty';

export default function Devices(): JSX.Element {
  return (
    <>
      <div class="page-head">
        <h1 class="grow">Devices</h1>
        <span class="muted mono">{devices().length} devices</span>
      </div>
      <Show when={loaded()} fallback={<div class="panel" style={{ padding: '16px', display: 'grid', gap: '10px' }}><div class="skeleton" /><div class="skeleton" /><div class="skeleton" /></div>}>
        <Show when={!loadError()} fallback={<Empty icon="alert" title="Could not load devices"><p>{loadError()}</p></Empty>}>
          <Show when={devices().length} fallback={<Empty icon="server" title="No devices yet"><p>Devices appear here once an agent connects or Intel AMT is provisioned.</p></Empty>}>
            <ul class="panel" style={{ 'list-style': 'none', margin: 0, padding: 0 }} data-testid="device-list">
              <For each={devices()}>
                {(d) => (
                  <li style={{ display: 'flex', 'align-items': 'center', gap: '12px', 'min-height': 'var(--row)', padding: '0 12px', 'border-bottom': '1px solid var(--line)' }}>
                    <a href={`/devices/${encodeURIComponent(d.id)}`} style={{ flex: 1, 'min-width': 0, overflow: 'hidden', 'text-overflow': 'ellipsis' }}>{d.name}</a>
                    <ChannelLights device={d} />
                    <span class="muted mono">{relativeTime(d.lastSeen)}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Show>
    </>
  );
}
