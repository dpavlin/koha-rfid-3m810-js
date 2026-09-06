# Live verification, as files

Every claim in `PLAN.md` about what the plugin does on a real Koha page came from one
of these. They are scripts for `browser_execute`, kept so a claim can be re-checked in
a minute instead of re-derived in an hour.

| script                 | what it answers                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `focus-map.mjs`        | what fields a scan could land in, on each page — ids, forms, where they post, which carry an `accesskey`                                                                                                                                                                                                                                                                                 |
| `intent-probe.mjs`     | what the plugin says it would do with a tag for each of those boxes, and what the pill looks like                                                                                                                                                                                                                                                                                        |
| `accesskey-probe.mjs`  | whether Koha's own `accesskey="r"` lands the cursor where the plugin agrees — and finds the decoy (`accesskey="q"`, the catalog search)                                                                                                                                                                                                                                                  |
| `capture-circ-dom.mjs` | the page shapes into `tests/fixtures/` so they stop being memory                                                                                                                                                                                                                                                                                                                         |
| `page-logic.mjs`       | does the filled box land in the form that performs the transaction                                                                                                                                                                                                                                                                                                                       |
| `corner-probe.mjs`     | the pill's geometry: does it sit on top of anything Koha needs                                                                                                                                                                                                                                                                                                                           |
| `state.mjs`            | everything the tab knows, as JSON: page and params, where the cursor is, the pill's text, the barcode fields and where they post, `RFID_CONTEXT`/`CONFIG`/`ITEM`, all of `m0` (gate, pad tags, tag writes, `paused` reason), the wire log (last 200 lines of it) and localStorage + sessionStorage. No flags — `node tools/live/state.mjs > state.json`, and it prints which tab it read |

`state.mjs` is the one that runs from a plain shell, because "what does the desk's browser think
right now" should not need an agent to answer:

```sh
node tools/live/state.mjs > state.json     # stderr says which tab it read
node tools/live/state.mjs | jq '.plugin.tags, .plugin.programs, .storage.sessionStorage.rfid_posted'
```

No flags. It probes `127.0.0.1:9222` then `9333` for a DevTools endpoint, takes the first Koha tab
and reads it — one `Runtime.evaluate`, no navigation, no login, no click. It needs Chrome started
with `--remote-debugging-port`, which is an unauthenticated driver for the whole browser: keep it
on loopback, and never open that port to a network to make a dump easier.

It is where `paused` becomes visible. A desk can show a green pill and `gate: ready` while the pad
watch is dead (`m0.paused = "gave up after 3 read failures"`, usually because another tab holds
the serial port), because the pill puts the reason in its tooltip, where nobody looks.

`state.mjs` is also the export for tag writes: `.plugin.programs` is the ring buffer of what the
page wrote, which is the only record of a programming session while the Koha-side audit row stays
blocked (PLAN §6) — the reason there is no CSV button in the panel is that the only consumer of
that file is a test run. Two rules follow from where the data lives, and they bind every script
here that reads a tab:

- **never navigate to help.** The state is on a page's `window`; `k.open()` attaches by calling
  `Page.navigate`, so a tool that navigates erases its own evidence and reports a clean empty
  result over the grave. Attach by target id, or with `Runtime.evaluate` alone.
- **never log in to help.** A tab at the staff login page has no plugin and no buffer, and there
  is nothing to recover. A dump that starts succeeding on its own has begun fabricating the
  conditions of its own success.

Dump after programming, before navigating away or logging out.

`focus-map.mjs` and `intent-probe.mjs` are the pair worth knowing: the first is the page
as it is, the second is the plugin's opinion about it, and a design change is exactly the
gap between the two closing. Both are read-only — no posts, no tag writes — so they can run
against a real catalogue.

## The pattern

Put the body **here**, exporting `run(session, k)`, and send `browser_execute` only:

```js
const k = await import('/tmp/live-RUN/koha-cdp.mjs');
const m = await import('/tmp/live-RUN/page-logic.mjs');
try {
	session.close();
} catch (e) {} // stale sessionId after a browser restart
await session.connect();
return await m.run(session, k);
```

The harness caches imported modules **by path**, so a `?t=` query does _not_ re-read a
changed file — edits appeared to do nothing until the file was copied somewhere new.
Make the directory new instead, which also keeps a run reproducible:

```sh
RUN=/tmp/live-$(date +%s); mkdir -p $RUN
cp tools/live/page-logic.mjs .pi/browser-execute-workspace/koha-cdp.mjs $RUN/
node --check $RUN/*.mjs && echo $RUN
```

`node --check` is the step not to skip. That is the whole reason these are files. A syntax error inside a `browser_execute`
snippet is reported by the harness wrapper as `missing ) after argument list` with no
file and no line — and escaped regexes inside template literals (`\\s+`) fail exactly
that way. In a file, `node --check` says which line.

## Runtime state

`k.trace(...)` appends to `/tmp/cdp-trace.log` (`k.TRACE_FILE`). It survives the snippet
throwing halfway, which is precisely when the state matters; a return value does not.
`cat /tmp/cdp-trace.log | tail -20` after a failed run.

## House rules

- **Never assume a tab.** Take it from `session.getTargets()` by URL, as `k.open()` does.
  Other calls move the current page around, and a verification run against the wrong
  tab reads like a plugin bug.
- **Attach before you evaluate.** Nothing works until `session.use(targetId)`, and the
  CDP error is `Session with given id not found` — which sounds like a dead browser and
  is usually a missing `k.open()`. `k.login()` navigates on the current tab, so it runs
  _after_ `k.open()`, and the page under test is opened _after_ login (probing before
  login is how one run reported `gate: 'idle'` on `mainpage.pl`).
- **A restarted browser invalidates the persistent session.** `session.close();
await session.connect();` — the same `-32001` as above, from the other direction.
- **Log in through `k.login()`** — credentials come from `~/koha-dev.env` and never
  appear in a snippet or in this repo.
- **These change data** (issuing, checking in). Say so in the file's header, and put the
  machine back afterwards (check the item in) unless the file says otherwise.
- A verification that produced a claim worth keeping also produces a **fixture**: save
  the page HTML to `tests/fixtures/` so the behaviour becomes a hardware-free test.
