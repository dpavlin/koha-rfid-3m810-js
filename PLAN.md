# koha-rfid-3m810-js — plan (v2, decisions folded in)

Standalone Koha plugin driving a 3M 810 RFID reader **directly from the browser via
Web Serial (Chrome)**. No local daemon, no Go, no server-side component beyond the
plugin file itself. Independent repo; `koha-rfid-go` is a source of code to copy,
not a dependency.

## 0. Decisions taken

| # | Decision |
|---|---|
| 1 | Repo is **independent** — copy code + fixtures in, no cross-repo links |
| 2 | **esbuild, dev-only** build step → single inlined bundle |
| 3 | **No Go-server transport.** Web Serial or nothing |
| 4 | **One tab owns the reader** — explicit "in use elsewhere" state, no leader election |
| 5 | **Chrome baseline.** Firefox is best-effort; Safari/iOS unsupported |
| 6 | Plugin class stays **`Koha::Plugin::Rot13::RFID`** (drop-in over the live install) |
| 7 | **Tag programming is in scope**, driven from `catalogue/moredetail.pl` (§6) |
| + | **Staff without a reader must see nothing at all** (§5 — first-class requirement) |
| 8 | **The transaction is decided by the focused box** — and by where that box's form posts (§3.2) |
| 9 | **The AFI is written at the scan, before the form posts** (§3.1 — supersedes "after Koha confirms", which was built and deleted) |
| 10 | **The pill is the only feedback**: every tag on the pad, as barcode + state. No dialogs, no takeover, no sound |

## 1. Ground facts about the *actual* target (verified on koha-dev)

ffzg does **not** run the distro Koha. It runs a patched fork from git at
`/srv/koha_ffzg` (`git describe` → `v18.11.00-1109-g9af01e7dd7`), served by
`/etc/apache2/sites-enabled/ffzg.conf` + `/etc/koha/sites/ffzg/apache-shared-intranet.conf`.

| Fact | Evidence | Consequence for us |
|---|---|---|
| Plugin discovery is **filesystem scan**, not DB: `Module::Pluggable search_path => ['Koha::Plugin']`, pluginsdir pushed onto `@INC` | `/srv/koha_ffzg/Koha/Plugins.pm:13-23` | Deploy = **copy `RFID.pm` + `RFID/` dir → `chown` → restart plack**. No install UI, no DB row |
| There is **no `plugins` table** (only `plugin_data`) | `show tables like '%plugin%'` | **KPZ install via `plugins-upload.pl` cannot work here.** Build the KPZ for other sites, deploy here by hand |
| `Koha::Plugins::Base` in this fork has **no `config_plugin`, no `enable/disable`, no `get_config`** — only `store_data`/`retrieve_data`, `get_template`, `get_metadata`, `get_plugin_http_path`, `output*` | grep of `/srv/koha_ffzg/Koha/Plugins/Base.pm` | **No plugin config table.** Config = JSON file next to the plugin (server side) + `localStorage` (per browser) |
| Only **4 hooks** exist: `opac_head`, `opac_js`, `intranet_head`, `intranet_js` — and they are called **with no arguments** (`$_->intranet_js`) | `/srv/koha_ffzg/Koha/Template/Plugin/KohaPlugins.pm:105-160` | No toolbar/usermenu injection point; no page name from the hook. Server-side page gating must read `$ENV{SCRIPT_NAME}` (verify in M0) or stay client-side |
| Plugin dir is **not** served over HTTP: `curl …/plugin/Koha/Plugin/Rot13/RFID/koha-rfid.js` → **404**, no `Alias /plugin/` | curl + vhost grep | JS must be **inlined** by `intranet_js` → single self-contained bundle, no runtime `import` |
| But `DocumentRoot /srv/koha_ffzg/koha-tmpl` — that tree *is* served (`/intranet-tmpl/prog/img/rfidPosition1.jpg` works) | `apache-shared-intranet.conf` | Escape hatch if inline ever gets too big: drop the bundle in the theme dir and `<script src>` it. Not v1 — it puts a file outside the plugin |
| Staff UI is HTTPS on `:8443` | vhost | Web Serial secure-context requirement met; the **localhost TLS cert problem disappears** |
| RFID501 content is **16 bytes max**; `program()` writes blocks + AFI and verifies by read-back (`writeBlocks`, `writeAfi`, 10 retries) | `webserial/rfid3m.js:296-352` | Programming is already implemented at driver level; only UI + guardrails are new |
| Staff templates are **`.tt`** under `/srv/koha_ffzg/koha-tmpl/intranet-tmpl/prog/en/modules/`, and some carry ffzg-specific markup (`circ/circulation.tt` renders `input#barcode` **disabled** under `NEEDSCONFIRMATION`; `circ/renew.tt` has its own barcode box) | `grep` of those files; `/usr/share/koha/...` holds upstream `.tmpl_upgrade_backup` copies that are not what the browser receives | Read page structure from the fork's templates before writing page logic, and never fill a field the page deliberately disabled |
| ffzg has been around this block twice before: 2012 `Press F4 to add RFID tag` in `moredetail.tt`, and 2017 `/rfid/to/<workstation-ip>` reverse proxy to per-PC readers (`RewriteRule ^/rfid/to/(.+) http://$1 [P]`, now commented out) | `/srv/koha_ffzg/ffzg/rfid/`, `moredetail.tt:54-68` | Web Serial retires the whole per-IP proxy hack — worth saying in the README, it is the project's reason to exist |

