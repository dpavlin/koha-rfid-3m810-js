/*
 * Dump what the plugin wrote to tags this session, as CSV.
 *
 * This is the replacement for a CSV button in the panel. `m0.programs` is a browser-side
 * buffer (the audit row Koha would have held is blocked on Koha 19.11, PLAN §6), and the only
 * reason to export it is testing: after a run of programming against real tags, put the writes
 * next to what the catalogue and the pad say. A UI affordance for that would be permanent
 * furniture around a testing need — the file's only consumer is whoever just ran the test.
 *
 * USAGE — from a shell, against the Chrome that has the reader:
 *
 *   node tools/live/write-log.mjs                       # report on stderr, no CSV yet
 *   node tools/live/write-log.mjs > writes.csv          # CSV on stdout, report on stderr
 *   node tools/live/write-log.mjs --quiet > writes.csv  # CSV only, for piping
 *   node tools/live/write-log.mjs --cdp http://127.0.0.1:9333
 *   node tools/live/write-log.mjs --tab renew           # choose among several Koha tabs
 *
 * Chrome must have been started with --remote-debugging-port (9222 and 9333 are probed; ffzg's
 * desk profile uses 9333). That port is an unauthenticated driver for the whole browser: local
 * only, and never opened to a network for the convenience of a log dump.
 *
 * USAGE — from browser_execute, where the session is already connected:
 *
 *   const w = await import(RUN + '/write-log.mjs');
 *   return (await w.run(session, k)).report;
 *
 * Read-only either way: never clicks, never posts, never writes a tag, never navigates, never
 * logs in. Two rules, both because the data lives in a page's window:
 *
 *   1. NAVIGATING DESTROYS THE EVIDENCE. Attaching must not call Page.navigate, or the tool
 *      erases the buffer it came to read and prints a clean empty CSV over the grave.
 *   2. A LOGGED-OUT TAB HAS NOTHING TO DUMP. Saying so and stopping is the honest output; a
 *      tool that logs in to make its dump succeed is a tool that reports success it did not get.
 *
 * So: program the tag, then dump — in that tab, before navigating away or logging out.
 */
import { pathToFileURL } from 'node:url';

export const PROBE = `(() => {
  const m0 = window.rfidM0 || {};
  const vis = (el) => !!el && el.getClientRects().length > 0;
  // The 2012 patch's notices, and the placement photo that has to survive hiding them.
  const dialogs = [...document.querySelectorAll('div.dialog.message')];
  const f4 = dialogs.filter((n) => /F4/i.test(n.textContent || ''));
  const imgs = [...document.querySelectorAll('img')].filter((i) => /rfid/i.test(i.getAttribute('src') || '') || /rfid/i.test(i.alt || ''));
  const a = document.activeElement;
  return JSON.stringify({
    path: location.pathname.split('/koha/').pop() + location.search.slice(0, 40),
    plugin: !!window.rfidM0,
    // Koha's staff login form. If this is what the tab shows, the write log went with the page
    // it lived on, and no amount of trying here produces it.
    loginPage: !!document.querySelector('input#userid, div#auth'),
    version: m0.version || '(no plugin on this page)',
    gate: m0.gate || 'never',
    // There is no m0.connected; a reader is open exactly when the gate says ready and the watch
    // is running. Printing "connected: false" would be the tool lying about the thing it checks.
    watching: !!m0.watching,
    // F4 is refused while the cursor is in a field — correct behaviour, and completely opaque
    // from outside, so the dump says where the cursor is. Koha focuses a search box on load.
    focus: a ? a.tagName + (a.id ? '#' + a.id : '') + (a.name ? '[' + a.name + ']' : '') : '(none)',
    lastAction: m0.lastAction || null,
    item: window.RFID_ITEM || null,
    pad: (m0.tags || []).map((t) => ({ sid: t.sid, content: t.content, security: t.security })),
    programs: (m0.programs || []).map((p) => ({
      at: p.at,
      sid: p.sid,
      from: p.from,
      to: p.to,
      afi: p.afi,
      verified: p.verified,
      error: p.error,
    })),
    logLines: (m0.log || []).length,
    notices: {
      total: dialogs.length,
      mentioningF4: f4.length,
      stillVisible: f4.filter(vis).length,
      // A photo showing where to hold the tag is worth keeping; a notice telling you to press a
      // key the plugin no longer uses is not.
      rfidImages: imgs.map((i) => ({ src: (i.getAttribute('src') || '').split('/').pop(), visible: vis(i) })),
    },
  });
})()`;

