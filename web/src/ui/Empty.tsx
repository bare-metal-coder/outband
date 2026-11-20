import type { JSX } from 'solid-js';
import { Icon, type IconName } from './Icon';

export function Empty(props: { icon: IconName; title: string; children?: JSX.Element }): JSX.Element {
  return (
    <div class="empty">
      <Icon name={props.icon} class="glyph" />
      <h2>{props.title}</h2>
      {props.children}
    </div>
  );
}
