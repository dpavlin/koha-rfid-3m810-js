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

The one name worth knowing: **`koha-rfid.js` is the bundle**, not a source file. It is
built into the plugin directory and inlined into the page at request time; searching
`git ls-files` for it is a search that ends in confusion, because there is nothing to
find — `src/` is the source.
| Path | What |
|---|---|
| `plugin/Koha/Plugin/Rot13/RFID.pm` | hooks, page/branch gating, inlines the bundle |
| `plugin/…/koha-rfid.json` | pages, branches, users — server side, never shipped whole |
| `plugin/…/koha-rfid.js` | **built, never written by hand** — `make bundle` puts the bundle here and the plugin inlines it; nothing named `koha-rfid.js` exists in git, and this path is gitignored |
| `src/core/boot.js` | dormant-by-default bootstrap + opt-in (Ctrl+Alt+R, `?rfid=1`) |
| `src/main.js` | app entry: open port, probe, scan (M1: session + page logic) |
| `src/driver/rfid3m.js` | 3M 810 protocol (CRC-16/GENIBUS frames, RFID501) |
| `src/transport/webserial.js` | Web Serial streams, drain loop, safe close |
| `tests/` | hardware-free: live-capture replay, dormancy rules |

## Using it

```sh
make test             # 71 hardware-free JS tests (offline, replays a live capture)
make test-policy      # 29 gate tests, run on the server against this repo's RFID.pm
make check            # bundle + test + test-policy
make deploy           # backup on server → perl -c → install → restart plack
make log              # what the plugin decided, per page load
make live-log         # the same lines, as they happen
make rollback         # restore the newest backup
```

Enrol a workstation: open a circulation page in Chrome, press
<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>R</kbd> (or append `?rfid=1` once), pick the
reader in the Chrome dialog. From then on every page load reconnects by itself.
Same shortcut, or a click on the pill, disconnects.

### What a librarian sees

The corner element is a status pill, not just a link:

| pill | meaning |
|---|---|
| `RFID —` | dormant — no port granted, nothing touched |
| `RFID ?` | armed, waiting for one click on the device chooser |
| `RFID ✓ 10.5.0.2 · 3` | connected, and how many tags it can read right now |
| `RFID !` | connected and failed; the tooltip says why |
| `RFID ✗` | this browser has no Web Serial |

A check-in that worked says so in the corner for four seconds — barcode, not title,
because the title is already on the page and the barcode is what the librarian just
scanned. Nothing else does: not a sound, not a beep, nothing that competes with a desk
full of patrons. A check-in that Koha refused says nothing, because Koha has already
put its answer where the librarian is looking.

On `returns.pl` a scan also writes the first book barcode into the check-in box and
focuses it, so the next keypress is Return. It never submits, never touches the box
if it already contains something (`checkin filled` / `checkin left alone` in the log
tells you which), and `"fillCheckin": false` turns it off. Books are preferred over
the patron card via `bookPrefix`, because a card on the pad is just another
ten-digit barcode as far as the driver knows.

### Watching the pad

While connected, the reader is polled with `inventory()` every 600 ms — one command,
a few tens of milliseconds — and a full `scan()` (AFI + blocks, ~60 ms per tag) runs
only when the set of tags on the pad actually changed. Put a second item down and the
pill flashes and counts 4 within half a second; take one away and it counts 3. If the
check-in box holds a barcode that is no longer on the pad, whatever it referred to has
been dealt with, so a tag that *is* on the pad takes its place; a barcode still under
the antenna is never overwritten.

Polling pauses while the tab is not in front and stops when the page unloads: a
check-in that fires on a page nobody is looking at is a surprise, and a toast nobody
sees is not feedback. Pause is not release — the tab keeps the port, because two tabs
fighting over one reader is worse than one idle holder; `rfidM0.stop()` is how you hand
it to a CLI. Note that Chrome also reports a window *covered by another application*
as hidden, so a workstation that keeps Koha behind a spreadsheet can opt out with
`?rfid=keep` (per browser) or `pauseWatchWhenHidden: false` (per installation). The
pill's tooltip says `watch paused (tab hidden)` when this is why nothing happens.
After three read failures in a row it stops by itself rather than retrying forever.

| config key | default | effect |
|---|---|---|
| `fillCheckin` | `true` | write scanned barcodes into the check-in box |
| `bookPrefix` | `"130"` | prefer these over patron cards when picking which barcode to type |
| `watch` | `true` | poll the pad; `false` means one scan per page load |
| `watchIntervalMs` | `600` | poll interval |
| `autoCheckin` | `false` | post the check-in when a book appears on the pad; `false` fills the box and waits for Return |
| `checkinTtl` | `60` | seconds a checked-in barcode stays "already done", so a tag left on the pad is not offered again immediately |
| `programming` | `false` | allow writing to tags at all — the only destructive capability |
| `pauseWatchWhenHidden` | `true` | pause polling while the tab is not in front |

### Checking items in without anyone pressing Return

