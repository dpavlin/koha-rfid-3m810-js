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

## Verifying against real Koha

`make test` is hardware-free and must stay that way; real behaviour is verified on the
dev stack with the CDP scripts under `.pi/browser-execute-workspace/` and
`make log` / `make live-log` on the server. `make deploy` deploys **this** repo — the
plugin in `koha-rfid-go` is the previous architecture and is not what runs.
