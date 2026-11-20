/**
 * Device detail: overview, power actions per capabilities, recent events
 * (paged, live), and the console tab (a placeholder: SOL is a later lane).
 * The list store supplies live fields; the detail fetch adds hardware and agent.
 */
import { createEffect, createResource, createSignal, For, on, onCleanup, Show, type JSX } from 'solid-js';
import { ApiError } from '../api/http';
import { getDevice, listDeviceEvents } from '../api/v1';
import { amtLabel, availableActions, channelName, powerLabel, relativeTime, type DeviceDetail, type DeviceEvent } from '../model/device';
import { deviceById, onLiveEvent, upsertDevice } from '../state/devices';
import { busy, requestPower } from '../state/power';
import { Empty } from '../ui/Empty';
import { Icon } from '../ui/Icon';
import { ChannelLights } from '../ui/Lights';

function Row(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <>
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </>
  );
}

const dash = <span class="muted">-</span>;

function Overview(props: { d: DeviceDetail }): JSX.Element {
  const d = () => props.d;
  const hw = () => d().hardware;
  return (
    <dl class="facts panel" data-testid="overview">
      <Row label="OS">{d().os ?? dash}</Row>
      <Row label="Power">
        <span class="state" data-power={d().power}>{powerLabel(d().power)}</span>
        <Show when={d().powerSince}>
          <span class="muted mono"> since {relativeTime(d().powerSince)}</span>
        </Show>
      </Row>
      <Row label="Intel AMT">
        <span data-testid="amt-state">{amtLabel(d().amt.state)}</span>
        <Show when={d().amt.version}>
          <span class="muted mono"> v{d().amt.version}</span>
        </Show>
        <Show when={d().amt.via}>
          <span class="muted"> via {d().amt.via === 'cira' ? 'CIRA' : 'local network'}</span>
        </Show>
      </Row>
      <Row label="Agent">
        {d().online ? 'Connected' : 'Offline'}
        <Show when={d().agentVersion}>
          <span class="muted mono"> v{d().agentVersion}</span>
        </Show>
      </Row>
      <Row label="Group">{d().groupName || dash}</Row>
      <Row label="Last seen">{d().online ? 'now' : relativeTime(d().lastSeen)}</Row>
      {/* The server leaves addresses and serials out for some credentials, so show them only when present. */}
      <Show when={d().ips.length}>
        <Row label="Addresses">
          <span class="mono" data-testid="ips">{d().ips.join(', ')}</span>
        </Row>
      </Show>
      <Show when={hw()?.manufacturer || hw()?.model}>
        <Row label="Hardware">{[hw()?.manufacturer, hw()?.model].filter(Boolean).join(' ')}</Row>
      </Show>
      <Show when={hw()?.serial}>
        <Row label="Serial">
          <span class="mono" data-testid="serial">{hw()!.serial}</span>
        </Row>
      </Show>
      <Show when={hw()?.cpu}>
        <Row label="CPU">{hw()!.cpu}</Row>
      </Show>
      <Show when={hw()?.memoryMb}>
        <Row label="Memory">{Math.round(hw()!.memoryMb! / 1024)} GB</Row>
      </Show>
    </dl>
  );
}

