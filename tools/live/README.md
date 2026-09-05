# Live verification, as files

Every claim in `PLAN.md` about what the plugin does on a real Koha page came from one
of these. They are scripts for `browser_execute`, kept so a claim can be re-checked in
a minute instead of re-derived in an hour.

| script                 | what it answers                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `focus-map.mjs`        | what fields a scan could land in, on each page — ids, forms, where they post, which carry an `accesskey`                                 |
| `intent-probe.mjs`     | what the plugin says it would do with a tag for each of those boxes, and what the pill looks like                                        |
| `accesskey-probe.mjs`  | whether Koha's own `accesskey="r"` lands the cursor where the plugin agrees — and finds the decoy (`accesskey="q"`, the catalog search)  |
| `capture-circ-dom.mjs` | the page shapes into `tests/fixtures/` so they stop being memory                                                                         |
| `page-logic.mjs`       | does the filled box land in the form that performs the transaction                                                                       |
| `corner-probe.mjs`     | the pill's geometry: does it sit on top of anything Koha needs                                                                           |
| `write-log.mjs`        | what the plugin wrote to tags in this tab, as CSV — plus the pad, the gate, where the cursor is, and whether the 2012 notices are hidden |

`write-log.mjs` is different from the rest: it dumps `m0.programs`, the ring buffer of tag
writes, which is the only record of a programming session while the Koha-side audit row stays
blocked (PLAN §6). It is the replacement for a CSV button — the file's only consumer is a test
run, so it lives here rather than in a panel librarians would have to ignore forever. Two rules
follow from where the data lives, and both are in the code:

- **it never navigates.** The buffer is an array on a page's `window`; `k.open()` attaches by
  calling `Page.navigate`, so a tool that navigates to help erases its own evidence and prints a
  clean empty CSV over the grave. It attaches by target id instead.
- **it never logs in.** A tab at the staff login page has no plugin and no buffer, and there is
  nothing to recover; the tool says so and stops. If a dump ever starts working by itself, that
  is a bug — it would mean it was fabricating a session to look successful.

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
