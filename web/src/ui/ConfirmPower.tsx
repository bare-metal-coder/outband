import { For, Show, type JSX } from 'solid-js';
import { channelName, pathsName } from '../model/device';
import { cancelConfirm, choice, confirmPending, pending, setChoice } from '../state/power';
import { Layer } from './Layer';

/**
 * The confirm step for power actions. Names the device and the path. When the
 * server offers more than one path (graceful agent vs hard Intel AMT) every
 * choice is listed, the default first and pre-selected.
 */
export function ConfirmPower(): JSX.Element {
  let cancelBtn: HTMLButtonElement | undefined;
  return (
    <Show when={pending()}>
      {(p) => {
        const opt = () => p().action.options[choice()] ?? p().action.options[0]!;
        const many = () => p().action.options.length > 1;
        return (
          <Layer onClose={cancelConfirm} label={`Confirm ${opt().label}`} role="alertdialog" initialFocus={() => cancelBtn}>
            <div class="dialog" data-testid="confirm-dialog">
              <h2>
                {many() ? p().action.label : opt().label} <span class="mono">{p().device.name}</span>?
              </h2>
              <Show
                when={many()}
                fallback={
                  <>
                    <p class="muted">{opt().detail}</p>
                    <p class="muted" style={{ 'margin-top': '10px' }}>
                      Path:{' '}
                      <Show
                        when={opt().via === null}
                        fallback={<span class="state">{channelName(opt().via!)}</span>}
                      >
                        <span data-testid="path-default">
                          server default
                          <Show when={opt().paths.length}>
                            {' '}(usually <span class="state">{pathsName(opt().paths)}</span>)
                          </Show>
                        </span>
                      </Show>
                    </p>
                  </>
                }
              >
                <fieldset class="choices" role="radiogroup" aria-label="How to carry it out">
                  <For each={p().action.options}>
                    {(o, i) => (
                      <label class="choice" data-checked={String(choice() === i())}>
                        <input type="radio" name="power-via" checked={choice() === i()} onChange={() => setChoice(i())} data-testid={`via-${o.via ?? 'default'}`} />
                        <span>
                          <span class="choice-label">
                            {o.label}
                            <Show when={o.via === null}>
                              <span class="state"> default</span>
                            </Show>
                          </span>
                          <span class="muted choice-detail">{o.detail}</span>
                        </span>
                      </label>
                    )}
                  </For>
                </fieldset>
              </Show>
              <div class="actions">
                <button ref={cancelBtn} class="btn" onClick={cancelConfirm}>
                  Cancel
                </button>
                <button class={p().action.destructive ? 'btn btn-danger' : 'btn btn-primary'} onClick={() => void confirmPending()} data-testid="confirm-power">
                  {opt().label}
                </button>
              </div>
            </div>
          </Layer>
        );
      }}
    </Show>
  );
}
