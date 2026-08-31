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

const KOHA_BASE = 'https://ffzg.koha-dev.rot13.org:8443/cgi-bin/koha';

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

export async function evaluate(session, expression) {
  const res = await session._call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || 'eval threw: ' + expression.slice(0, 60));
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

	await session._call('Page.navigate', { url: `${base}/mainpage.pl` });
	await new Promise((r) => setTimeout(r, 1500));
	const already = await evaluate(session, `!!document.querySelector('#user-info')`);
	if (already) return 'already';

	const form = await evaluate(session, `(() => { const f = document.getElementById('loginform') || document.forms[0]; if (!f) return null;
		if (document.getElementById('userid')) { document.getElementById('userid').value = ${JSON.stringify(env.KOHA_USER)}; }
		if (document.getElementById('password')) { document.getElementById('password').value = ${JSON.stringify(env.KOHA_PASS)}; }
		HTMLFormElement.prototype.submit.call(f); return f.id || 'forms[0]'; })()`);
	if (!form) throw new Error('no login form on the page — Koha did not ask for credentials');

	await new Promise((r) => setTimeout(r, 4000));
	const ok = await evaluate(session, `!!document.querySelector('#user-info')`);
	return ok ? 'logged in' : 'login failed (form "' + form + '" submitted, no #user-info afterwards)';
}
