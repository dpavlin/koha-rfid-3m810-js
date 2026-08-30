# koha-rfid-3m810-js

3M 810 RFID reader, driven straight from Koha staff pages over **Web Serial**.
No local server, no certificate, no binary to install on library workstations.

```
librarian's Chrome ──HTTPS──▶ Koha ──inlined bundle──▶ Web Serial ──▶ 3M 810
```

Status: **M0 spike** — bootstrap, bundling and the plugin injection path are in
place and tested; the circulation scan loop and tag programming UI are next
(see [PLAN.md](PLAN.md)).

## Why

`koha-rfid-go` needs a Go daemon on every workstation, which means a localhost
TLS certificate that browsers accept, per-OS binaries, and a service that has to
survive 12-hour library shifts. Web Serial removes all of it: Koha is already
HTTPS, so the page has a secure context, and Chrome remembers the granted port
for the origin — one click per browser, ever.

ffzg has been down this road twice: a 2012 "Press F4 to add RFID tag" template
hack, and a 2017 Apache rule that reverse-proxied `/rfid/to/<workstation-ip>` to
a helper on each desk. Both are retired by this.

## Design rules

1. **A librarian without a reader sees nothing.** Not one byte on unenrolled
   pages/branches (Perl gate), not one DOM node or listener in unsupported or
   unarmed browsers (bootstrap gate). `tests/boot.test.mjs` asserts it.
2. **RFID is an accelerator, never a dependency.** No dialogs, no `alert`,
   nothing auto-focused; every failure degrades to scanning the barcode as today.
3. **One bundle, inlined.** This Koha (18.11-ffzg fork) does not serve files out
   of the plugin dir (`/plugin/…` → 404) and discovers plugins by filesystem
   scan, so the Perl hook inlines a single esbuild IIFE (≈11 KB, 4.5 KB gzip).

## Layout

| Path | What |
|---|---|
| `plugin/Koha/Plugin/Rot13/RFID.pm` | hooks, page/branch gating, inlines the bundle |
| `plugin/…/koha-rfid.json` | pages, branches, users — server side, never shipped whole |
| `plugin/…/koha-rfid.bundle.js` | **build artifact** from `src/`, gitignored |
| `src/core/boot.js` | dormant-by-default bootstrap + opt-in (Ctrl+Alt+R, `?rfid=1`) |
| `src/main.js` | app entry: open port, probe, scan (M1: session + page logic) |
| `src/driver/rfid3m.js` | 3M 810 protocol (CRC-16/GENIBUS frames, RFID501) |
| `src/transport/webserial.js` | Web Serial streams, drain loop, safe close |
| `tests/` | hardware-free: live-capture replay, dormancy rules |

## Using it

```sh
make check            # bundle + 26 hardware-free tests
make deploy           # backup on server → perl -c → install → restart plack
make log              # what the plugin decided, per page load
make rollback         # restore the newest backup
```

Enrol a workstation: open a circulation page in Chrome, press
<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>R</kbd> (or append `?rfid=1` once), pick the
reader in the Chrome dialog. From then on every page load reconnects by itself.
Same shortcut disconnects.

## Browser support

Chrome/Edge desktop only in practice. Firefox 151+ works but managed installs are
blocked by policy since 152; Safari has no Web Serial. Unsupported browsers get
no UI at all. See [docs/browser-support.md](docs/browser-support.md).