## 2. Layout

```
koha-rfid-3m810-js/
├── plugin/Koha/Plugin/Rot13/RFID.pm       # hooks, gating, inlines the bundle
├── plugin/Koha/Plugin/Rot13/RFID/
│   ├── koha-rfid.json                    # config (dev values in repo)
│   └── koha-rfid.js                      # BUILT — gitignored, never hand-edited
├── src/
│   ├── main.js                           # entry: open, probe, scan, watch the pad
│   ├── driver/rfid3m.js                  # 3M 810 protocol (copied, ESM)
│   ├── transport/webserial.js            # port open / close / drain, safe close
│   ├── core/boot.js                      # bootstrap, the pill, and the one page action
│   ├── core/intent.js                    # focused field → transaction → wanted AFI (§3.2)
│   └── core/tagwrite.js                  # the guard in front of writing a tag (§6)
├── build/bundle.mjs                      # esbuild → one minified IIFE, inlined
├── tests/                                # hardware-free; driver replays fixtures/live-capture.txt
│   ├── intent.test.mjs                   # the routing table (§3.2)
│   ├── transaction.test.mjs              # scan → tag, box, post — and its memory
│   └── helpers/fakewindow.mjs            # fake DOM/serial/storage/timers, fake reader
├── tools/{deploy,rollback}.sh  tools/live/*.mjs   # deploy + CDP probes against real Koha
├── docs/{browser-support,usbip-reader}.md
└── Makefile                              # bundle, test, test-policy, check, deploy, log
└── README.md  AGENTS.md  PLAN.md  LICENSE
```

## 3. Runtime

State machine (`core/session.js`), Chrome-only assumptions stated in one place:

```
boot ─→ dormant            no navigator.serial, or not armed → NOTHING happens (no DOM, no timers)
     ─→ armed|disconnected no granted port → status dot only; Connect link opens requestPort()
     ─→ connecting ─→ ready        getPorts() → open → probe, no gesture needed
     ─→ busy         port held by another tab/window → "RFID in use elsewhere" (decision 4)
     ─→ error        no device / probe timeout → dot turns grey, backoff 1s→2s→5s, no dialogs
```

- Poll tick stays 1 s while `ready`; **paused on `visibilitychange`** (hidden tab = no
  serial traffic) and closed on `pagehide` so the next page gets the port.
- Koha does full-page submits: reconnect (~0.2–0.5 s) per page load, and the
  pending-AFI-write map in `localStorage` still completes writes across reloads.
- Reuse `rfid3m.js` verbatim — `scan()` already returns the tag objects the page
  logic expects (`{sid, content, security, tag_type, reader}`), so `rfid_scan()`
  moves as a **move, not a rewrite**.

### 3.1 The security bit (AFI) follows the focused box, and is written at the scan

| AFI | meaning | who cares |
|---|---|---|
| `DA` | checked in, secure | the door ignores the book |
| `D7` | on loan, unsecure | the door alarms |

