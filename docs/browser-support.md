# webserial — 3M 810 driver in plain JavaScript

Same protocol as the Go server, no Go server: the browser talks to the reader
over [Web Serial](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API).
One file of logic (`rfid3m.js`), one pluggable transport underneath.

```
koha-rfid.js (Koha staff page)          demo.html
        \                                  /
        +------ rfid3m.js (protocol) -----+
              |                    |
   transport-webserial.js     transport-node.js
   (Web Serial: Chrome/FF)    (fs + stty, for testing)
```

## Files

| file | what |
|---|---|
| `rfid3m.js` | the driver: framing, CRC-16/GENIBUS, RFID501 encode/decode, `scan` / `secure` / `program`. No dependencies, no DOM, no `fetch`. |
| `transport-webserial.js` | Web Serial transport (Chromium and Firefox 151+). |
| `transport-node.js` | Node transport over `/dev/ttyUSBx` (or a usbip-tunnelled device), no npm packages. |
| `cli.mjs` | command line tool: probe, scan, watch, blocks, secure, program. |
| `demo.html` | browser demo: connect, live tag table, program/AFI buttons, hex log. |

## Browser demo

```bash
cd koha-rfid-go
python3 -m http.server 8899       # or: npx serve .
# open http://localhost:8899/webserial/demo.html
```

`localhost` counts as a secure context, so Web Serial is available without TLS.
Click **Connect reader**, pick the 3M in the chooser (the chooser needs a real
mouse click — that is a browser rule, not ours). The reader is woken with a
probe first; without it the 810 stays asleep and every command times out.

The page runs unmodified in both Chromium and Firefox — Firefox support was
verified against a real 3M 810 on Firefox 152.

## Browser support

| browser | drives the 810? |
|---|---|
| Chrome / Edge / Brave / Opera | yes — Web Serial since Chrome 89 |
| Firefox 151+ (desktop) | yes — Web Serial since Firefox 151, tested here on 152 |
| Firefox ESR 140 | no — not in the 140 ESR branch (the next ESR is 153) |
| Firefox for Android | no |
| Safari (macOS/iOS) | no |

Firefox landed Web Serial in 151 for desktop (May 2026) after years of refusing
it, so "Chromium only" is no longer a reason to install local software. Two
Firefox differences matter before a rollout:

* The first `requestPort()` per origin shows an extra explanation dialog before
  the port chooser — two clicks per page load instead of one.
