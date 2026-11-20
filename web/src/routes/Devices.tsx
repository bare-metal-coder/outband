/**
 * Devices: group sections, search, filter chips, j/k navigation. Reads the
 * live store, so rows change in place as stream events arrive. At phone width
 * each row stacks (name and lights, then details).
 */
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type JSX } from 'solid-js';
import {
  amtLabel, filterDevices, filtersFromSearch, filtersToSearch, powerLabel, relativeTime, sections, statusMatch,
  type Filters, type PowerFilter, type StatusFilter,
} from '../model/device';
import { navigate, path, search } from '../router';
import { devices, groupName, loaded, loadError } from '../state/devices';
import { Empty } from '../ui/Empty';
import { Icon } from '../ui/Icon';
import { ChannelLights } from '../ui/Lights';

const STATUS: { id: StatusFilter; label: string }[] = [
  { id: 'online', label: 'Online' },
  { id: 'amt', label: 'AMT' },
  { id: 'offline', label: 'Offline' },
];
const POWER: { id: PowerFilter; label: string }[] = [
  { id: 'on', label: 'On' },
  { id: 'off', label: 'Off' },
  { id: 'sleep', label: 'Sleep' },
];

export default function Devices(): JSX.Element {
  // Filters live in the URL (?q=&status=&power=) so a view can be shared and survives reload.
  const filters = createMemo<Filters>(() => filtersFromSearch(search()));
  const setFilters = (f: Partial<Filters>) => navigate(`${path()}${filtersToSearch({ ...filters(), ...f })}`, { replace: true });

  const [selected, setSelected] = createSignal<string | null>(null);
  const visible = createMemo(() => filterDevices(devices(), filters(), groupName));
  const grouped = createMemo(() => sections(visible(), groupName));
  const flat = createMemo(() => grouped().flatMap((s) => s.devices));

  // Counts for the chips ignore that chip's own group, so they show what a click would give.
  const base = createMemo(() => filterDevices(devices(), { ...filters(), status: null, power: null }, groupName));
  const statusCount = (s: StatusFilter) => base().filter((d) => statusMatch(d, s) && (!filters().power || d.power === filters().power)).length;
  const powerCount = (p: PowerFilter) => base().filter((d) => d.power === p && (!filters().status || statusMatch(d, filters().status!))).length;

  // Drop a selection that is no longer visible (filtered out, or the device went away).
  createEffect(on(flat, (list) => {
    const id = selected();
    if (id && !list.some((d) => d.id === id)) setSelected(null);
  }));

  const move = (delta: number) => {
    const list = flat();
    if (!list.length) return;
    const i = list.findIndex((d) => d.id === selected());
    const next = i < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, i + delta));
    setSelected(list[next]!.id);
    queueMicrotask(() => document.querySelector(`[data-row="${CSS.escape(list[next]!.id)}"]`)?.scrollIntoView({ block: 'nearest' }));
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.closest('input,textarea,select,[contenteditable],[role=dialog],[role=alertdialog]')) return;
    if (document.querySelector('[aria-modal=true]')) return;
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter' && selected() && !t.closest('a,button')) {
      e.preventDefault();
      navigate(`/devices/${encodeURIComponent(selected()!)}`);
    }
  };
  document.addEventListener('keydown', onKey);
  onCleanup(() => document.removeEventListener('keydown', onKey));

  const filtering = () => Boolean(filters().query || filters().status || filters().power);

  return (
    <>
      <div class="page-head">
        <h1 class="grow">Devices</h1>
        <span class="muted mono" data-testid="count">
          {visible().length}
          {filtering() ? ` of ${devices().length}` : ''} devices
        </span>
      </div>

      <div class="toolbar">
        <label class="search-field">
          <Icon name="search" />
          <input
            class="input"
            type="search"
            placeholder="Filter by name, address, OS or group"
            aria-label="Filter devices"
            data-testid="filter-input"
            value={filters().query}
            onInput={(e) => setFilters({ query: e.currentTarget.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setFilters({ query: '' });
              else if (e.key === 'ArrowDown' || e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.blur();
                move(1);
              }
            }}
          />
        </label>
        <div class="chips" role="group" aria-label="Filter by status">
          <For each={STATUS}>
            {(c) => (
              <button class="chip" aria-pressed={filters().status === c.id} data-testid={`chip-${c.id}`} onClick={() => setFilters({ status: filters().status === c.id ? null : c.id })}>
                {c.label} <span class="mono">{statusCount(c.id)}</span>
              </button>
            )}
          </For>
        </div>
        <div class="chips" role="group" aria-label="Filter by power state">
          <For each={POWER}>
            {(c) => (
              <button class="chip" aria-pressed={filters().power === c.id} data-testid={`chip-power-${c.id}`} onClick={() => setFilters({ power: filters().power === c.id ? null : c.id })}>
                {c.label} <span class="mono">{powerCount(c.id)}</span>
              </button>
            )}
          </For>
        </div>
        <span class="kbd-hint muted">
          <span class="kbd">j</span> <span class="kbd">k</span> move <span class="kbd">enter</span> open
        </span>
      </div>

      <Show when={loaded()} fallback={<div class="panel" style={{ padding: '16px', display: 'grid', gap: '10px' }}><div class="skeleton" /><div class="skeleton" /><div class="skeleton" /></div>}>
        <Show when={!loadError()} fallback={<Empty icon="alert" title="Could not load devices"><p>{loadError()}</p></Empty>}>
          <Show when={devices().length} fallback={<Empty icon="server" title="No devices yet"><p>Devices appear here once an agent connects or Intel AMT is provisioned.</p></Empty>}>
            <Show
              when={flat().length}
              fallback={
                <Empty icon="filter" title="No devices match">
                  <p>Nothing matches the current filters.</p>
                  <button class="btn" onClick={() => navigate(path(), { replace: true })}>Clear filters</button>
                </Empty>
              }
            >
              <div data-testid="device-list">
                <For each={grouped()}>
                  {(sec) => (
                    <section class="group" aria-labelledby={`g-${sec.groupId}`}>
                      <h2 class="group-head" id={`g-${sec.groupId}`}>
                        {sec.name} <span class="muted mono">{sec.devices.length}</span>
                      </h2>
                      <table class="panel dtable">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Channels</th>
                            <th>OS</th>
                            <th>Power</th>
                            <th>AMT</th>
                            <th>Seen</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={sec.devices}>
                            {(d) => (
                              <tr data-row={d.id} data-selected={String(selected() === d.id)} onMouseDown={() => setSelected(d.id)}>
                                <td class="c-name">
                                  <a href={`/devices/${encodeURIComponent(d.id)}`}>{d.name}</a>
                                  <Show when={d.host && d.host !== d.name}>
                                    <span class="muted mono host">{d.host}</span>
                                  </Show>
                                </td>
                                <td class="c-lights"><ChannelLights device={d} power={false} /></td>
                                <td class="c-os muted">{d.os ?? ''}</td>
                                <td class="c-power"><span class="state" data-power={d.power}>{powerLabel(d.power)}</span></td>
                                <td class="c-amt muted mono">{d.amt.state === 'none' ? '' : amtLabel(d.amt.state)}</td>
                                <td class="c-seen muted mono">{d.online ? 'now' : relativeTime(d.lastSeen)}</td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </section>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </Show>
    </>
  );
}
