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

## Where the fork's own code lives (read templates there, not /usr/share)

This installation carries its own copies of the staff templates in **`/srv/koha_ffzg`**,
template root `/srv/koha_ffzg/koha-tmpl/intranet-tmpl/prog/en/modules/`, and this fork
uses the **`.tt`** extension (`circ/circulation.tt`, `circ/renew.tt`), not `.tmpl` —
`/usr/share/koha/...` has upstream files and `.tmpl_upgrade_backup` leftovers that are
not what the browser receives. Reading the template is how page logic gets designed
before touching a live page: e.g. `circulation.tt` renders `input#barcode` **disabled**
under `NEEDSCONFIRMATION`, which a fill-on-scan has to respect.

## Logging in, and where the credentials are

Live verification uses the dev staff client at `https://ffzg.koha-dev.rot13.org:8443`,
and the CDP Chrome profile is `~/tmp/koha-rfid-chrome`. Credentials: **`~/koha-dev.env`**
(`KOHA_USER`, `KOHA_PASS`, `KOHA_URL`) — read them from there with
`.pi/browser-execute-workspace/koha-cdp.mjs`'s `login(session)`; never paste a password
into a snippet, and never guess one. Sessions expire mid-work and the failure is
silent: the staff page comes back containing `#loginform`.

18.11 quirk worth knowing: `#Login` is the submit *input*, not the form — submitting it
throws, which looks exactly like a failed login.

## Verifying against real Koha

`make test` is hardware-free and must stay that way; real behaviour is verified on the
dev stack with the committed CDP helpers in `.pi/browser-execute-workspace/` (tracked,
for once) and
`make log` / `make live-log` on the server. `make deploy` deploys **this** repo — the
plugin in `koha-rfid-go` is the previous architecture and is not what runs.