* Firefox that is **managed by enterprise policy** blocks Web Serial by default
  as of Firefox 152. An admin has to allow it with the
  [`DefaultSerialGuardSetting`](https://firefox-admin-docs.mozilla.org/reference/policies/defaultserialguardsetting/)
  policy — `{ "policies": { "DefaultSerialGuardSetting": 3 } }` (`3` = allow,
  `2` = block). It maps to the `dom.webserial.enabled` preference, which an
  unmanaged Firefox leaves enabled.

## Node CLI (hardware testing without a browser)

```bash
node webserial/cli.mjs -p /dev/ttyUSB1 -debug probe
node webserial/cli.mjs -p /dev/ttyUSB1 scan
node webserial/cli.mjs -p /dev/ttyUSB1 watch
node webserial/cli.mjs -p /dev/ttyUSB1 blocks E004010031269117
node webserial/cli.mjs -p /dev/ttyUSB1 secure  E004010031269117 DA     # check in
node webserial/cli.mjs -p /dev/ttyUSB1 program E004010031269117 1302099999
node webserial/cli.mjs -p /dev/ttyUSB1 program E004010031269117 blank
```

`-debug` prints every frame in both directions. Linux needs read/write access
to the device (`dialout` group, or a udev rule); the port is opened exclusively,
so the Go server and this CLI cannot share it — and neither can two browser tabs.

## API

```js
import { Reader3M } from './rfid3m.js';
import { SerialTransport } from './transport-webserial.js';

const port = await SerialTransport.pick();      // user gesture required
const transport = new SerialTransport(port, { log: console.debug });
await transport.open();                         // 19200 8N1
const reader = new Reader3M(transport, { log: console.debug });
await reader.probe();                           // wakes the reader; returns "10.5.0.2"
```

| call | returns | equivalent Go endpoint |
|---|---|---|
| `probe()` | hardware version string | – |
| `inventory()` | `[sid]` lowercase hex | – |
| `scan()` | `{ tags: [{sid, content, security, tag_type, reader}] }` | `GET /scan/` |
| `secure([{sid, afi}])` | `{ok}` or `{ok:0, error}` | `POST /secure` |
| `program([{sid, content, tag?}])` | `{ok, errors[]}` | `POST /program` |
| `readBlocks(sid, 0, 8)` | `[Uint8Array(4)]`, index = block number | – |
| `writeBlocks(sid, bytes)` | resolves when the read-back matches | – |
| `close()` | releases the port | – |

The JSON shapes are the ones `koha-rfid.js` already consumes from the Go server,
so moving a page to Web Serial is a matter of replacing `fetch(url)` with the
matching method; `tests/js/webserial.test.mjs` asserts the parity.

`content` in `program()` may be a barcode (≤ 16 chars, `130…` is encoded as a
Book and secured to `DA`, anything else stays `D7`), or the words `blank` /
`3mblank`.

### Transport contract

Anything with these methods drives a reader:

```js
open()                // optional: SerialTransport opens lazily; NodeTransport opens in its constructor
write(bytes)          // Uint8Array -> Promise
read(timeoutMs)       // -> Uint8Array (may be empty; empty means "nothing yet")
reset()               // optional: reopen the port after 3 failed inventories
close()               // optional: release the device
```

## Protocol notes (verified against real hardware)

* 19200 baud, 8N1, no flow control.
* Frame: `<prefix> <len:2 BE> <payload> <crc:2 BE>`; `len` covers payload + CRC.
* CRC-16/GENIBUS: poly `0x1021`, init `0xFFFF`, no reflection, xor-out `0xFFFF`,
  computed over `len + payload` (the prefix is excluded).
* Commands are serialized through an internal promise queue and the RX buffer is
  drained before each command, so a timed-out exchange cannot desynchronize the
  next one. This matters in the browser, where an auto-scan timer and a write can
  otherwise interleave on the wire.
* AFI: `0xDA` = checked in (secure), `0xD7` = on loan (unsecure). Writes are
  verified by reading back, retried up to 10 times, exactly like the Go reader.
* `tests/fixtures/live-capture.txt` is the byte-for-byte capture these rules were
  taken from; `>>` lines include the CRC, `<<` lines were captured after the
  Go frame parser had consumed it.

## Tests

```bash
make test-js        # or: node --test tests/js/webserial.test.mjs
```

The suite replays the live capture: CRC over every captured frame, command frames
byte-compared with what the Go binary wrote, RFID501 decode of both real tags, and
the scan/secure/program result shapes.

## Limitations

* Needs a browser with Web Serial: Chromium-based browsers and Firefox 151+
  desktop ([table above](#browser-support)). Safari and Firefox for Android
  cannot run this code at all, and Firefox ESR 140 has to stay on the Go server.
* The port chooser needs a user gesture, and the grant is per browser profile and
  per origin: expect one click per page load unless the user ticks
  "connect automatically" in the chooser (Chromium); Firefox shows its own
  permission dialog before the chooser.
* One client at a time — a tab holding the port blocks every other tab, window,
  and the Go server.
* The reader must be reachable from the browser, i.e. it is cabled to the staff
  machine. That is the point, but it also means there is no sharing a reader
  across the room, and no server-side logging/audit of what was written.
* Nothing survives a page reload: reconnecting means clicking through again
  (the Go server keeps the port open across reloads).

## Where this fits next to the Go server

Keep the Go server when you need one reader shared by several stations, audit
logging, a reader on a machine that runs no browser, or a browser without Web
Serial (Safari, Firefox ESR 140, Firefox older than 151). Use the Web Serial path
when the reader is plugged into the staff machine and you want zero local
software to install and keep running.