Ground truth, not memory: `koha-rfid-go/internal/rfid/reader.go:532` defines
`AfiSecure = 0xDA` / `AfiUnsecure = 0xD7`, and tags in this library read `DA` on a shelf
book (`tests/fixtures/live-capture.txt:19`, and `1302079605` again on 2026-09-02).

**The state a tag is written to is decided by the box the librarian was looking at**:
check-in box → `DA`, renew or checkout box → `D7`, patron box → nothing. That is the same
fact that decides the transaction (§3.2), so a tag is never asked for a state the page is
not producing. The write happens in `act()`, *before* the form posts; a tag that already
reads the target state is not written to at all, which is most tags most of the time.

AFI is a hint, never a gate: no transaction here is filtered on it (a book reading `DA` may
well be on loan — a write that failed a month ago), and it never decides whether to post.
Koha decides what happened; the tag is told which state the transaction is creating.

#### What the deferred design cost, and what this one accepts

M1a/M1b as first planned wrote the AFI *after* Koha confirmed, on the page that reload
produced: `core/security.js` kept an owed-write list in `sessionStorage`, `core/checkin.js`
decided "confirmed" from a date-in-a-column rule, and `core/alert.js` took the screen over
with a beep when a book walked away unwritten. It was built, deployed to the dev box, and
deleted the same day — three modules and about 500 lines, whose interesting bugs all lived
in the gap between the transaction and the write: the confirmation arriving on a page that
had no port open yet, the write owed by a page that had already navigated away, the alert
that could not tell a librarian lifting the book from a book that left the building.

Writing at the scan removes the gap and accepts one clear trade: **a transaction Koha
refuses can leave the tag in the state the transaction would have created** — a book Koha
would not check in now says `DA`. That error is visible (the refusal is on the page, beside
the item), self-correcting (the next successful scan writes it again), and confined to one
byte nothing downstream treats as truth. The deferred design's failures were quiet, and its
loud failure mode was a takeover screen.

What is not accepted is writing after the submit navigates: navigation closes the serial
port, and a write in flight is a tag silently unwritten. Hence the order inside `act()` —
**tag, box, page** — and `fixBit()` awaiting the driver, which reads the byte back and
throws if it did not take.

Two consequences worth keeping in view:

- A book renewed while reading `DA` was never properly issued; a renewal is the moment it is
  lying on a reader, and it gets `D7`. The design corrects history here rather than
  following it, and that is deliberate.
- A book checked in and then carried off quickly was already `DA` before Koha answered. If
  Koha refused the return, the door is muted for that book until somebody scans it again.
  §9.6 (a server-side record of what each tag should say) is the only design that closes
  that, and it needs the server. Parked, with the reason written down.

### 3.2 Where a scan goes: the focused field, and where its form posts

`intentOf(document.activeElement)` (`src/core/intent.js`) is the whole routing table: the
field's form action names the transaction, the transaction names the AFI.

| focused box | form posts to | transaction | tag becomes |
|---|---|---|---|
| `#barcode` in `form#checkin-form`, or `#ret_barcode` in the header | `circ/returns.pl` | check in | `DA` |
| `#barcode` on `renew.pl`, or `#ren_barcode` in the header | `circ/renew.pl` | renew | `D7` |
| `#barcode` in `form#mainform` | `circ/circulation.pl` | check out | `D7` |
| `#findborrower` | `circ/circulation.pl` | find the patron | — (a card is not a book) |
| anything else, or a disabled/read-only field | | nothing | |

Why focus and not a page table, all three measured on the dev box (`tools/live/`):

- Koha's own shortcuts focus the **header** boxes (Alt+R → `#ret_barcode`, Alt+W →
  `#ren_barcode`, Alt+U → `#findborrower`), and those exist on pages with no circulation
  form of their own (`mainpage.pl`). A page table sees no box there and does nothing.
- `circulation.pl` has a checkout box and a header check-in box **both named `barcode`**,
  posting to different pages. `name` cannot tell them apart, and the wrong one is not a
  missed scan but a wrong transaction (`renew.pl` checks in *and issues back out*).
- Focus is also the consent gesture the page table had no equivalent of: a scan means what
  the librarian was aiming at, and a page nobody has clicked in is a page not to post.

