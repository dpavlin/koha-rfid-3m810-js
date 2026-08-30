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
hack (from Biblio-RFID's `examples/koha-rfid.js`), and a 2017 Apache rule that
reverse-proxied `/rfid/to/<workstation-ip>` to a helper on each desk. Both are
retired by this.

## Design rules

1. **A librarian without a reader sees nothing.** Not one byte on unenrolled
   pages/branches (Perl gate), not one DOM node or listener in unsupported or
   unarmed browsers (bootstrap gate). `tests/boot.test.mjs` asserts it.
2. **RFID is an accelerator, never a dependency.** No dialogs, no `alert`,
   nothing auto-focused; every failure degrades to scanning the barcode as today.
3. **One bundle, inlined.** This Koha (18.11-ffzg fork) does not serve files out
   of the plugin dir (`/plugin/…` → 404) and discovers plugins by filesystem
   scan, so the Perl hook inlines a single esbuild IIFE (≈11 KB, 4.5 KB gzip).

## Provenance

Three steps of translation, all the way back to a 2010 reverse-engineering
project:

```
Biblio-RFID (Perl, 2010, GPL v2+)      dpavlin/Biblio-RFID
  Biblio::RFID::Reader::3M810           the 3M 810 serial protocol, worked out
  Biblio::RFID::RFID501                 from the wire; docs/ holds 3M's own
                                        protocol spec for the model 210
      ↓ ported to Go
koha-rfid-go (GPL v2)
  internal/rfid/{reader,rfid501}.go     framing, CRC-16/GENIBUS, RFID501 blocks
  internal/rfidops/ops.go              scan/secure/program operations
      ↓ ported to JavaScript (commit d198db0)
  webserial/rfid3m.js + transport-webserial.js
      ↓ copied here
  src/driver/rfid3m.js + src/transport/webserial.js
```

The byte-level tests replay the same live capture fixture as `koha-rfid-go`, so a
framing regression fails in both repos. `koha-rfid-go` stays where the protocol
and the Go server live: change framing or RFID501 there, then copy across.

New in this repo: the Perl gate, esbuild bundling + inlining, the dormant-by-
default bootstrap, and the deploy/rollback tooling.

Even the Koha-side ideas are inherited. `examples/koha-rfid.js` in Biblio-RFID
was the jQuery overlay that scanned tags into check-in/check-out forms (the
"press F4" template hack ffzg ran in 2012), and `scripts/RFID-JSONP-server.pl`
was the per-desk local server (the thing `koha-rfid-go` replaced in 2026).

## License

GPL-2.0-or-later, inherited from Biblio-RFID via `koha-rfid-go` — see
[LICENSE](LICENSE).

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
make test             # 26 hardware-free JS tests (offline, replays a live capture)
make test-policy      # 31 gate tests, run on the server against this repo's RFID.pm
make check            # bundle + test + test-policy
make deploy           # backup on server → perl -c → install → restart plack
make log              # what the plugin decided, per page load
make rollback         # restore the newest backup
```

Enrol a workstation: open a circulation page in Chrome, press
<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>R</kbd> (or append `?rfid=1` once), pick the
reader in the Chrome dialog. From then on every page load reconnects by itself.
Same shortcut disconnects.

## Field notes (ffzg, Koha 18.11 fork, plack)

Things that cost an hour each, in one place:

- **Plugin files go under the class path**: `<pluginsdir>/Koha/Plugin/Rot13/RFID/`.
  Copying them flat next to `RFID.pm` makes the plugin log `missing koha-rfid.json`
  and fall back to defaults — the directory *is* the lookup path.
- **`systemctl restart koha-plack` does nothing here** (the LSB unit reports
  `exited`). Use `sudo koha-plack --restart ffzg`; without it plack happily keeps
  serving a starman master that started six days ago and every "the plugin is
  broken" investigation is a waste of time.
- **`intranet_js` is not called for unauthenticated requests** — the login page
  Koha serves for an anonymous `returns.pl` produces no hook invocation at all, so
  the logged-in check in the hook is defence in depth, not the gate.
- **`userenv` on this fork**: login name is `id` (not `userid`, which is what newer
  Koha uses — both staff pages here call `C4::Auth::haspermission(userenv->{id}, …)`),
  and `flags` is a numeric bitfield, not the modern hashref. Ask Koha with
  `C4::Auth::haspermission`; never unpack `flags` by hand.
- **Permission decisions belong to the pages.** returns.pl and circulation.pl
  already check what the logged-in librarian may do; the plugin only decides which
  pages get the script and whether a rollout list narrows it.
- **With `legacy: true` both scripts are injected** (old Go-server polling and the
  new bundle). That is safe only while the new one is dormant; before arming a
  desk for real, turn `legacy` off or the two will fight over the reader.
- Decisions land in `/var/log/koha/ffzg/plack-error.log` — `make log`.

## Browser support

Chrome/Edge desktop only in practice. Firefox 151+ works but managed installs are
blocked by policy since 152; Safari has no Web Serial. Unsupported browsers get
no UI at all. See [docs/browser-support.md](docs/browser-support.md).
