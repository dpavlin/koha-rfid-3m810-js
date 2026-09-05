/*
 * Dump what the plugin wrote to tags this session, as CSV.
 *
 * This is the replacement for a CSV button in the panel. `m0.programs` is a browser-side
 * buffer (the audit row Koha would have held is blocked on Koha 19.11, PLAN §6), and the only
 * reason to export it is testing: after a run of programming against real tags, put the writes
 * next to what the catalogue and the pad say. A UI affordance for that would be something
 * librarians have to ignore forever to get a file nobody at a desk opens.
 *
 * Read-only: it never clicks, never posts, never writes a tag.
 *
 *   run via browser_execute; see tools/live/README.md
 */
const PROBE = `(() => {
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
    // Koha's staff login form. If this is what the tab is showing, the write log is gone with
    // the page it lived on, and no amount of trying here produces it.
    loginPage: !!document.querySelector('input#userid, div#auth'),
    version: m0.version || '(no plugin on this page)',
    gate: m0.gate || 'never',
    // There is no m0.connected; a reader is open exactly when the gate says ready and the watch
    // is running. Saying "connected: false" would be the tool lying about the thing it inspects.
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
		// The tool reads a buffer that only exists on a live plugin page. Saying so and stopping
		// is the whole honesty of it: logging in, reloading, or navigating to "fix" the tab would
		// destroy the thing being dumped and print a clean empty CSV over the grave.
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
	L.push(
		`# pad: ${o.pad.length ? o.pad.map((t) => `${t.content || '(blank)'} ${t.security} ${t.sid}`).join(' ; ') : '(nothing)'}`,
	);
	if (o.lastAction) L.push(`# last transaction action: ${o.lastAction}`);
	if (o.notices.mentioningF4) {
		L.push(
			`# 2012 notices: ${o.notices.mentioningF4} found, ${o.notices.stillVisible} still visible | plugin log ${o.logLines} lines`,
		);
	}
	if (o.notices.rfidImages.length) L.push(`# placement photos: ${JSON.stringify(o.notices.rfidImages)}`);
	if (!o.programs.length) {
		L.push(
			'# no tag writes in this tab — program one (F4 on an item page, cursor out of any field) and dump again',
		);
		return L.join('\n');
	}
	L.push(csv(o.programs));
	const bad = o.programs.filter((p) => !p.verified || p.error);
	L.push(
		`# ${o.programs.length} write(s), ${bad.length} failed or unread back${bad.length ? ': ' + bad.map((p) => `${p.to}(${p.error || 'not verified'})`).join(', ') : ''}`,
	);
	return L.join('\n');
}

/**
 * Attach to the tab that already has the plugin running — without navigating it.
 *
 * This is the whole tool. k.open() attaches by calling Page.navigate, and the write log is a
 * plain array on that page's window: navigating in order to dump it is a tool that erases its
 * own evidence and then reports an empty CSV. So attach by target id and read the buffer as is.
 */
async function attach(session, k) {
	const all = await k.pages(session);
	if (!all.length) throw new Error('no tabs open — open a Koha page in the enrolled Chrome');
	const t = all.find((p) => /moredetail\.pl/.test(p.url)) || all.find((p) => /\/koha\//.test(p.url));
	if (!t) throw new Error(`no Koha tab open; tabs: ${all.map((p) => p.url).join(', ') || '(none)'}`);
	await session.use(t.targetId);
	await session._call('Page.enable');
	return t;
}

export async function run(session, k, { settleMs = 400 } = {}) {
	const target = await attach(session, k);
	await new Promise((r) => setTimeout(r, settleMs));
	const o = JSON.parse(await k.evaluate(session, PROBE));
	const text = report(o, target.url);
	console.log(text);
	return { ...o, ok: o.plugin && o.programs.length > 0, report: text, csv: o.programs.length ? csv(o.programs) : '' };
}