Then, in order: pick the tag (books before cards, by `bookPrefix`; skip any barcode already
posted for this box within `postedTtl`), write its AFI, fill the box, post the form. The
`postedTtl` memory is what makes posting safe to automate at all — the page comes back with
the same book under the head, and a plugin that forgets that checks the book in again, once
per second, forever. A barcode in the box that is still on the pad is never typed over; a
value whose tag has gone is stale and is replaced, which is what makes a stack a queue.

## 4. Config (no plugin config table exists on this Koha)

- `RFID/koha-rfid.json` next to the plugin — read by `RFID.pm` at request time
  (stat-cache it), passed to the bundle as a JSON literal:
  ```json
  { "pages": ["circ/returns.pl", "circ/circulation.pl", "circ/circulation-home.pl",
              "circ/renew.pl", "catalogue/moredetail.pl", "mainpage.pl"],
    "branches": [],  "users": [],  "bookPrefix": "130",
    "hint": true,        "debug": true,        "programming": true,
    "fill": true,        "autoSubmit": true,   "securityBit": true, "postedTtl": 45,
    "watch": true,       "watchIntervalMs": 600,
    "pauseWatchWhenHidden": true }
  ```
  The file in this repo is the **development** one, with `debug` and `programming` on to
  make hardware testing possible. `programming` — rewriting what a tag *holds* — is the
  destructive capability and defaults to off in the code; it is a different thing from
  `securityBit`, which sets one byte. `autoSubmit` (posting without anyone pressing
  Return) defaults to on because a scan that does nothing is the failure mode librarians
  reported about the 2012 template hack; `"autoSubmit": false` is the conservative install.
- Per-browser state in `localStorage`: `rfid_armed` (this desk has a reader and may
  talk to it), `rfid_keepwatching` (`?rfid=keep`). Per-tab in `sessionStorage`:
  `rfid_posted` — which barcodes were posted into which box, and when (§3.2). It has to
  survive the reload the plugin causes and die with the tab, so it is neither a variable
  nor localStorage; `rfidM0.posted()` reads it.
- No syspref, no DB writes, no admin page needed to run it. There is no per-user
  preference layer yet — see §9.6, parked for the end.

## 5. Do not bother the ~90% of staff who have no reader

Four gates, cheapest and most certain first. Design rule: **RFID is an accelerator,
not a dependency — when in doubt, render nothing.**

**Gate A — Perl: don't send the code at all.** `intranet_js` returns `''` unless
  1. page ∈ `config.pages` (compare against `$ENV{SCRIPT_NAME}`, verified in M0;
     fallback: keep the current client-side check and accept that the bundle ships
     on those 5 pages only), **and**
  2. user ∈ `config.users` **or** `C4::Context->userenv->{branch}` ∈ `config.branches`
     (empty `branches` = everyone; `superlibrarian` always allowed, for support).
  Result: for unenrolled libraries/desks **zero bytes, zero JS, zero risk** — the
  strongest possible guarantee and the one that makes the rollout safe.

**Gate B — Bootstrap: 1 KB, and it stops itself.** Injected inline on the allowed
  pages. It only reads: if `!navigator.serial` → stop (Safari/Firefox-ESR/older
  Chrome see nothing, per decision 5); if `navigator.serial.getPorts()` is empty and
  `localStorage.rfid_armed` is unset → stop. `getPorts()` needs no user gesture, so
  this never prompts. No DOM, no timers, no popup until *after* both checks pass —
  i.e. an enrolled browser is the only one that ever loads the rest.

**Gate C — Explicit, memorable opt-in (one click ever).** Once `navigator.serial`
  exists but nothing is armed, offer exactly two discreet entry points and nothing else:
  - a keyboard shortcut, **Ctrl+Alt+R**, plus a one-line hint in the page footer:
    <span>RFID: <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>R</kbd> to connect</span>
    (deliberately replacing the 2012 "Press F4" muscle memory — F4 stays bound on the
    item page for programming, see §6);
  - a URL parameter `?rfid=1` that arms and persists to `localStorage` — handy for
    "make this desk an RFID desk" without teaching anyone a shortcut.
  Either path calls `requestPort()` (the only gesture-requiring call), then the grant
  is remembered by Chrome for this origin forever: **one click per browser, ever**.
  `Ctrl+Alt+R` again, or the footer link, disarms (stops polling, clears UI, keeps
  the browser grant — harmless).

