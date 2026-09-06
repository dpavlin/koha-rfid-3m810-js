# Notes for agents

Koha plugin for 3M 810 RFID readers over Web Serial. **Read `PLAN.md` for status and
next steps; `README.md` explains the design and what a librarian sees.** Only the
things that cost real time go here.

## `koha-rfid.js` is not in git

`plugin/Koha/Plugin/Rot13/RFID/koha-rfid.js` is the **build output** (`make bundle`
from `src/`), gitignored, inlined into the staff page by `RFID.pm`. There is no
hand-written `koha-rfid.js` to read, edit, or "restore" — the sources are `src/`, and
the plugin is `plugin/Koha/Plugin/Rot13/RFID.pm`. Never edit the bundle.

## The reader answers one client at a time

Web Serial, the CLI, and the old Go server all cannot hold the port together, and a
second browser tab gets Chrome's unhelpful `Failed to open serial port` (the plugin
adds "another tab may be holding it"). Check with `sudo fuser -v /dev/ttyUSB1`; the
development reader is reached over a hand-made USB/IP tunnel — see
`docs/usbip-reader.md` before debugging "the reader is broken".

Polling pauses while the tab is not in front (`?rfid=keep` overrides); a tab driven by
CDP while backgrounded sees no scans until you ask for it. That is a feature: nobody
gets checked in behind their own screen.

## Formatting is `.prettierrc.json`, and running prettier without it rewrites the repo

Tabs, `tabWidth: 4`, single quotes, `printWidth: 120` — the settings the existing files were
formatted with, now pinned in `.prettierrc.json`. `npx prettier --write` before that file
existed used prettier's defaults (2 spaces, double quotes) and reformatted every file in
`src/` and `tests/`, which buried a 300-line change under 1,200 lines of indentation and had
to be undone by writing the config and re-running. Check formatting config before blaming a
tool for a large diff. Prettier also **re-pads markdown tables**, so an `edit` anchor copied
from an earlier read of a table row stops matching after any prettier run — insert rows with a
script and let prettier align them.

## The cursor is the routing decision — read the form, never the field name or the page

A scanned tag does what the focused box does, and `intentOf()` decides that from **which
page the field's form posts to**. Field ids and paths are both traps that have already cost
time here:

- `name=barcode` is the check-in box, the renew box and the checkout box on one page, and
  `renew.pl` checks an item in **and issues it back out** — routing by `name` is a silent
  data-corruption bug.
- `#barcode` is not only the body box: the header quick-boxes are `#ret_barcode` and
  `#ren_barcode`, and they exist on pages that have no circulation forms of their own
  (`mainpage.pl`). A page table could not see them. `#ret_barcode` is `accesskey="r"`,
  `#search-form` is `accesskey="q"`, and **nothing else has a letter key** — this Koha binds
  no Alt+letter in JS (checked with `jQuery._data(document,'events')`), so there is no Alt+W
  for renew and no Alt+U for patrons, and a probe that presses them proves nothing.
  Those two boxes are also `getClientRects().length === 0` until the header panel opens, so
  `el.focus()` silently fails on them and `document.activeElement` keeps reporting the box
  that still has the cursor: a probe that focuses every box it finds will report the same
  intent twice and read it as a routing bug. Report `focused` and `visible` per row.
- `circulation.tt` renders `#barcode` **disabled** under `NEEDSCONFIRMATION`; filling a box
  the page switched off looks like readiness. `intentOf` returns null for it.

The corollary for tests: `tests/helpers/fakewindow.mjs` back-links `field.form`, because a
fake DOM without that link cannot express the only ambiguity that matters.

## Nothing may post before the tag finishes writing

`form.submit()` navigates, navigation unloads the page, unloading closes the serial port,
and a write still in flight is a tag that silently kept the wrong security bit — the failure
this whole design was chosen to remove. So `act()` is the only async page action, and it
chains `fixBit()` **before** `post()`; everything else in `boot.js` is synchronous on
purpose. Do not make `act()` fire-and-forget because the await "does nothing".

## A test suite that prints results and never exits is holding a timer

Every browser surface is reached through the injected `win` — serial ports, storage,
timers. A module that grabs `globalThis.setInterval` behind the fake window's back schedules
a **real** interval in tests, and `node --test` then prints its results and hangs until the
timeout, which looks exactly like a slow machine.

The live version of this trap: `watch()` in `src/main.js` uses the global `setTimeout`, not
the window's. Any test that installs against a _ready_ reader therefore starts a real timer
chain unless the config says `watch: false` — which is what `tests/transaction.test.mjs`
passes. `tests/helpers/fakewindow.mjs` fakes and records the window's timers, so an
accidental global one shows up as a missing handle rather than a mysterious 120 s run.

