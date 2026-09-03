/*
 * Does the plugin agree with a librarian about what the focused box means?
 *
 * Read-only: it focuses fields and reads `m0.target()`. It never calls `m0.act()`, never
 * posts, never writes a tag — a scan is a transaction, and this tool runs on a real catalogue.
 *
 * For each circulation page, for every field a scan could land in: what the plugin says it
 * would do (the transaction word, the state the tag would be written to, whether it posts).
 * The interesting rows are the ones where the plugin and Koha disagree — a box it claims to
 * fill that is actually a search box, or a check-in box it cannot see.
 *
 * Also reads the pill: what a librarian sees standing at the desk, and whether it sits where
 * Koha's own page furniture is.
 *
 *   run via browser_execute; see tools/live/README.md
 */
const BOXES = `['#barcode', '#ret_barcode', '#ren_barcode', '#findborrower', '#search-form', 'input[name=barcode]']`;

const PROBE = `(new Promise((res) => setTimeout(() => {
  const m0 = window.rfidM0 || {};
  const seen = [];
  const rows = [];
  for (const sel of ${BOXES}) {
    for (const el of document.querySelectorAll(sel)) {
      if (seen.includes(el)) continue;
      seen.push(el);
      if (el.type === 'hidden') continue;
      el.focus();
      const f = el.closest('form');
      rows.push({
        selector: sel,
        id: el.id || null,
        inHeader: !!el.closest('#header_search'),
        disabled: !!el.disabled,
        posts: f ? (f.getAttribute('action') || '(none)').split('/').pop().split('?')[0] : null,
        // The claim under test: this is what the plugin would do with a scanned tag now.
        intent: typeof m0.target === 'function' ? m0.target() : 'plugin not loaded',
      });
    }
  }
  const pill = document.getElementById('rfid-boot-hint');
  const box = pill ? pill.getBoundingClientRect() : null;
  res(JSON.stringify({
    path: location.pathname.split('/koha/').pop() + location.search.slice(0, 20),
    gate: m0.gate || 'never',
    // No nested template literals in here: a backtick inside PROBE closes PROBE.
    pad: (m0.tags || []).map((t) => t.content + ' ' + (t.security || '??')),
    posted: typeof m0.posted === 'function' ? m0.posted() : null,
    pill: pill ? {
      text: pill.innerText.replace(/\\s+/g, ' ').trim(),
      title: pill.title,
      // Bottom-right, out of the way of the forms and of Koha's own corner widgets.
      corner: box && { top: Math.round(window.innerHeight - box.bottom), left: Math.round(window.innerWidth - box.right) },
      covers: box ? [...document.querySelectorAll('input,button,a')]
        .filter((e) => { const r = e.getBoundingClientRect(); return r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom; })
        .map((e) => e.id || e.name || e.tagName).slice(0, 4) : null,
    } : null,
    rows,
  }, null, 1));
}, 600)))`;

export async function run(session, k) {
	await k.open(session, k.url('mainpage.pl', {}));
	const login = await k.login(session);
	const out = { login, pages: [] };
	for (const [page, params] of [
		['circ/returns.pl', {}],
		['circ/circulation.pl', { borrowernumber: 606 }],
		['circ/renew.pl', { borrowernumber: 606 }],
		['mainpage.pl', {}],
	]) {
		await k.open(session, k.url(page, params));
		out.pages.push(JSON.parse(await k.evaluate(session, PROBE)));
	}
	return out;
}
