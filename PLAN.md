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
| 8 | **The AFI is written after Koha confirms, never before** (§3.1) |
| 9 | **A confirmed transaction whose security bit was not written takes over the screen and beeps** (§3.1) |

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
├── plugin/Koha/Plugin/Rot13/RFID.pm          # hooks, gating, inlines dist/koha-rfid.js
├── src/
│   ├── driver/rfid3m.js                      # 3M 810 protocol (copied, ESM)
│   ├── transport/webserial.js                 # port open / close / busy handling
│   ├── transport/fake.js                      # scripted byte log — tests w/o hardware
│   ├── core/boot.js                           # the 1 KB silent bootstrap (§5)
│   ├── core/session.js                        # arm/connect state machine, tab ownership
│   ├── core/state.js                          # localStorage AFI map, dedup, pending
│   ├── core/popup.js                          # toast/panel UI, Connect, status dot
│   ├── core/scan.js                           # rfid_scan() circulation page logic (moved)
│   └── program/panel.js                       # moredetail.pl programming UI (§6)
├── build/bundle.mjs                           # esbuild: core → IIFE, es2020, window.RFID
├── tests/{driver,state,program}.test.mjs + fixtures/live-capture.txt
├── tools/deploy.sh  tools/deploy-plugin.sh    # adapted from the Go repo, self-contained
├── docs/{protocol,browser-support,rollout,legacy-2012-2017}.md
├── Makefile                                   # bundle, test-js, lint, deploy, kpz
└── README.md  LICENSE  CHANGELOG.md
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

### 3.1 The security bit (AFI) follows Koha, never leads

| AFI | meaning | who cares |
|---|---|---|
| `DA` | checked in, secure | the door ignores the book |
| `D7` | on loan, unsecure | the door alarms |

Ground truth, not memory: `koha-rfid-go/internal/rfid/reader.go:532` defines
`AfiSecure = 0xDA` / `AfiUnsecure = 0xD7`, and tags in this library read `DA` on a shelf
book (`tests/fixtures/live-capture.txt:19`, and `1302079605` again on 2026-09-02).
The rule is the Go client's, restated in `koha-rfid-go/koha-workflow.md:7`:
**Koha state takes priority over tag state; the AFI changes only after Koha confirms.**

Write before the submit and three things go wrong: Koha refuses (hold, not-checked-out,
needs-confirmation) and the tag now asserts what the catalogue denies; the previous state
is gone, so a retry has nothing to go back to; and "did the transaction work?" loses its
independent answer, because the only thing that changed is the thing you changed.

Check-in, end to end:

1. tag on the pad → `from` is the AFI that came back with the content (`scan()` already
   returns `security`, no extra command);
2. post the form, and store `rfid_afi[barcode] = { sid, from, to: 'DA', at }`;
3. the page reloads — which is why the owed write lives in storage and not in a variable:
   the confirmation arrives on a page that did not exist when the write was scheduled;
4. confirmed (the date-in-column rule, §3 of `core/checkin.js`) → if the tag is still on
   the pad, `writeAfi` (retries until the read-back matches) and clear the entry;
5. **not** confirmed → drop the entry. Nothing is owed; the tag was never touched;
6. confirmed and the tag is gone → the entry stays, and the takeover below fires.

AFI is a hint, never a gate: check-in does not filter on it (a book reading `DA` may well
still be on loan — a write that failed a month ago), and `DA` on checkout only suggests
the book is in the building. Koha decides; the tag is told afterwards.

The first version of this port did not write the AFI at all — `core/checkin.js` never
called the reader, so a returned book kept the `D7` it was issued with and told every
system that reads tags that it was still on loan. `core/security.js` (M1a) is what closes
that. The inverse slip is the one that cannot be survived: a book on loan carrying `DA`,
which the Go constants comment describes as "door will ignore" — so M1b writes `D7` only
after an issue is confirmed, and never on the way in.

#### The unwritten bit is the one error not to walk past

A wrong due date is corrected at the desk; a book that leaves the building while the door
is muted for it is not noticed at all. So:

- **Trigger:** an owed write, confirmed by Koha, with the tag off the pad for more than
  `securityGraceMs` (default 8 s — the librarian lifting the book to shelve it while the
  page reloads is normal, and should be over by itself).
