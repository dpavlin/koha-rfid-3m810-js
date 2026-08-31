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

## 4. Config (no plugin config table exists on this Koha)

- `RFID/koha-rfid.json` next to the plugin — read by `RFID.pm` at request time
  (stat-cache it), passed to the bundle as a JSON literal:
  ```json
  { "pages": ["circ/returns.pl", "circ/circulation.pl", "circ/circulation-home.pl",
              "circ/renew.pl", "catalogue/moredetail.pl"],
    "branches": ["FFZG"],  "users": [],  "bookPrefix": "130",
    "beep": true, "debug": false }
  ```
- Per-browser state in `localStorage`: `rfid_armed`, `rfid_afi`, `rfid_writes`.
- No syspref, no DB writes, no admin page needed to run it.

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
  *Partly done:* status pill ✓, check-in autofill ✓, pad watching with appear/disappear
detection ✓ (all three verified against the live reader), deploy scripts ✓, tests ✓.
  Missing: session state machine, explicit Connect UI, circulation/renew page logic.
- **M2 programming** — moredetail panel + guardrails + write log + placement photo.
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
4. Bootstrap tests: assert the dormant path touches **no DOM and no timers** — the
   "don't bother anyone" rule becomes an executable test, not a promise.
5. E2E against koha-dev with rodney/CDP (ported from the Go repo), plus a
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
