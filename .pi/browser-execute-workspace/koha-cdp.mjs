// CDP helpers for verifying the RFID plugin on live Koha pages.
//
// Tab selection is the failure this guards against: other tools (and other agent
// calls) move the "current page" around, so never assume a tab. Every helper here
// takes/returns an explicit targetId.
//
// GOTCHA: browser_execute caches an imported path for the whole pi session — editing
// this file does not reach a session that already imported it, and `?t=` does not
// defeat that cache. After changing it, import a copy under a new name (cp + new
// filename) or restart the session; "k.login is not a function" means exactly this.
//
// Usage from browser_execute:
//   const k = await import('/home/dpavlin/koha-rfid-3m810-js/.pi/browser-execute-workspace/koha-cdp.mjs?t=' + Date.now())
//   await session.connect()
//   const t = await k.open(session, 'https://.../circ/returns.pl')
//   return await k.probe(session, t)
//
// HOW TO WRITE THE SNIPPET (learned the slow way, twice):
//   Put the body in a file under tools/live/ exporting run(session, k), and send
//   browser_execute only the import + call. Then `node --check tools/live/x.mjs`
//   catches a syntax error with a filename and a line number *before* the browser is
//   touched — a parse error inside browser_execute's own wrapper reports neither, and
//   escaped regexes inside template literals (`\\s+`) hit exactly that dead end.
//   For runtime state use trace(): it appends to /tmp/cdp-trace.log, which is still
//   there when the snippet threw halfway, unlike a return value.

import { appendFileSync } from 'node:fs';
import { Script } from 'node:vm';

const KOHA_BASE = 'https://ffzg.koha-dev.rot13.org:8443/cgi-bin/koha';
export const TRACE_FILE = '/tmp/cdp-trace.log';

/** Append to a log file: survives the throw, and is readable after the call returns. */
export function trace(...parts) {
	try {
		appendFileSync(TRACE_FILE, `${new Date().toISOString().slice(11, 19)} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`);
	} catch {
		/* logging must never be the reason a verification fails */
	}
}

/** trace + return, for inlining into a chain: return await k.step('issued', {...}) */
export function step(label, value) {
	trace(label, value);
	return value;
}

export function url(page, params = {}) {
  const q = new URLSearchParams({ ...params, cb: String(Date.now()) });
  return `${KOHA_BASE}/${page}?${q}`;
}

export async function pages(session) {
  const targets = await session.getTargets();
  return targets.filter((t) => t.type === 'page');
}

/** Reuse a tab already on the Koha origin, or create one. Returns the targetId. */
export async function open(session, targetUrl) {
  const existing = (await pages(session)).find((t) => t.url.includes('koha-dev.rot13.org'));
  let targetId = existing?.targetId;
  if (!targetId) {
    targetId = (await session._call('Target.createTarget', { url: 'about:blank' })).targetId;
  }
  await session.use(targetId);
  await session._call('Page.enable');
  await session._call('Page.navigate', { url: targetUrl });
  await waitForLoad(session);
  return targetId;
}

export async function waitForLoad(session, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await evaluate(session, 'document.readyState');
    if (state === 'complete' || state === 'interactive') {
      // readyState can flip before the injected bundle's script tag runs
      await new Promise((r) => setTimeout(r, 250));
      return state;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return 'timeout';
}

/**
 * Compile the page expression here, where a mistake costs milliseconds and names the
 * line. Without this, one missing brace on line 5 of a big JSON.stringify came back as
 * "snippet threw: SyntaxError: Unexpected token ')'", which points at the browser_execute
 * snippet and not at the expression, and sent me looking in the wrong file twice.
 */
function parseCheck(expression) {
  try {
    new Script('(' + expression + ')');
  } catch (e) {
    const where = (e.stack || '').split('\n').slice(1, 4).join('\n');
    throw new Error('page expression will not parse: ' + e.message + '\n' + where);
  }
}

export async function evaluate(session, expression) {
  parseCheck(expression);
  const res = await session._call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    // Do NOT report only the page's message: a page-side SyntaxError then looks
    // exactly like the browser_execute snippet failing to parse, and the search for
    // the typo goes to the wrong file. Always name the expression.
    const d = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'unknown';
    throw new Error('page eval failed: ' + d.split('\n')[0] + ' — in: ' + expression.replace(/\s+/g, ' ').slice(0, 90));
  }
  return res.result?.value;
}