## Two seams that silently swallow config

- A client-side config key is **whitelisted in `RFID.pm`** (`qw(hint debug bookPrefix …
logLines)` in `intranet_js`). Add the key to `koha-rfid.json` and forget the whitelist and the
  browser never sees it, with nothing to read back the omission.
- In `src/core/boot.js`, **`cfg` must stay declared above `note()`**: the first line the plugin
  ever writes (`no navigator.serial — staying dormant`) runs before the dormancy checks, and the
  log ceiling (`logLines`) is read inside `note()`. Declaring `cfg` later is a temporal dead zone
  on exactly the page where the plugin must not throw.

## Where the fork's own code lives (read templates there, not /usr/share)

This installation carries its own copies of the staff templates in **`/srv/koha_ffzg`**,
template root `/srv/koha_ffzg/koha-tmpl/intranet-tmpl/prog/en/modules/`, and this fork
uses the **`.tt`** extension (`circ/circulation.tt`, `circ/renew.tt`), not `.tmpl` —
`/usr/share/koha/...` has upstream files and `.tmpl_upgrade_backup` leftovers that are
not what the browser receives. Reading the template is how page logic gets designed
before touching a live page: e.g. `circulation.tt` renders `input#barcode` **disabled**
under `NEEDSCONFIRMATION`, which a fill-on-scan has to respect.

## Logging in, and where the credentials are

Live verification uses the dev staff client at `https://ffzg.koha-dev.rot13.org:8443`. The
Chrome that carries the Koha tabs, the serial reader and the CDP endpoint is launched with
`--user-data-dir=~/.ds4/browser --remote-debugging-port=9333`; that port is an unauthenticated
driver for the whole browser — loopback only, and never opened to a network to make a dump
easier. Credentials: **`~/koha-dev.env`**
(`KOHA_USER`, `KOHA_PASS`, `KOHA_URL`) — read them from there with
`.pi/browser-execute-workspace/koha-cdp.mjs`'s `login(session)`; never paste a password
into a snippet, and never guess one. Sessions expire mid-work and the failure is
silent: the staff page comes back containing `#loginform`.

18.11 quirk worth knowing: `#Login` is the submit _input_, not the form — submitting it
throws, which looks exactly like a failed login.

## Driving that browser over CDP

- **Any navigation kills the attached session.** After `login()`, `Page.navigate`, or a page
  posting a form, the old session id is gone (`Session with given id not found`). Re-attach
  inside the same snippet: `try { session.close() } catch {}` → `session.connect()` →
  `k.open(session, url)` → evaluate. A second snippet that assumes the session survived fails.
- **`console.log` inside an imported module is not captured** — only the snippet's console is.
  A tool imported from `tools/live/` must return its report and let the snippet print it, or it
  is silent exactly where it is being watched.
- **A CDP `id` match is not a response.** `Runtime.evaluate` answers with an empty `{result:{}}`
  frame now and then; resolve only on `result.result`, or the tool reports `undefined is not
valid JSON` about a page that answered fine.
- **`state.mjs` never navigates and never logs in.** The state it dumps is on a page's `window`:
  navigating to help erases the evidence it came for, and a tab at the staff login page has
  nothing to recover. A dump that succeeds by fixing the tab is fabricating its own conditions.
- **Koha loads with the cursor in a search field**, and the plugin refuses <kbd>F4</kbd> while a
  field has focus (by design). A live probe that presses <kbd>F4</kbd> without blurring first
  measures nothing.
- `browser_execute` wraps the snippet body in `(...)`: an expression list with `;` will not
  parse — use `(() => { ... })()`.

## Production is log files, and nothing else

`koha.ffzg.hr` is the live library and runs **no RFID plugin at all**. It is read through
`/var/log/apache2/other_vhosts_access.log*` (grep only): that is where the page-usage counts in
PLAN come from. No queries against its database, no files written, no commands run to "just
check a version" — the dev box (`koha-dev.rot13.org`, instance `ffzg`) is where anything is
measured or changed.

## The dev install's version decides what is possible

It is `koha-common 19.11.05-1`: **no plugin `routes()`** (the only plugin HTTP entry is
`plugins/run.pl`, gated on the `plugins` permission), `action_logs` has eight columns with no
`action_extra`, and `C4::Log::logaction` inserts regardless of any preference. These are
measured, with the consequences for the audit row, in **PLAN §6** — read it before designing
any server-side round trip.

## Verifying against real Koha

`make test` is hardware-free and must stay that way; real behaviour is verified on the
dev stack with the committed CDP helpers in `.pi/browser-execute-workspace/` (tracked,
for once) and
`make log` / `make live-log` on the server. `make deploy` deploys **this** repo — the
plugin in `koha-rfid-go` is the previous architecture and is not what runs.
