/*
 * Dump everything the plugin knows, as JSON, from the shell.
 *
 *   node tools/live/state.mjs > state.json
 *
 * No flags. It finds Chrome's DevTools endpoint (9222, then 9333), takes the first Koha tab it
 * finds, and prints what that tab holds. Which is exactly the honest limit of the tool: the
 * interesting state lives in a page's window and dies with it, so a dump is a snapshot of a tab
 * at a moment. Nothing navigates, logs in, clicks or writes a tag.
 *
 * What "history" exists, and where the dump reads it from:
 *
 *   m0.log        every step and wire frame this page performed — the closest thing to a log
 *   m0.programs   tag writes this page made. Memory only: reload and it is gone, which is the
 *                 whole reason the Koha-side audit row was wanted (blocked on 19.11, PLAN §6)
 *   sessionStorage rfid_posted — which barcodes were already transacted, so a reload does not
 *                 post the same book twice (survives navigation in the tab, not a new tab)
 *   localStorage   rfid_armed (this browser was enrolled), rfid_keepwatching (poll when hidden)
 *
 * That is all of it. There is no server-side history: the row would have been the audit, and is
 * the deferred item in PLAN §6.
 */
import { pathToFileURL } from 'node:url';

export const PROBE = `(() => {
  const seen = new WeakSet();
  const json = (v) => JSON.parse(JSON.stringify(v, (k, val) => {
    if (typeof val === 'function') return '[function]';
    if (typeof Node !== 'undefined' && val instanceof Node) return '[DOM ' + val.nodeName + ']';
    if (val && typeof val === 'object') { if (seen.has(val)) return '[circular]'; seen.add(val); }
    return val === undefined ? '[undefined]' : val;
  }));
  const store = (s) => { const o = {}; try { for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); } } catch (e) { o['[error]'] = String(e); } return o; };
  const text = (sel) => { const el = document.querySelector(sel); return el ? (el.textContent || '').trim() : null; };
  const a = document.activeElement;
  const params = {}; new URLSearchParams(location.search).forEach((v, k) => params[k] = v);
  const m0 = window.rfidM0;
  const log = (m0 && m0.log) || [];
  // m0.log is one entry per poll and per frame: a page left open all morning is tens of
  // thousands of lines, which is 600 KB of dump and buries everything else in it. The tail is
  // what matters (what just happened), so the tail is what ships, and the count of what was
  // dropped is printed rather than quietly lost.
  const TAIL = 200;
  const rest = {}; if (m0) for (const k of Object.keys(m0)) if (k !== 'log') rest[k] = m0[k];
  return JSON.stringify({
    page: {
      href: location.href,
      title: document.title.trim(),
      referrer: document.referrer || null,
      params,
      focus: a ? a.tagName + (a.id ? '#' + a.id : '') + (a.name ? '[' + a.name + ']' : '') : null,
    },
    koha: {
      barcodeFields: [...document.querySelectorAll('input[name=barcode], input#barcode')].map((f) => ({
        id: f.id || null, value: f.value || null, visible: f.getClientRects().length > 0,
        form: f.form ? (f.form.getAttribute('action') || '').split('/').pop() : null,
      })),
      // Ids from src/core/boot.js (HINT_ID) and src/core/panel.js (PANEL_ID) — the dump has to
      // use the real ones, or it reports "null" for UI that is plainly on the screen.
      pill: text('#rfid-boot-hint'),
      panel: text('#rfid-program'),
      // The 2012 patch: notices the plugin hides while its panel is live, and the placement
      // photo that is supposed to survive them.
      dialogs2012: [...document.querySelectorAll('div.dialog.message')].map((n) => ({
        mentionsF4: /F4/.test(n.textContent || ''),
        visible: n.getClientRects().length > 0,
        text: (n.textContent || '').trim().slice(0, 120),
      })),
    },
    server: { RFID_CONTEXT: window.RFID_CONTEXT || null, RFID_CONFIG: window.RFID_CONFIG || null, RFID_ITEM: window.RFID_ITEM || null },
    plugin: m0 ? json(rest) : null,
    // `total` is what the page saw, not what it still holds: m0.log is a ring (logLines), and
    // a tab that dropped 8,000 lines must not look like a tab that only ever wrote 200.
    log: {
      total: log.length + ((m0 && m0.logDropped) || 0),
      droppedByRing: (m0 && m0.logDropped) || 0,
      droppedByDump: Math.max(0, log.length - TAIL),
      shown: Math.min(log.length, TAIL),
      lines: json(log.slice(-TAIL)),
    },
    storage: { localStorage: store(localStorage), sessionStorage: store(sessionStorage) },
  }, null, 1);
})()`;

const CDP = ['http://127.0.0.1:9222', 'http://127.0.0.1:9333'];

async function endpoint() {
	for (const base of CDP) {
		try {
			if ((await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(1500) })).ok) return base;
		} catch {
			/* next */
		}
	}
	throw new Error(
		`no Chrome DevTools endpoint at ${CDP.join(' or ')} — start Chrome with --remote-debugging-port=9222`,
	);
}

async function evaluate(wsUrl, expression) {
	const ws = await new Promise((res, rej) => {
		const s = new WebSocket(wsUrl);
		s.addEventListener('open', () => res(s), { once: true });
		s.addEventListener(
			'error',
			(e) => rej(new Error(`cannot attach to the tab: ${e.message || 'websocket error'}`)),
			{ once: true },
		);
	});
	try {
		return await new Promise((res, rej) => {
			const timer = setTimeout(
				() => rej(new Error('the tab did not answer in 10s — is it still loading?')),
				10000,
			);
			ws.addEventListener('message', (ev) => {
				const m = JSON.parse(ev.data);
				if (m.id !== 1) return;
				if (m.error) return rej(new Error(`Runtime.evaluate: ${m.error.message}`));
				// Chrome answers an evaluate with an empty {result:{}} frame now and then, and an
				// id match is not a response: resolving on it produced "undefined is not valid
				// JSON" from a page that was answering perfectly well. Wait for a value.
				const r = m.result && m.result.result;
				if (!r) return;
				clearTimeout(timer);
				if (m.result.exceptionDetails) {
					const d = m.result.exceptionDetails;
					return rej(
						new Error(`the page would not answer: ${(d.exception && d.exception.description) || d.text}`),
					);
				}
				if (r.type === 'undefined')
					return rej(new Error('the page returned nothing (navigating? open a Koha page and try again)'));
				res(r.value);
			});
			ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
		});
	} finally {
		ws.close();
	}
}

export async function main() {
	const base = await endpoint();
	const tabs = (await (await fetch(`${base}/json/list`)).json()).filter(
		(t) => t.type === 'page' && /\/koha\//.test(t.url),
	);
	if (!tabs.length) throw new Error(`no Koha tab open at ${base} — open a Koha page in that Chrome`);
	if (tabs.length > 1) {
		process.stderr.write(
			`# ${tabs.length} Koha tabs; dumping the first:\n${tabs.map((t) => `#   ${t.url}\n`).join('')}`,
		);
	}
	process.stderr.write(`# ${tabs[0].url}\n`);
	const json = await evaluate(tabs[0].webSocketDebuggerUrl, PROBE);
	process.stdout.write(JSON.stringify(JSON.parse(json), null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((e) => {
		process.stderr.write(`state: ${e.message}\n`);
		process.exit(2);
	});
}