/** What the plugin and the bootstrap think this page is. The M0 checklist. */
export async function probe(session) {
  const expr = `JSON.stringify({
    url: location.pathname + location.search.slice(0, 24),
    injected: typeof window.RFID_CONTEXT !== 'undefined',
    context: window.RFID_CONTEXT || null,
    gate: window.rfidM0 ? window.rfidM0.gate : null,
    hasSerial: window.rfidM0 ? window.rfidM0.hasSerial : null,
    ports: window.rfidM0 ? window.rfidM0.ports : null,
    hint: window.rfidM0 && window.rfidM0.hint ? window.rfidM0.hint : null,
    log: window.rfidM0 ? window.rfidM0.log : null,
    legacyPoll: typeof window.rfid_poll
  })`;
  const out = await evaluate(session, expr);
  // returnByValue normally hands back the string; be forgiving if a caller passes
  // an expression that yields an object directly.
  return typeof out === 'string' ? JSON.parse(out) : out;
}

/** Read the DOM the bootstrap added, if any. */
export async function hintText(session) {
  return evaluate(session, `(document.getElementById('rfid-boot-hint')||{}).textContent || null`);
}

export async function title(session) {
  return evaluate(session, 'document.title');
}

/**
 * Log into the staff client. Credentials are NOT in this file and NOT in any
 * snippet: they are read from ~/koha-dev.env (KOHA_USER / KOHA_PASS) at call time.
 * The password never goes through browser_execute source, so it stays out of logs.
 *
 * 18.11 quirks, both of which look like a silent failed login: `#Login` is the submit
 * *input*, not the form; and the form has `<input name="submit">`, so `f.submit` is the
 * input, not the method — hence HTMLFormElement.prototype.submit.call(f).
 */
export async function login(session, { envFile = process.env.HOME + '/koha-dev.env', base = KOHA_BASE } = {}) {
	const { readFileSync } = await import('node:fs');
	const env = Object.fromEntries(
		readFileSync(envFile, 'utf8')
			.split('\n')
			.map((l) => l.replace(/^export\s+/, ''))
			.filter((l) => l.includes('='))
			.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
	);
	if (!env.KOHA_USER || !env.KOHA_PASS) throw new Error('KOHA_USER/KOHA_PASS missing from ' + envFile);

	// "Are we already in?" is answered by the absence of the login form, not by a header
	// widget: this fork's header has no #user-info, and testing for one made every
	// logged-in session look like a logged-out one — which then fell through to
	// "submit document.forms[0]" and quietly submitted the patron search box. Only
	// #loginform is ever submitted, and a page without it is treated as logged in.
	// #patronsearch is the header's patron quick-search: the staff header is rendered only
	// for a logged-in session, and this fork's header shows no "Log out" text to look for.
	const loggedIn = `!document.getElementById('loginform') && !!document.getElementById('patronsearch')`;
	await session._call('Page.navigate', { url: `${base}/mainpage.pl` });
	await new Promise((r) => setTimeout(r, 1500));
	if (await evaluate(session, loggedIn)) return 'already';

	const form = await evaluate(
		session,
		`(() => { const f = document.getElementById('loginform'); if (!f) return null;
			if (document.getElementById('userid')) { document.getElementById('userid').value = ${JSON.stringify(env.KOHA_USER)}; }
			if (document.getElementById('password')) { document.getElementById('password').value = ${JSON.stringify(env.KOHA_PASS)}; }
			// 18.11: <input name="submit"> shadows the method, so f.submit() is not a function
			HTMLFormElement.prototype.submit.call(f); return f.id; })()`,
	);
	if (!form) throw new Error('no #loginform on the page — Koha did not ask for credentials, and nothing else gets submitted');

	await new Promise((r) => setTimeout(r, 4000));
	return (await evaluate(session, loggedIn)) ? 'logged in' : 'login failed (#loginform still offered — wrong credentials or intranet auth changed)';
}
