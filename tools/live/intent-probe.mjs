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
      // Focus is what the plugin reads, so focus is what has to be checked: several of
      // these boxes sit in collapsed panels and refuse focus, and reporting the intent of
      // whatever kept the cursor makes an unreachable box look like a wrong one.
      el.focus();
      const focused = document.activeElement === el;
      const f = el.closest('form');
      rows.push({
        selector: sel,
        id: el.id || null,
        inHeader: !!el.closest('#header_search'),
        disabled: !!el.disabled,
        // Why focus can fail: 'false' here means the box is painted out of existence
        // (a collapsed panel), so a scan can never mean it and there is nothing to check.
        visible: el.getClientRects().length > 0,
        focused,
        posts: f ? (f.getAttribute('action') || '(none)').split('/').pop().split('?')[0] : null,
        // The claim under test, and only where the cursor actually is: what the plugin
        // would do with a scanned tag right now.
        intent: focused && typeof m0.target === 'function' ? m0.target() : 'plugin not loaded',
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

/** Where the cursor is, and what a scan would do with it. Read after a keystroke lands. */
const WHERE = `(JSON.stringify((() => {
  const m0 = window.rfidM0 || {};
  const el = document.activeElement;
  return {
    landed: el ? el.id || el.tagName : null,
    tag: el ? el.tagName : null,
    visible: el && el.getClientRects ? el.getClientRects().length > 0 : null,
    // 'plugin not loaded' here means one of two very different things unless readyState is
    // read with it: the page is still arriving, or the page has no plugin.
    ready: document.readyState,
    gate: m0.gate || null,
    intent: typeof m0.target === 'function' ? m0.target() : 'plugin not loaded',
  };
})()))`;

/**
 * A real Alt+<key> through the browser's input pipeline (CDP), not a dispatched event:
 * Koha's shortcut handler reads keyCode/which, which a synthetic KeyboardEvent leaves at 0,
 * so a fake event tests nothing about whether the shortcut works.
 */
async function pressAlt(session, k, key) {
	const code = key.toUpperCase();
	const vk = code.charCodeAt(0);
	for (const type of ['rawKeyDown', 'keyUp']) {
		await session._call('Input.dispatchKeyEvent', {
			type,
			key,
			code: 'Key' + code,
			modifiers: 1, // Alt
			windowsVirtualKeyCode: vk,
			nativeVirtualKeyCode: vk,
		});
	}
	await new Promise((r) => setTimeout(r, 250)); // Koha focuses from the handler; let it land
	// If the shortcut navigated, reading now reports 'plugin not loaded' for a page that has
	// the plugin — wait for the document to arrive before asking it anything.
	for (let i = 0; i < 16; i++) {
		if ((await k.evaluate(session, 'document.readyState')) === 'complete') break;
		await new Promise((r) => setTimeout(r, 250));
	}
}

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
		const result = JSON.parse(await k.evaluate(session, PROBE));
		// Koha's own shortcuts, fired for real, and then: where did the cursor land, and does
		// the plugin read that as the transaction the shortcut means? Alt+R check-in, Alt+W
		// renew, Alt+U patron (staff-global.js). The design rests on this pairing: a librarian
		// using Koha's shortcut must not have to know the plugin exists — and must not need
		// Ctrl+Alt+R, which is the plugin's own key only because it cannot borrow Koha's.
		result.shortcuts = [];
		for (const key of ['r', 'w', 'u']) {
			await pressAlt(session, k, key);
			// k.evaluate hands back the string; spreading it without parsing yields a
			// char-indexed object and every field of the row becomes '0': '{', '1': '"'.
			result.shortcuts.push({ key, ...JSON.parse(await k.evaluate(session, WHERE)) });
		}
		out.pages.push(result);
	}
	return out;
}