const iso = (ms) => (ms ? new Date(ms).toISOString() : '');
const cell = (v) => {
	const s = v === null || v === undefined ? '' : String(v);
	return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function csv(programs) {
	const head = ['iso', 'epoch_ms', 'sid', 'barcode_before', 'barcode_after', 'afi', 'verified', 'error'];
	const rows = programs.map((p) =>
		[iso(p.at), p.at || '', p.sid, p.from, p.to, p.afi, p.verified ? 'yes' : 'NO', p.error].map(cell).join(','),
	);
	return [head.join(','), ...rows].join('\n');
}

/**
 * Everything the tool knows, as text — returned, not only printed, because an imported module
 * does not share the caller's console (browser_execute captures the snippet's), and a tool that
 * is silent exactly where it is being watched is not a tool.
 */
export function report(o, tabUrl) {
	const L = [];
	const where = [`# page: ${o.path}`];
	if (tabUrl) where.push(`tab ${tabUrl.replace(/https:\/\/[^/]+/, '')}`);
	where.push(`gate ${o.gate}`, `watching ${o.watching ? 'yes' : 'no'}`, `cursor ${o.focus}`);
	L.push(where.join(' | '));
	if (!o.plugin) {
		// The honest output. Logging in, reloading or navigating to "fix" the tab would destroy
		// the thing being dumped and print a clean empty CSV afterwards.
		L.push(
			o.loginPage
				? '# nothing to dump: this tab is at the staff login page. The write log lived in the page that just reloaded — log in, program a tag, and dump it before navigating away or logging out.'
				: '# nothing to dump: the plugin is not running on this tab (not an enrolled page, no Web Serial, or the gate is off).',
		);
		return L.join('\n');
	}
	L.push(
		`# item: ${o.item ? `${o.item.itemnumber} ${o.item.barcode}${o.item.onloan ? ' ONLOAN' : ''}` : '(none — not an item page)'} | plugin ${o.version}`,
	);
	L.push(`# pad: ${o.pad.length ? o.pad.map((t) => `${t.content || '(blank)'} ${t.security} ${t.sid}`).join(' ; ') : '(nothing)'}`);
	if (o.lastAction) L.push(`# last transaction action: ${o.lastAction}`);
	if (o.notices.mentioningF4) {
		L.push(`# 2012 notices: ${o.notices.mentioningF4} found, ${o.notices.stillVisible} still visible | plugin log ${o.logLines} lines`);
	}
	if (o.notices.rfidImages.length) L.push(`# placement photos: ${JSON.stringify(o.notices.rfidImages)}`);
	if (!o.programs.length) {
		L.push('# no tag writes in this tab — program one (F4 on an item page, cursor out of any field) and dump again');
		return L.join('\n');
	}
	L.push(csv(o.programs));
	const bad = o.programs.filter((p) => !p.verified || p.error);
	L.push(
		`# ${o.programs.length} write(s), ${bad.length} failed or unread back${bad.length ? ': ' + bad.map((p) => `${p.to}(${p.error || 'not verified'})`).join(', ') : ''}`,
	);
	return L.join('\n');
}

// --- the part that only exists because the data lives inside a page -------------------------

const CDP_DEFAULTS = ['http://127.0.0.1:9222', 'http://127.0.0.1:9333'];

async function endpoint(cdp) {
	const list = cdp ? [cdp] : CDP_DEFAULTS;
	for (const base of list) {
		try {
			const r = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(1500) });
			if (r.ok) return base;
		} catch {
			/* next candidate */
		}
	}
	throw new Error(
		`no Chrome DevTools endpoint at ${list.join(' or ')}. Start Chrome with --remote-debugging-port=9222, or pass --cdp http://host:port.`,
	);
}

async function kohaTabs(base) {
	const r = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(3000) });
	if (!r.ok) throw new Error(`${base}/json/list answered ${r.status}`);
	return (await r.json()).filter((t) => t.type === 'page' && /\/koha\//.test(t.url));
}

/** One Runtime.evaluate over a fresh WebSocket, then hang up. No Page.navigate, ever. */
async function evaluate(wsUrl, expression) {
	const ws = await new Promise((res, rej) => {
		const s = new WebSocket(wsUrl);
		s.addEventListener('open', () => res(s), { once: true });
		s.addEventListener('error', (e) => rej(new Error(`cannot attach to the tab: ${e.message || 'websocket error'}`)), { once: true });
	});
	let seq = 0;
	const send = (method, params) =>
		new Promise((res, rej) => {
			const id = ++seq;
			const onMsg = (ev) => {
				const m = JSON.parse(ev.data);
				if (m.id !== id) return;
				ws.removeEventListener('message', onMsg);
				m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result);
			};
			ws.addEventListener('message', onMsg);
			ws.send(JSON.stringify({ id, method, params }));
		});
	try {
		const r = await send('Runtime.evaluate', { expression, returnByValue: true });
		if (r.exceptionDetails) {
			const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
			throw new Error(`the page would not answer: ${d}`);
		}
		return r.result.value;
	} finally {
		ws.close();
	}
}

/** Standalone entry: CDP by hand, report to stderr, CSV to stdout, so `> writes.csv` works. */
export async function main(argv = process.argv.slice(2)) {
	const flag = (name, dflt) => {
		const i = argv.indexOf(`--${name}`);
		return i >= 0 ? argv[i + 1] : dflt;
	};
	const base = await endpoint(flag('cdp'));
	const tabs = await kohaTabs(base);
	if (!tabs.length) throw new Error(`no Koha tab open at ${base} — open a Koha page in that Chrome first`);
	const want = flag('tab');
	const tab =
		(want && tabs.find((t) => t.url.includes(want))) ||
		tabs.find((t) => /moredetail\.pl/.test(t.url)) ||
		tabs[0];
	if (want && tabs.find((t) => t.url.includes(want)) === undefined) {
		throw new Error(`no Koha tab matching "${want}"; open one of:\n  ${tabs.map((t) => t.url).join('\n  ')}`);
	}
	if (tabs.length > 1) {
		process.stderr.write(`# ${tabs.length} Koha tabs, reading "${tab.url}" — pick another with --tab <substring>\n`);
	}
	const o = JSON.parse(await evaluate(tab.webSocketDebuggerUrl, PROBE));
	process.stderr.write(report(o, tab.url) + '\n');
	if (o.plugin && o.programs.length) process.stdout.write(csv(o.programs) + '\n');
	// Exit status is about whether the dump happened, not whether there was anything in it:
	// "read the tab, it holds no writes" is a successful, useful answer.
	return o.plugin ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().then(
		(code) => process.exit(code),
		(e) => {
			process.stderr.write(`write-log: ${e.message}\n`);
			process.exit(2);
		},
	);
}
