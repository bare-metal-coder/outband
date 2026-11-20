import type { JSX } from 'solid-js';
import { Empty } from '../ui/Empty';

export function NotFound(): JSX.Element {
  return (
    <Empty icon="signal" title="No signal at this address">
      <p>
        <span class="mono">{location.pathname}</span> is not a page in Outband.
      </p>
      <a class="btn" href="/" style={{ 'margin-top': '8px' }}>
        Back to devices
      </a>
    </Empty>
  );
}
