# koha-rfid-3m810-js

3M 810 RFID reader, driven straight from Koha staff pages over **Web Serial**.
No local server, no certificate, no binary to install on library workstations.

```
librarian's Chrome ──HTTPS──▶ Koha ──inlined bundle──▶ Web Serial ──▶ 3M 810
```

Status: **M1** — a scan does the transaction the cursor is in (check in, renew, check
out), corrects the tag's security bit to match, and reports it in the corner. Deployed on
the ffzg dev box against a real 3M 810; tag programming is behind `programming: false`.
See [PLAN.md](PLAN.md) for what is done and what is left.

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
2. **RFID is an accelerator, never a dependency.** No dialogs, no `alert`, no
   sound. The page is acted on only where the cursor already is, and the only field
   ever focused is one the plugin just filled on its way to posting it. Every failure
   degrades to typing the barcode as today; `autoSubmit: false` degrades further, to
   filling the box and leaving `Return` to a human.
3. **One bundle, inlined.** This Koha (18.11-ffzg fork) does not serve files out
   of the plugin dir (`/plugin/…` → 404) and discovers plugins by filesystem
   scan, so the Perl hook inlines a single esbuild IIFE.

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

| Path                               | What                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plugin/Koha/Plugin/Rot13/RFID.pm` | hooks, page/branch gating, inlines the bundle                                                                                                                            |
| `plugin/…/koha-rfid.json`          | pages, branches, users — server side, never shipped whole                                                                                                                |
| `plugin/…/koha-rfid.js`            | **built, never written by hand** — `make bundle` puts the bundle here and the plugin inlines it; nothing named `koha-rfid.js` exists in git, and this path is gitignored |
| `src/core/boot.js`                 | dormant-by-default bootstrap, the pill, and the one page action                                                                                                          |
| `src/core/intent.js`               | cursor → transaction: what the focused box means, and what the tag should say after it                                                                                   |
| `src/core/tagwrite.js`             | the guard in front of every write to a tag                                                                                                                               |
| `src/main.js`                      | app entry: open port, probe, scan, watch the pad                                                                                                                         |
| `src/driver/rfid3m.js`             | 3M 810 protocol (CRC-16/GENIBUS frames, RFID501)                                                                                                                         |
| `src/transport/webserial.js`       | Web Serial streams, drain loop, safe close                                                                                                                               |
| `tests/`                           | hardware-free: live-capture replay, dormancy rules, transaction routing                                                                                                  |

## Using it

```sh
make test             # 85 hardware-free JS tests (offline, replays a live capture)
make test-policy      # 29 gate tests, run on the server against this repo's RFID.pm
make check            # bundle + test + test-policy
make deploy           # backup on server → perl -c → install → restart plack
make log              # what the plugin decided, per page load
make live-log         # the same lines, as they happen
make rollback         # restore the newest backup
```

Everything deploys to **ffzg on `koha-dev.rot13.org`** — the box `tools/deploy.sh` names, and
the only installation this plugin has ever run on. `koha.ffzg.hr` is production: it has no RFID
plugin installed and it is not a deploy target until a rollout is actually decided (PLAN §9 Q9
is the question that decides it). Its logs are still the best evidence there is of how the staff
client gets used, which is where the request counts in PLAN §6 came from — read-only, and
aggregated to counts.

Enrol a workstation: open a circulation page in Chrome, press
<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>R</kbd> (or append `?rfid=1` once), pick the
reader in the Chrome dialog. From then on every page load reconnects by itself.
Same shortcut, or a click on the pill, disconnects.

### What a librarian sees

The corner element is a status pill, and it is the only feedback the plugin gives:

| pill                   | meaning                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `RFID —`               | dormant — no port granted, nothing touched                      |
| `RFID ?`               | armed, waiting for one click on the device chooser              |
| `RFID ✓`               | connected, nothing to show (`no tag on the pad` is spelled out) |
| `RFID ✓ 1302079605 IN` | connected, and what the tag under the head says                 |
| `RFID !`               | connected and failed; the tooltip says why                      |
| `RFID ✗`               | this browser has no Web Serial                                  |

Every tag on the pad gets a chip: the barcode, then the security bit as a word — `IN` in
library (green), `OUT` on loan (amber), `??` unreadable. It is the one fact about a book that
a desk cannot check any other way, and the reason the pill lists the pad instead of a count.
Barcodes and plain words, never hex: `D7` means nothing at a desk, `on loan` does. Two
capital ASCII letters rather than an arrow, on purpose: the pill is 11px monospace, and the
word is also the only thing separating the green chip from the amber one that a colour-blind
librarian can read.

Nothing beeps and nothing is modal. A desk full of patrons does not need to hear about a
book, and Koha renders its own answer — not checked out, on hold, not yours to return —
on the page the transaction just reloaded, beside the item it is about. The tooltip
carries the rest: reader version, every tag's state, the last thing the plugin did.

### What a scan does

Where the cursor is, is what the scan means. The plugin reads `document.activeElement`,
looks at which page that field's form posts to, and gets a transaction:

| the box holding the cursor                     | transaction     | the tag is written to          |
| ---------------------------------------------- | --------------- | ------------------------------ |
| check-in box — `returns.pl`, or the header one | check in        | in library (`DA`)              |
| renew box — `renew.pl`, or the header one      | renew           | on loan (`D7`)                 |
| the checkout box on `circulation.pl`           | check out       | on loan (`D7`)                 |
| the patron box (`#findborrower`)               | find the patron | nothing — a card is not a book |
| anywhere else                                  | nothing at all  |                                |

