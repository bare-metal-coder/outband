# Outband design system

Outband is an out-of-band console. Its whole job is to answer "can I reach this
machine, by which channel, and what can I do to it right now?" The design is
built around that question.

## Direction: "the band beyond"

Out-of-band means a second channel that works when the first one is gone. The
visual idea follows from that: a dark, quiet instrument panel where the only
saturated things on screen are **signals**, and the brand colour sits just past
the visible spectrum: **ultraviolet**.

- **Dark first.** The default is a cool near-black panel. The light theme is a
  pale, slightly cool "paper" variant of the same, not an afterthought. It
  follows `prefers-color-scheme`, and the user menu has a toggle (system,
  dark, light).
- **Colour means state.** Grey is the chrome. Saturated colour is reserved for
  status: green for in-band (agent) up, cyan for out-of-band (AMT) reachable,
  amber for degraded or pending, red for failure or destructive. Ultraviolet is
  used only for focus, selection and the primary action, so it never gets
  confused with a status.
- **Machine text is mono.** Device IDs, IPs, versions, timestamps, state labels
  and key hints are set in the monospace face. Human text (names, prose,
  buttons) is set in the sans face.

## Typography

| Role | Face | Size and weight |
| --- | --- | --- |
| UI text | System sans (`ui-sans-serif`, `system-ui`, Segoe UI, Roboto) | 13px / 1.45, 400 |
| Headings | System sans, tight tracking (-0.01em) | 15-20px, 600 |
| Machine text | `ui-monospace`, SF Mono, JetBrains Mono, Cascadia Mono, Menlo, Consolas | 12px, tabular figures |
| State labels | Mono, uppercase, +0.06em tracking | 10.5px, 600 |

No web fonts are downloaded. System faces render immediately and keep the
bundle small.

## Colour tokens

All tokens live in `src/styles/tokens.css` as CSS variables under `:root`, with
the light theme under `[data-theme="light"]` (and under `prefers-color-scheme:
light` when the theme is "system").

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--bg` | `#0b0d11` | `#f5f6f8` | page |
| `--panel` | `#111419` | `#ffffff` | cards, tables |
| `--raised` | `#171b22` | `#eef0f3` | hover, menus, inputs |
| `--line` | `#232833` | `#dde1e7` | hairlines |
| `--text` | `#e6e8ec` | `#14171c` | primary text |
| `--muted` | `#8b93a3` | `#5b6474` | secondary text |
| `--uv` | `#a48bff` | `#6a4fe0` | focus, selection, primary |
| `--ib` | `#3ddc97` | `#0b7349` | in-band (agent) up, power on |
| `--oob` | `#45c8f0` | `#086f92` | out-of-band (AMT) reachable |
| `--warn` | `#f2b84b` | `#9a5f00` | degraded, pending, sleep |
| `--bad` | `#ff6b6b` | `#c92a2a` | error, destructive |

Every text/background pair meets WCAG AA (4.5:1) in both themes. `--faint`
is for decoration (dividers, idle lights) only, never for text. Status is
never shown by colour alone: each light also has a text label or an
accessible name.

## Density and layout

- 4px grid. Table rows are 36px, controls are 30px (36px on touch).
- Content is capped at 1200px. At phone width (375px) the table turns into
  stacked rows; nothing scrolls horizontally.
- Hairline borders, 6px radius, no drop shadows except on floating layers
  (menus, dialogs, the palette).

## Signature elements

1. **Channel lights.** Every device shows two small lights, `IB` (in-band:
   the agent) and `OOB` (out-of-band: Intel AMT), plus its power state. You can
   see which channels are up across hundreds of machines at a glance, and why
   a machine can still be powered on when its OS is down.
2. **The carrier line.** A 2px line along the top of the app shows the live
   event stream: steady ultraviolet when connected, a moving amber pulse
   while reconnecting, and red when the stream is down. It replaces a "live"
   badge without taking up any space.
3. **Command palette** (`Ctrl/Cmd-K`, or `/` to search). It jumps to any
   device and runs the power actions that are valid for it right now, using
   the same confirm step as the buttons.
4. **State blip.** When a live event changes a device's state, its light
   gives a single short ring so the change is noticed without flashing.

## Motion

- 120ms for hover and press, 180ms for layers entering. Ease-out only.
- Nothing loops except the carrier line while reconnecting.
- `prefers-reduced-motion` turns off the blip and the carrier pulse.

## Interaction rules

- Everything works from the keyboard: visible 2px ultraviolet focus rings,
  `Esc` closes layers, `j`/`k` move through the device list, and `Enter` opens
  the selected device.
- Power actions are offered only when the current state allows them.
  Destructive actions (off, reset, power cycle) always open a confirm dialog
  that names the device and the channel being used.
- Every action result is shown as a toast. Errors stay until dismissed;
  successes clear after 4s.
