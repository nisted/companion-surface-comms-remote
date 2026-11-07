# companion-surface-comms-remote

A Bitfocus Companion surface plugin for the Comms Remote V2 box: its 3x2 touch grid shows Companion buttons and presses them, over USB serial (Espressif USB Serial/JTAG, VID 303A).

Works alongside the [Comms Remote connection module](https://github.com/nisted/companion-module-comms-remote). See [companion/HELP.md](companion/HELP.md) for how to use it.

## Building

Every push builds the plugin package on GitHub (Actions tab → latest run → `companion-surface-comms-remote` artifact). Import the `.tgz` in Companion with **Modules → Import module package**.

Locally: `corepack enable`, `yarn install`, `yarn package`. Tests: `yarn test` (after a build).

## Layout

- `src/main.ts`: finding boxes and opening them as surfaces.
- `src/instance.ts`: one open box: drawing, brightness, key presses, keepalive.
- `src/link.ts`: the serial link. On Windows the COM port is driven by a PowerShell .NET SerialPort bridge, because a plain file handle makes writes wait behind the pending read.
- `src/protocol.ts`: framing (C0 DE, type, length, payload, CRC-16), matching `surface.h` in the box firmware.

## Protocol

| Plugin → box | Payload |
| --- | --- |
| `01` hello / keepalive | none: the box replies with `81` info |
| `02` image | key, width, height, RGB565 pixels |
| `03` colour | key, RGB565 |
| `04` brightness | 0-100 |
| `05` clear | none: back to numbered placeholders |

| Box → plugin | Payload |
| --- | --- |
| `81` info | `comms-remote-v2;keys=6;cols=3;rows=2;size=76;serial=<mac>` (`;fresh=1` after it has dropped to placeholders: resend every key) |
| `82` key | key, 1 = pressed / 0 = released |
| `83` ack | frame type, 1 = ok / 0 = bad checksum |

Every frame to the box carries a CRC-16/CCITT-FALSE over type, length and payload; frames from the box don't. The box acks each one, and a bad frame is resent up to twice.
