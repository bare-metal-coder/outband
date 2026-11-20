import { createEffect, on, type JSX } from 'solid-js';
import { amtLabel, powerLabel, type Device } from '../model/device';

type Tone = 'ib' | 'oob' | 'warn' | 'bad' | 'off';

/** One status light. Rings once ("blip") when `on` or `tone` changes. */
export function Light(props: { label: string; on: boolean; tone: Tone; title: string }): JSX.Element {
  let el!: HTMLSpanElement;
  createEffect(
    on(
      () => [props.on, props.tone],
      () => {
        el.classList.remove('blip');
        void el.offsetWidth;
        el.classList.add('blip');
      },
      { defer: true },
    ),
  );
  return (
    <span ref={el} class="light" data-on={String(props.on)} data-tone={props.tone} title={props.title}>
      {props.label}
      <span class="sr-only">: {props.title}</span>
    </span>
  );
}

function amtTone(d: Device): { on: boolean; tone: Tone } {
  switch (d.amt.state) {
    case 'reachable':
      return { on: true, tone: 'oob' };
    case 'unreachable':
      return { on: true, tone: 'bad' };
    case 'unprovisioned':
      return { on: true, tone: 'warn' };
    default:
      return { on: false, tone: 'off' };
  }
}

function powerTone(d: Device): { on: boolean; tone: Tone } {
  switch (d.power) {
    case 'on':
      return { on: true, tone: 'ib' };
    case 'sleep':
      return { on: true, tone: 'warn' };
    case 'off':
      return { on: false, tone: 'off' };
    default:
      return { on: false, tone: 'off' };
  }
}

/** Signature element: IB (agent), OOB (AMT) and power lights. */
export function ChannelLights(props: { device: Device; power?: boolean }): JSX.Element {
  const amt = () => amtTone(props.device);
  const pwr = () => powerTone(props.device);
  return (
    <span class="lights">
      <Light
        label="IB"
        on={props.device.online}
        tone={props.device.online ? 'ib' : 'off'}
        title={props.device.online ? 'Agent connected' : 'Agent offline'}
      />
      <Light label="OOB" on={amt().on} tone={amt().tone} title={`Intel AMT: ${amtLabel(props.device.amt.state)}`} />
      {props.power !== false && (
        <Light label="PWR" on={pwr().on} tone={pwr().tone} title={`Power: ${powerLabel(props.device.power)}`} />
      )}
    </span>
  );
}