**Gate D — Armed-but-no-reader must not nag.**
  - The UI is one corner **pill**, built from 40 characters of text and a tooltip: grey
    `RFID —` dormant, `RFID ?` armed without a grant, green `RFID ✓` ready, `RFID !`
    failed, `RFID ✗` no Web Serial. Everything else — reader version, each tag's state,
    the last action, why the watch is paused — is in the `title`, not on the screen.
  - What is on the pad is shown as chips (`1302079605 ⇤`), and that is also the whole
    result feedback: no toast, no panel, no sound, nothing that has to be dismissed or
    that expires while somebody is reading it. The debug log is `rfidM0.log`, in the
    console, which is where a person who wants it already is.
  - Errors never interrupt a transaction: no `alert`, no blocking dialog, no sound. A
    failure is a pill that changed colour, a line in the log, and Koha's own message.
  - The plugin takes no keystrokes and focuses nothing until it is about to post, and then
    only the box it has just filled. A reader on the pad with the cursor anywhere else
    changes no page at all — the keyboard workflow is untouched.

Net effect for a librarian with no reader: **no visible change to Koha, at any level
— not one byte of JS if their branch is not enrolled, not one DOM node if their
browser is not armed.**

## 6. Tag programming from `catalogue/moredetail.pl`

What the page already has (patched in 2012, still live): two
`<div class="dialog message">Press <strong>F4</strong> to add RFID tag.</div>`
notices, a chip-placement photo `rfidPosition{{itemnumber % 3}}.jpg`
(`rfidPosition1..3.jpg` exist in the theme img dir — a per-item *sticky* position hint,
worth keeping), and a `[RFID Tag]` link into single-item `moredetail.pl`. The barcode is
in `<h3>Barcode {{barcode}}</h3>`.

Proposal — replace the dead F4 notice with the real thing:

1. **Detect** `catalogue/moredetail.pl` + a granted/armed session; then
   - keep the placement photo (it is genuinely useful),
   - swap the two "Press F4" dialogs for one panel: **[Program tag]** (also bound to
     <kbd>F4</kbd> and <kbd>Ctrl+Alt+P</kbd>, since F4 is browser-flaky), **[Read tag]**,
     **[Set DA] [Set D7]** for maintenance.
2. **Barcode source**: the item's barcode as rendered on the page — read it from the
   `<h3>Barcode …</h3>` heading, and additionally have Perl/JS add
   `data-rfid-barcode` / `data-itemnumber` to that heading at runtime so the parser
   never depends on markup details. Refuse to guess when multiple items are listed:
   require the single-item `[RFID Tag]` view (which is exactly what staff use today).
3. **Write sequence** = existing driver call `program([{ sid, content: barcode }])` →
   `writeBlocks` (RFID501 encode) + `writeAfi(DA)` + read-back verification, 10 retries.
   `DA` because a newly tagged item goes on the shelf checked in.
4. **Guardrails** (this is where tag programming bites people, so be strict):
   - barcode > 16 bytes → refuse, show the byte count (RFID501 field limit);
   - tag already holds a *different* barcode → refuse with "overwrite?" confirm,
     showing old → new, and require the tag to be re-presented for the confirm
     (so nobody wipes a live tag left on the pad by accident);
   - tag content unreadable/blank → treat as blank, allow write;
   - after write: re-read, compare, show ✓/✗ with the SIF, and beep only on failure;
   - session write counter + ring buffer in `localStorage` (`rfid_writes`),
     exportable as CSV from the panel. Server-side audit would need a
     `plugins/run.pl` route, which in this fork requires the `plugins` permission
     flag — too restrictive for catalogers, so audit stays client-side in v1 (open
     question §9).
5. **Batch mode** (later): queue of items (paste barcodes / from a shelf-list) →
   present tag N, write, present tag N+1 — the natural next feature once single-item
   programming is trusted.

## 7. Milestones

