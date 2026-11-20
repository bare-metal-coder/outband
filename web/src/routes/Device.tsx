/**
 * Device detail: SHELL ONLY. Overview, power actions, events and the SOL
 * "coming soon" tab are built once the /api/v1 spec is signed off. Power
 * actions already go through state/power.ts (confirm + toast).
 */
import { For, Show, type JSX } from 'solid-js';
import { availableActions } from '../model/device';
import { deviceById } from '../state/devices';
import { busy, requestPower } from '../state/power';
import { ChannelLights } from '../ui/Lights';
import { Empty } from '../ui/Empty';
import { Icon } from '../ui/Icon';

export default function Device(props: { id: string; tab?: string }): JSX.Element {
  const d = () => deviceById(props.id);
  return (
    <Show when={d()} fallback={<Empty icon="server" title="Device not found"><a class="btn" href="/">Back to devices</a></Empty>}>
      {(dev) => (
        <>
          <div class="crumbs">
            <a href="/">Devices</a>
            <Icon name="chevronRight" />
            <span>{dev().groupName}</span>
          </div>
          <div class="page-head">
            <h1 class="grow">{dev().name}</h1>
            <ChannelLights device={dev()} />
          </div>
          <div style={{ display: 'flex', gap: '8px', 'flex-wrap': 'wrap' }}>
            <For each={availableActions(dev())}>
              {(a) => (
                <button class={a.destructive ? 'btn btn-danger' : 'btn'} disabled={busy() === dev().id} onClick={() => requestPower(dev(), a)}>
                  <Icon name={a.kind === 'reset' || a.kind === 'cycle' ? 'restart' : 'power'} />
                  {a.label}
                </button>
              )}
            </For>
          </div>
        </>
      )}
    </Show>
  );
}