Focus is the consent gesture, and it beats a page table for two reasons measured on the dev
box. The header boxes exist on pages with no circulation form of their own — `mainpage.pl`
carries a check-in box that posts to `returns.pl` and a renew box that posts to `renew.pl`
— so a table keyed by page sees nothing there. And one page (`circulation.pl`) carries a
checkout box and a header check-in box that are both named `barcode` and post to different
pages, so a table keyed by field name picks a transaction by coin toss. The header check-in
box is Koha's <kbd>Alt</kbd>+<kbd>R</kbd> target (`accesskey="r"` in the markup, no JS
involved); its `accesskey="q"` sibling is the catalog search box, and a tag scanned with the
cursor there does nothing, which is the case a page table gets wrong in both directions.
`src/core/intent.js` is that table; `tests/intent.test.mjs` is the argument for it, including
the header boxes on a page (`mainpage.pl`) that has no circulation form of its own.

Then, in this order: **the tag, the box, the page.** The tag first because posting
navigates, navigation closes the serial port, and a write still in flight is a tag that
silently stayed on loan. A tag that already says the right thing is not written to; a tag
whose write failed is not complained about — the pill shows the state the tag last
reported, `security bit NOT written` goes to the log, and Koha still gets the transaction
that was asked for, because a bit is not worth holding a return hostage to.

The page is posted — that is the point — and the page that comes back has the same book
still under the head. So the plugin remembers for `postedTtl` seconds (in `sessionStorage`,
so it dies with the tab and never teaches the next shift) that it already posted that
barcode into that box: a stack is a queue, one transaction per page load, and taking the
top book off the pad is what hands the next one its turn. A barcode in the box that is
still on the pad is never typed over — that is a transaction in progress; a value whose tag
has left the pad is stale and gets replaced. `rfidM0.posted()` shows the memory.

Renew is in the table for a reason: a book being renewed that reads `in library` was never
properly issued, and a renewal is the moment it is lying on a reader. Writing it to `on
loan` is the correction, and it is the same write a checkout would do.

### Watching the pad

While connected, the reader is polled with `inventory()` every 600 ms — one command,
a few tens of milliseconds — and a full `scan()` (AFI + blocks, ~60 ms per tag) runs
only when the set of tags on the pad actually changed. Put a second item down and the
pill flashes and counts 4 within half a second; take one away and it counts 3. If the
check-in box holds a barcode that is no longer on the pad, whatever it referred to has
been dealt with, so a tag that _is_ on the pad takes its place; a barcode still under
the antenna is never overwritten.

Polling pauses while the tab is not in front and stops when the page unloads: a
transaction that fires on a page nobody is looking at is a surprise, and a pill nobody
sees is not feedback. Pause is not release — the tab keeps the port, because two tabs
fighting over one reader is worse than one idle holder; `rfidM0.stop()` is how you hand
it to a CLI. Note that Chrome also reports a window _covered by another application_
as hidden, so a workstation that keeps Koha behind a spreadsheet can opt out with
`?rfid=keep` (per browser) or `pauseWatchWhenHidden: false` (per installation). The
pill's tooltip says `watch paused (tab hidden)` when this is why nothing happens.
After three read failures in a row it stops by itself rather than retrying forever.

| config key             | default | effect                                                                       |
| ---------------------- | ------- | ---------------------------------------------------------------------------- |
| `fill`                 | `true`  | type the scanned barcode into the focused box at all                         |
| `autoSubmit`           | `true`  | post the form; `false` fills the box and leaves <kbd>Return</kbd> to a human |
| `securityBit`          | `true`  | write the tag to the state the transaction is creating (one byte)            |
| `postedTtl`            | `45`    | seconds a tag stays "already posted" while it sits under the head            |
| `bookPrefix`           | `"130"` | prefer these over patron cards when picking which barcode to type            |
| `watch`                | `true`  | poll the pad; `false` means one scan per page load                           |
| `watchIntervalMs`      | `600`   | poll interval                                                                |
| `programming`          | `false` | allow rewriting what a tag _holds_ — barcode and EPC, not just its bit       |
| `pauseWatchWhenHidden` | `true`  | pause polling while the tab is not in front                                  |