function Events(props: { id: string }): JSX.Element {
  const [items, setItems] = createSignal<DeviceEvent[]>([]);
  const [next, setNext] = createSignal<string | null>(null);
  const [state, setState] = createSignal<'loading' | 'ready' | 'error'>('loading');
  const [more, setMore] = createSignal(false);

  const load = async (cursor: string | null) => {
    try {
      const page = await listDeviceEvents(props.id, { limit: 25, cursor });
      setItems((cur) => {
        const seen = new Set(cur.map((e) => e.id));
        return [...cur, ...page.items.filter((e) => !seen.has(e.id))];
      });
      setNext(page.next);
      setState('ready');
    } catch {
      setState('error');
    } finally {
      setMore(false);
    }
  };
  createEffect(on(() => props.id, () => { setItems([]); setNext(null); setState('loading'); void load(null); }));

  // Live: new events for this device go on top (deduplicated against the page).
  const off = onLiveEvent((e) => {
    if (e.deviceId !== props.id) return;
    setItems((cur) => (cur.some((x) => x.id === e.id) ? cur : [e, ...cur]));
  });
  onCleanup(off);

  return (
    <section class="events" aria-labelledby="ev-h">
      <h2 id="ev-h" class="group-head">Recent events</h2>
      <Show when={state() !== 'error'} fallback={<div class="alert" role="alert">Could not load events. <button class="linklike" onClick={() => void load(null)}>Retry</button></div>}>
        <Show when={state() === 'ready' || items().length} fallback={<div class="skeleton" />}>
          <Show when={items().length} fallback={<p class="muted">No events yet.</p>}>
            <ul class="panel evlist" data-testid="events">
              <For each={items()}>
                {(e) => (
                  <li data-outcome={e.outcome ?? ''}>
                    <span class="mono muted when" title={e.time}>{relativeTime(e.time)}</span>
                    <span class="msg">{e.message}</span>
                    <span class="muted who">
                      {e.user ?? (e.redacted ? 'a user' : '')}
                      <Show when={e.tokenName}> via {e.tokenName}</Show>
                    </span>
                    <Show when={e.outcome && e.outcome !== 'success'}>
                      <span class="state" data-bad="true">{e.outcome}</span>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
            <Show when={next()}>
              <button class="btn" style={{ 'margin-top': '10px' }} disabled={more()} data-testid="more-events" onClick={() => { setMore(true); void load(next()); }}>
                {more() ? 'Loading...' : 'Load older events'}
              </button>
            </Show>
          </Show>
        </Show>
      </Show>
    </section>
  );
}

export default function Device(props: { id: string; tab?: string }): JSX.Element {
  const [detail] = createResource(
    () => props.id,
    async (id) => {
      try {
        const d = await getDevice(id);
        upsertDevice(d);
        return d;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  );
  // Live fields come from the store; hardware and agent from the detail fetch.
  const view = (): DeviceDetail | undefined => {
    const base = detail();
    const live = deviceById(props.id);
    if (live && base) return { ...base, ...live };
    return base ?? (live ? { ...live, description: null, tags: [], agentVersion: null, hardware: null } : undefined);
  };
  const tab = () => (props.tab === 'console' ? 'console' : 'overview');

  return (
    <Show
      when={view()}
      fallback={
        <Show when={!detail.loading} fallback={<div class="skeleton" style={{ width: '40%' }} />}>
          <Empty icon="server" title="Device not found">
            <p>It may have been removed, or you may not be able to see it.</p>
            <a class="btn" href="/">Back to devices</a>
          </Empty>
        </Show>
      }
    >
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
          <div class="actions-row" data-testid="power-actions">
            <For each={availableActions(dev())} fallback={<span class="muted">No power actions are available for this device right now.</span>}>
              {(a) => (
                <button class={a.destructive ? 'btn btn-danger' : 'btn'} disabled={busy() === dev().id} data-action={a.kind} onClick={() => requestPower(dev(), a)}>
                  <Icon name={a.kind === 'reset' || a.kind === 'cycle' ? 'restart' : 'power'} />
                  {a.label}
                  <Show when={a.options.length > 1}>
                    <span class="muted mono">{a.options.map((o) => channelName(o.via)).join(' / ')}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
          <nav class="tabs" aria-label="Device sections">
            <a href={`/devices/${encodeURIComponent(dev().id)}`} aria-current={tab() === 'overview' ? 'page' : undefined}>Overview</a>
            <a href={`/devices/${encodeURIComponent(dev().id)}/console`} aria-current={tab() === 'console' ? 'page' : undefined} data-testid="tab-console">Console</a>
          </nav>
          <Show when={tab() === 'overview'} fallback={
            <Empty icon="terminal" title="Console is coming">
              <p>
                {dev().can.console.includes('sol')
                  ? 'Serial-over-LAN over Intel AMT will open here in a later release.'
                  : 'This device has no text console available to you right now.'}
              </p>
            </Empty>
          }>
            <Overview d={dev()} />
            <Events id={dev().id} />
          </Show>
        </>
      )}
    </Show>
  );
}