`returns.pl` has no API: you post a barcode and it answers with a whole new page. So
this is a state machine that survives a reload (`src/core/checkin.js`, state in
`sessionStorage` — it dies with the tab, so a check-in is never reported to the next
shift), and the property it exists to guarantee is not *it posts* but **it never posts
twice**: a check-in you cannot confirm is a check-in that also lands on the next loan
of that item. One barcode is in flight at a time; a barcode that comes back off the
pad is forgotten, so putting the next item down is not blocked.

Whether it worked is decided by one thing — does the page's checked-in table contain a
*row for this barcode with a date in the due-date column*. A return leaves a date; a
refusal leaves words: "Not checked out", "Item on hold", wording that changes between
Koha versions. Both cases are captured in `tests/fixtures/checkedin-*.html`, and the
refusal is the bug those fixtures exist to keep dead: the refused row carries the same
title and the same barcode as the real one, so matching the table for the barcode
believes Koha's own error message.

Failures are not repeated to the librarian — Koha renders its own error on the page
that just reloaded, in context, with the patron and title beside it. A success gets a
quiet toast; everything goes to `rfidM0.log` and the pill's tooltip. And the direction
of the one uncertainty is deliberate: if Koha renames its table, check-ins that worked
get reported as unconfirmed (nothing is reposted, a human sees the page) rather than
the other way round.

### Writing to a tag

Blanking is just programming with the 3M empty-tag pattern (`program(sid,
"blank")`), so both go through one guard (`src/core/tagwrite.js`), and the guard is
the point: overwriting the wrong tag destroys an item's findability and nothing
downstream complains.

1. The tag must be **on the pad right now**. No writing to a remembered or typed-in
   SID; you cannot mis-position a tag you are holding.
2. A tag holding something that is not a book barcode (a patron card, anything
   outside `bookPrefix`) is only overwritten if the caller repeats that exact barcode
   as `confirm`. A typo does not satisfy it.
3. The new barcode may not duplicate another tag on the pad — two items with one
   barcode is a circulation bug that surfaces months later.
4. 1..16 printable ASCII (the RFID501 field), or `blank` / `3mblank`.

Nothing trusts the writer's own readback either: after `program()` the plugin reads
the blocks and AFI again and reports what is actually on the tag, which is how the
inherited 12-byte blank payload got caught — `m0.writes` keeps every attempt with
`from`, `to`, `afi`, `verified` and the refusal reason.

```js
await rfidM0.readTag('e00401003123b218')   // afi, raw blocks, decoded 501 fields
await rfidM0.program('e00401003123b218', '1309999998')
await rfidM0.program('e00401003123b218', 'blank')
await rfidM0.program(cardSid, '1309999998', { confirm: '200000000042' })
```

From the console: `rfidM0.rescan()` re-reads the pad on demand, `rfidM0.watch` holds
the loop's counters (`polls`, `changes`, `errors`), `rfidM0.log` is everything.

## Field notes (ffzg, Koha 18.11 fork, plack)

Development happens away from the reader, over a hand-made USB/IP tunnel; when it
drops, everything below looks like a broken reader. [docs/usbip-reader.md](docs/usbip-reader.md)
has the attach commands and the "is it the tunnel, the browser, or the reader" table.
The rule that catches people out twice: **one holder per reader** — a second staff tab
loses the port and says so, and Chrome's own wording is useless.

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
- **The check-in field is not the same field everywhere**: `input#barcode` inside
  `form#checkin-form` on `returns.pl`, but `#ret_barcode` on `circulation.pl` and
  `renew.pl`, all of them `name=barcode`. Matching on `name` hits the renew form
  first, and `renew.pl` checks an item in **and issues it straight back out** with a
  new due date — silently. Pick the form by action.
- **Blanking a written tag needs to clear all 8 blocks.** The 12-byte (3-block)
  blank payload inherited from the Go client leaves blocks 3-4 alone, so blanking a
  tag that held `1309999999` left block 3 as `39390000` — the tail of the old
  barcode, i.e. a tag that is neither written nor empty. The 501 decoder still reads
  the barcode as blank, so nothing looks wrong until a 3M tool or a client that reads
  further disagrees. `blankTag()` is 32 bytes now, and `verified` for a blank means
  the whole image reads empty.
- **Permission decisions belong to the pages.** returns.pl and circulation.pl
  already check what the logged-in librarian may do; the plugin only decides which
  pages get the script and whether a rollout list narrows it.
- **One plugin, one script.** This plugin injects the Web Serial bundle and
  nothing else; there is no config key to bring back the old `localhost:9000`
  polling client. `koha-rfid-go` ships that client as `Koha::Plugin::Rot13::RFID`
  too — same class name, same path — so the two repos deploy *on top of each
  other*, and whichever `.pm` landed last is the plugin Koha loads. `deploy.sh`
  deletes any leftover `RFID/koha-rfid.js` on the server for that reason: with
  the old file sitting next to the bundle you cannot tell from the filesystem
  which client a page is running.
- Decisions land in `/var/log/koha/ffzg/plack-error.log` — `make log`.

## Browser support

Chrome/Edge desktop only in practice. Firefox 151+ works but managed installs are
blocked by policy since 152; Safari has no Web Serial. Unsupported browsers get
no UI at all. See [docs/browser-support.md](docs/browser-support.md) (and
[docs/usbip-reader.md](docs/usbip-reader.md) for the test rig).
