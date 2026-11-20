import { Show, type JSX } from 'solid-js';
import { cancelConfirm, channelName, confirmPending, pending } from '../state/power';
import { Layer } from './Layer';

/** The confirm step for destructive power actions. Names the device and channel. */
export function ConfirmPower(): JSX.Element {
  let cancelBtn: HTMLButtonElement | undefined;
  return (
    <Show when={pending()}>
      {(p) => (
        <Layer onClose={cancelConfirm} label={`Confirm ${p().action.label}`} role="alertdialog" initialFocus={() => cancelBtn}>
          <div class="dialog" data-testid="confirm-dialog">
            <h2>
              {p().action.label} <span class="mono">{p().device.name}</span>?
            </h2>
            <p class="muted">{p().action.detail}</p>
            <p class="muted" style={{ 'margin-top': '10px' }}>
              Channel: <span class="state">{channelName(p().action.channel)}</span>
            </p>
            <div class="actions">
              <button ref={cancelBtn} class="btn" onClick={cancelConfirm}>
                Cancel
              </button>
              <button class="btn btn-danger" onClick={() => void confirmPending()} data-testid="confirm-power">
                {p().action.label}
              </button>
            </div>
          </div>
        </Layer>
      )}
    </Show>
  );
}