- **M0 spike (~½ day)** — `git init`, copy driver/transport/tests/fixtures, esbuild
  bundle, deploy through the current file-drop path, and *verify on the live box*:
  (a) `$ENV{SCRIPT_NAME}` is the page script under plack (Gate A.1),
  (b) `userenv->{branch}` is populated for the RFID librarian (Gate A.2),
  (c) an inline bundle with `navigator.serial.getPorts()` works from the injected
  `<script>` on `returns.pl`. Any failure here changes §5's shape, so do it first.
- **M1 — a scan does the transaction** — ✅ built and deployed to the dev box. One page
  action, `act()` in `core/boot.js`: read the pad, ask the cursor what it wants (§3.2),
  write the tag's AFI, fill the box, post the form. Everything else on the page is
  synchronous; `act()` is the only thing that awaits.
  *Done:* pill with a chip per tag on the pad ✓, check-in/renew/checkout/patron routing by
  form action ✓, the AFI written at the scan ✓, posted-memory so a reload does not repost ✓,
  pad watching with appear/disappear ✓, deploy scripts ✓, 79 hardware-free tests ✓
  (`intent.test.mjs`, `transaction.test.mjs`), `tools/live/intent-probe.mjs` to re-check the
  routing against a real page without posting anything.
  Two rules fell out of the design and are worth keeping written down:

  - **Nothing posts without the cursor in one of our boxes.** That is what replaced
    `PAGE_TARGETS`, and what makes posting on every circulation page safe: a page nobody has
    clicked in is a page the plugin does not act on. It is also the only way the header
    quick-boxes work — Koha's Alt+R / Alt+W land in boxes that exist on pages with no
    circulation form of their own, which a page table could not see at all.
  - **One transaction per page load, remembered in `sessionStorage`.** The pad is shared
    state and the page comes back with the same book under the head; `postedTtl` is the
    difference between a queue and a loop. A stack of returns left on the pad at a checkout
    page is the hazard to keep an eye on: with the cursor in the checkout box they get
    issued, one per load, which is what a librarian sitting at that box means, and what
    `bookPrefix` (cards are not books) and the posted memory (no repeats) keep honest.

  Missing: a Connect affordance a librarian can see without being told (the pill and
  Ctrl+Alt+R are it for now).
- **M1a / M1b as originally written — built, deployed, deleted.** The AFI was deferred
  behind Koha's confirmation: `core/security.js` kept the owed writes in `sessionStorage`,
  `core/checkin.js` parsed the answer page for a date in a column, `core/alert.js` took over
  the screen and beeped when a book walked away unwritten, and `autoCheckin` decided which
  single page was allowed to post. About 500 lines and three modules, all of it removed the
  same day; §3.1 is the argument, and `git log` has the code.
  What survived the deletion is the part that was right: `reader.writeAfi()` (read-modify-write
  with a read-back that throws), the refusal to write a tag that is not on the pad, and the
  rule that the plugin never explains a failure Koha has already announced on the page.
- **M1b — submit everywhere, not just fill** — ✅ done, and it needed none of the plumbing
  planned above. Every circulation box posts, on every page, behind one switch
  (`autoSubmit`, on by default): the cursor is the per-transaction opt-in, so
  `autoCheckout` / `autoRenew` / per-page `post:` flags would have been three ways to say
  what focus already says. Parsing the answer page for a date in a column went the same way
  — it exists to decide whether to perform the *deferred* write, and there is no deferred
  write any more. Koha renders its own verdict, in context, beside the item; the plugin's
  job is that the right barcode reached the right box and that the tag now says what the
  transaction it started means.
- **M2 programming** — moredetail panel + guardrails + write log + placement photo.
  *Started:* the guard (four rules, `core/tagwrite.js`), the write log (`m0.writes`),
  `programming` off by default, read-back verification ✓ — all exercised on a real
  tag. Missing: the UI panel on `moredetail.pl`, and placement photo.
- **M3 polish** — Perl-side page/branch gating, config JSON, beep, `visibilitychange`,
  CSV export, browser-support + rollout docs, KPZ build for other installations,
  version tags + CHANGELOG.
- Later: batch programming, Firefox enterprise note, maybe BroadcastChannel
  multi-tab (explicitly *not* now, decision 4).

## 8. Testing without hardware