- **Takeover** (`core/alert.js`, one element, `position:fixed;inset:0`, above everything):
  the barcode in large type, what happened in one line ("Koha has it back on the shelf —
  its security bit is still set to *on loan*"), what to do ("put it back on the reader"),
  and live state: *not seen yet* → *seen, writing* → *done*. Not a toast: a toast is what
  the last thing nobody read looks like.
- **Sound:** a WebAudio oscillator, no asset, a short repeating pattern until it is over.
  Audio needs a gesture; the click that armed the reader is one, and if the context is
  still suspended the overlay says so and clicking it makes it loud.
- **Only two ways out, and neither is a timer:** the tag comes back and the write verifies
  (close, toast); or an explicit acknowledge, which drops the entry and appends to
  `rfidM0.securitySkipped` — barcode, sid, how long it waited — with a log line saying the
  bit was left at `D7` *deliberately*. That is a decision the librarian made, and the log
  is where it belongs.
- `Esc` acknowledges. A modal nobody can leave is worse than one that can be left
  knowingly: the requirement is loud and recorded, not a cage.
- The entry survives until it is written or acknowledged, so the same book on the pad an
  hour later gets its write and a quiet toast instead of a shout.

Wiring: `onOutcome` in `boot.js` is the verify point, the pad updates from the watch are
the "is it back?" signal, and `reader.writeAfi` is the only thing that touches hardware.
The state is per browser: a book returned at desk A and carried to desk B will not shout
there — see §9.6 for whether that needs a server-side ledger.

## 4. Config (no plugin config table exists on this Koha)

- `RFID/koha-rfid.json` next to the plugin — read by `RFID.pm` at request time
  (stat-cache it), passed to the bundle as a JSON literal:
  ```json
  { "pages": ["circ/returns.pl", "circ/circulation.pl", "circ/circulation-home.pl",
              "circ/renew.pl", "catalogue/moredetail.pl", "mainpage.pl"],
    "branches": [],  "users": [],  "bookPrefix": "130",
    "hint": true,        "debug": true,        "programming": true,
    "autoCheckin": true, "checkinTtl": 60,     "toasts": true,
    "fillCheckin": true, "watch": true, "watchIntervalMs": 600,
    "pauseWatchWhenHidden": true,
    "securityUpdate": true, "securityGraceMs": 8000, "securityBeep": true }
  ```
  The file in this repo is the **development** one, with `debug`, `programming` and
  `autoCheckin` on to make hardware testing possible. `programming` (writing to tags)
  and `autoCheckin` (posting without anyone pressing Return) are the two that need a
  conscious decision per installation; both default to off in the code.
- Per-browser state in `localStorage`: `rfid_armed` (this desk has a reader and may
  talk to it), `rfid_keepwatching` (`?rfid=keep`). Per-tab in `sessionStorage`:
  `rfid_checkin` (what is in flight, so the answer survives the reload it causes), and
  `rfid_afi` (writes owed to tags, §3.1 — it outlives the page that owed them).
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
  - Default UI is a **36 px status dot** in the corner: grey = dormant/connecting,
    green = ready, amber = armed but no device, red = port busy/error.
  - Scan results appear as a **1.5 s toast**, never a modal; the persistent panel
    exists only after the user clicks the dot (that's also where the debug log lives).
  - Errors never interrupt a transaction: no `alert`, no blocking dialog, no sound
    unless `beep: true` and the failure is a write failure during programming.
  - Nothing is auto-focused, nothing captures keystrokes — the existing
    "scan into the barcode box with a scanner/keyboard" workflow is untouched.
  - Optional: `?rfid=quiet` suppresses even the footer hint for the session.

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
- **M1 core** — bootstrap + session state machine + status dot/toast + Connect,
  scan path for returns/circulation/renew with page logic moved verbatim,
  deploy scripts, driver capture-replay tests, README.
  *Done:* status pill ✓, check-in autofill ✓, pad watching with appear/disappear
detection ✓, page targets for `returns.pl` / `circulation.pl` / `renew.pl` ✓, deploy
scripts ✓, tests ✓ (77, hardware-free).
  Page targeting is not one selector: `circulation.pl` renders three forms with a field
named `barcode` (the checkout box plus the returns and renew boxes in the header) and
`renew.pl` has a hidden `#ren_barcode` in a `display:none` panel. The page picks the
form, the form picks the field, and the tie-break is `id="barcode"` — the id Koha gives
the field the librarian uses. Live on the reader: tag on the pad → the visible box on
each page holds the barcode, both header copies stay empty, nothing is submitted.
  Check-in remains the only thing the plugin may post (`PAGE_TARGETS[].post`); filling
the checkout box is where auto-checkout would start, and it is deliberately not taken.
  Missing: a Connect affordance a librarian can see without being told (the pill and
  Ctrl+Alt+R are it for now).
- **M1a — the security bit** (§3.1): ✅ done. `core/security.js` (the owed-write machine:
  `owe` at post time → `verdict` on the page that answers → `pad()` writes `DA` to a tag
  that is still in range, shouts about one that is not) and `core/alert.js` (the takeover:
  covers the page, beep through the window's `AudioContext`, moving title bar, exits are
  the verified write and an acknowledge that records; `Esc` is the button). Wiring is three
  lines deep — `owe` in `postCheckin`, `verdict` in `onOutcome`, `pad()` after every page
  load / pad change / `rescan()`. Config `securityUpdate` (on unless switched off — nothing
  can be owed unless posting was opted into), `securityGraceMs`, `securityBeep`; the debug
  surface gained `rfidM0.tagWrites()`, `rfidM0.securitySkipped()`, `rfidM0.showSecurityAlert()`.
  Tests: `security.test.mjs` (the machine), `alert.test.mjs` (the screen), and
  `checkin-afi.test.mjs`, which drives `install()` through three page loads — posted, then
  confirmed with the book still there (written), then gone (screen), then back (written and
  screen down), plus the refusal that writes nothing and makes no noise.
- **M1b — submit everywhere, not just fill**: `circulation.pl` and `renew.pl` post as well
  as fill (the fill-only rule in M1 was my decision, and it is being overruled — a
  librarian scanning at a patron's page means it). Order of work is not negotiable:
  capture the *success* states first (`#issues-table` row with a date for an issue; the
  renewed date for a renewal; refusal shapes), because posting is the easy half and
  knowing whether it worked is the whole problem — then `post: true` per page behind
  `autoCheckout` / `autoRenew`, and `D7` written only after the issue is confirmed.
  Known hazard, to design against and not discover: the pad is shared state. A stack of
  returns still on the pad while a patron's page is open becomes, with checkout on, an
  issue to that patron. Candidate answers: act only on tags that *arrive* while the page
  is open (not what was already there), one write per tag per page, `bookPrefix` still
  excludes cards.
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
2. `state.test.mjs` — AFI map / 10 s dedup / pending-across-reload / stale sweep
   against an injected fake `localStorage` (today unreachable without a live page).
3. `program.test.mjs` — scripted `FakeTransport`: blank tag, short barcode, >16-byte
   barcode (must refuse), foreign barcode (must refuse), write-stick failure (retry path).
4. `security.test.mjs` — owed write appears only on a confirmed outcome, survives the
   reload, is skipped when Koha refuses, fires when the tag returns, and the takeover
   opens after the grace and closes on the write, never on a timer.
5. `alert.test.mjs` — the overlay covers, beeps through an injected AudioContext, and the
   only dismissals are the write and an acknowledge that records.
6. Bootstrap tests: assert the dormant path touches **no DOM and no timers** — the
   "don't bother anyone" rule becomes an executable test, not a promise.
7. E2E against koha-dev with rodney/CDP (ported from the Go repo), plus a
   `?rfidFake=1` mode that injects `FakeTransport` in the browser so e2e also runs
   with the reader unplugged.

## 9. Open questions

1. Branch allowlist vs. user allowlist vs. both for Gate A.2 — what matches how
   ffzg actually assigns desks? (Both are supported; need the default.)
2. Should the status dot be *always visible* for armed sessions, or only on
   hover/error? (Staff being able to see "reader is asleep" at a glance is useful.)
3. Programming audit: client-side ring buffer only (v1) — acceptable, or do we want
   writes recorded in Koha (needs a `run.pl` route + a permission grant for catalogers)?
4. Is the 2012 `moredetail.tt` patch going to stay patched in-tree, or should the new
   plugin *replace* it by hiding those notices from JS (it can, with a CSS/JS override)?
5. `Ctrl+Alt+R` acceptable as the one memorable shortcut (and keep `F4` for programming)?
6. Owed AFI writes are per browser (§3.1). Is that enough, or does a book that was never
   updated need to be findable from anywhere — which means a record in Koha, and the whole
   reason §4 exists is to not need one?
6. **Per-user or per-browser configuration.** Today a setting has exactly two homes:
   `RFID/koha-rfid.json`, which is the same for the installation and needs a deploy to
   change; and a URL parameter that writes a `localStorage` key (`?rfid=keep`,
   `?rfid=1`), which is per browser and needs knowing the URL. Nothing in between — so
   "this librarian wants no toasts", "this desk polls slower", "keep watching even when
   hidden" have no honest place, and `?rfid=keep` stays URL-only by decision until this
   is settled. To brainstorm at the end, roughly in this order:
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