`securityBit` and `programming` are different capabilities and are switched separately:
one sets a byte that says where the book is supposed to be, the other overwrites what the
book is. Turning one on says nothing about the other.

### Why the tag is written at the scan and not after

The obvious design writes the security bit after Koha has accepted the transaction — the
state a librarian wants is a state Koha has to agree to. It was built that way, with the
write owed across the reload, a list of what the tags were still owed, and a takeover
screen for a book that walked away before it was told. Then it was deleted: three pages
of state, a machine with four ways to be half-done, and every interesting bug lived in
the gap between the transaction and the write.

Writing at the scan instead buys the whole gap back. The state is decided by the box the
librarian chose, which is the same fact the transaction is decided by, so there is nothing
to reconcile afterwards. What it costs is that a transaction Koha _refuses_ can leave a tag
pointing the wrong way: a book Koha would not accept is now "in library". That error is
loud (the page says the return failed, right there, and the pill says what the tag now
says) and it is fixed by the next successful scan of the same book, whereas the deferred
design's failures were quiet. One byte, written 150 ms before the page goes away, against
a state machine: the trade is worth it.

Nothing here waits for the write to be confirmed by re-reading the tag: the driver's
`writeAfi()` reads the byte back and throws if it did not take, which is what `verified`
means. The pill showing `IN` after a check-in is a write the reader agreed to.

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
await rfidM0.readTag('e00401003123b218'); // afi, raw blocks, decoded 501 fields
await rfidM0.program('e00401003123b218', '1309999998');
await rfidM0.program('e00401003123b218', 'blank');
await rfidM0.program(cardSid, '1309999998', { confirm: '200000000042' });
```

From the console: `rfidM0.rescan()` re-reads the pad on demand, `rfidM0.watch` holds
the loop's counters (`polls`, `changes`, `errors`), `rfidM0.log` is everything.
`rfidM0.target()` answers what a scan would do right now — the transaction, the state the
tag would get, whether it posts — for whatever the cursor is in, which is the question to
ask before blaming the plugin for a scan that did nothing. `rfidM0.act()` does it, and
`rfidM0.posted()` says which barcodes are sitting out their `postedTtl`.

## Field notes (ffzg, Koha 18.11 fork, plack)

Development happens away from the reader, over a hand-made USB/IP tunnel; when it
drops, everything below looks like a broken reader. [docs/usbip-reader.md](docs/usbip-reader.md)
has the attach commands and the "is it the tunnel, the browser, or the reader" table.
The rule that catches people out twice: **one holder per reader** — a second staff tab
loses the port and says so, and Chrome's own wording is useless.

Things that cost an hour each, in one place:

- **Plugin files go under the class path**: `<pluginsdir>/Koha/Plugin/Rot13/RFID/`.
  Copying them flat next to `RFID.pm` makes the plugin log `missing koha-rfid.json`
  and fall back to defaults — the directory _is_ the lookup path.
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
  too — same class name, same path — so the two repos deploy _on top of each
  other_, and whichever `.pm` landed last is the plugin Koha loads. `deploy.sh`
  deletes any leftover `RFID/koha-rfid.js` on the server for that reason: with
  the old file sitting next to the bundle you cannot tell from the filesystem
  which client a page is running.
- **Two tabs, one reader: the second says so and stops, in one sentence you can act on.** A
  reader is opened by one document at a time. The tab that loses makes three attempts over
  1.5 s (`transport/webserial.js`, `open()`) and then gives up, because the other holder is
  not going to let go on its own. Chrome's part of the message is `Failed to execute 'open' on
'SerialPort': Failed to open serial port.` — it never mentions the other tab, so the plugin
  appends the part that matters (`main.js`). Read off a live two-tab desk, 2026-09-04, tooltip
  on a red `RFID !`:

    ```
    reader failed: Failed to execute 'open' on 'SerialPort': Failed to open serial port.
     — another tab or window may be holding the reader
     — click, or Ctrl+Alt+R
    ```

    The loser's log is the same fact three times: `open retry: 1/3`, `2/3`, `gate: error`.
    **It is terminal for that page load** — nothing retries after it — so the way to get the
    reader in this tab is to stop the other one standing down (`?rfid=nokeep`, or close it) and
    then reload. Both tabs behaving like this, one green and one red, is the system working: the
    reader is never opened by two documents at once, and neither tab has to guess why.

- Decisions land in `/var/log/koha/ffzg/plack-error.log` — `make log`.

## Browser support

Chrome/Edge desktop only in practice. Firefox 151+ works but managed installs are
blocked by policy since 152; Safari has no Web Serial. Unsupported browsers get
no UI at all. See [docs/browser-support.md](docs/browser-support.md) (and
[docs/usbip-reader.md](docs/usbip-reader.md) for the test rig).