1. Driver capture replay (`live-capture.txt`) — moved as-is, keeps the protocol honest.
2. `intent.test.mjs` — the routing table (§3.2), including the two shapes a page table
   could not express: the header quick-boxes on a page with no circulation form, and one
   page carrying two fields named `barcode` that post to different transactions.
3. `transaction.test.mjs` — `install()` driven against a fake reader that **records what was
   written to it**, because "the security bit was updated" is a claim about hardware. Tag
   before box before post; no second post while the book stays on the pad; no post on the
   page that comes back (two fake windows sharing one `sessionStorage`); a stack handed over
   one at a time; a card that is not a book; a write that fails and transacts anyway; each
   switch off (`fill`, `autoSubmit`, `securityBit`); a cursor anywhere else doing nothing.
4. `tagwrite.test.mjs` — the programming guard: blank tag, short barcode, >16-byte barcode
   (must refuse), foreign barcode (must refuse unless repeated as `confirm`), duplicate on
   the pad (must refuse), write-stick failure (retry path).
5. `boot.test.mjs` — the dormant path touches **no DOM, no listeners and no timers**: the
   "don't bother anyone" rule (§5) is an executable test, not a promise. Also that a reader
   which fails to open is reported rather than thrown, and that arming needs a gesture.
6. `make test-policy` — the Perl gate (page/branch/user/superlibrarian), run on the server,
   29 cases. Not JS, and not optional: it is the gate that decides who gets the bundle.
7. Live but hardware-free: `tools/live/*.mjs` over CDP against the dev stack —
   `intent-probe.mjs` (what the plugin thinks each box means, and the pill's geometry),
   `focus-map.mjs` (what the boxes actually are), `page-logic.mjs`, `capture-circ-dom.mjs`
   (fixtures). Not built: a `?rfidFake=1` mode that drives the real page with a scripted
   reader in the browser — the node tests cover that ground without a browser.

## 9. Open questions

1. Branch allowlist vs. user allowlist vs. both for Gate A.2 — what matches how
   ffzg actually assigns desks? (Both are supported; need the default.)
2. The pill is visible on every enrolled page — `RFID —` on a browser nobody has armed, and
   that is the affordance for arming it. Worth it, or should a dormant desk see nothing until
   `?rfid=1`? (`hint: false` hides it; nobody has asked, which is weak evidence that four
   characters in a corner are not a cost.)
3. Programming audit: client-side ring buffer only (v1) — acceptable, or do we want
   writes recorded in Koha (needs a `run.pl` route + a permission grant for catalogers)?
4. Is the 2012 `moredetail.tt` patch going to stay patched in-tree, or should the new
   plugin *replace* it by hiding those notices from JS (it can, with a CSS/JS override)?
5. `Ctrl+Alt+R` acceptable as the one memorable shortcut (and keep `F4` for programming)?
6. A transaction Koha refused can leave the tag in the state that the refused transaction
   would have created (§3.1), and only another scan of that same book corrects it. Enough, or
   does "what should this tag say" need a record a second desk could ask — which means a
   route and a table in Koha, and the whole reason §4 exists is to not need one?
7. **Per-user or per-browser configuration.** Today a setting has exactly two homes:
   `RFID/koha-rfid.json`, which is the same for the installation and needs a deploy to
   change; and a URL parameter that writes a `localStorage` key (`?rfid=keep`,
   `?rfid=1`), which is per browser and needs knowing the URL. Nothing in between — so
   "this librarian wants no auto-submit", "this desk polls slower", "keep watching even
   when hidden" have no honest place, and `?rfid=keep` stays URL-only by decision until
   this is settled. To brainstorm at the end, roughly in this order:
   - Which keys are preferences at all, and which must stay server-side because they
     are permissions (`programming`) or enrolment (`pages`, `branches`, `users`).
   - Is server config the *ceiling* (a librarian may turn something off but never on)
     or the *default* (librarian may override either way)? The answer differs per key,
     which is the argument for naming that column rather than inventing a flag per key.
   - Where does it live: `localStorage` (per browser, survives logout, wrong when two
     librarians share a workstation), `sessionStorage` (per shift), or Koha (per user,
     survives everything, needs a route and a write — the thing §4 exists to avoid).
   - How it is changed without a URL and without an admin page — and whether the answer
     is the status pill's context menu, or nothing at all for v1.
