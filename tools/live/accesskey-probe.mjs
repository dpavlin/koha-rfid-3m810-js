/**
 * Does Koha's own shortcut land the cursor where the plugin agrees it landed?
 *
 * `hotkeys.mjs` (a one-liner, run once) settled the mechanism: this Koha binds no Alt+letter
 * in JavaScript — `#ret_barcode` carries accesskey="r" and `#search-form` accesskey="q", so
 * the shortcuts are browser-native. Three consequences worth having written down, all of
 * them load-bearing for the design:
 *
 *   - Alt+R works with Koha's JS broken or disabled, so the pairing cannot rot that way.
 *   - There is no Alt+W: renewal has no shortcut, it is a click on a due date. So "the
 *     cursor is in the renew box" means the librarian clicked there — fine, but do not
 *     document a shortcut that does not exist.
 *   - Alt+Q focuses the catalog search box, which is the decoy: a tag scanned with the
 *     cursor there must do nothing at all. That is the guard worth pressing a key for.
 *
 * So: press the accesskey for real (CDP — a dispatched KeyboardEvent does not activate an
 * accesskey, and that misled one earlier run), then read where the cursor is and what the
 * plugin says it would do. Both boxes are hidden until Koha's header reveals them, which is
 * why `focused` is reported: a box that refuses the cursor is not a routing bug.
 *
 *   const m = await import('/tmp/live-<newest>/accesskey-probe.mjs')
 *   return await m.run(session, k)
 */
const KEYS = ['r', 'q'];

/** Where the cursor is and what a scan would mean. Read after the keystroke lands. */
const WHERE = `(JSON.stringify((() => {
  const m0 = window.rfidM0 || {};
  const el = document.activeElement;
  return {
    landed: el ? el.id || el.tagName : null,
    tag: el ? el.tagName : null,
    visible: el && el.getClientRects ? el.getClientRects().length > 0 : null,
    ready: document.readyState,
    gate: m0.gate || null,
    intent: typeof m0.target === 'function' ? m0.target() : 'plugin not loaded',
  };
})()))`;

const ATTRS = `(JSON.stringify([...document.querySelectorAll('[accesskey]')].map((e) => ({
  key: e.getAttribute('accesskey'), id: e.id || null, visible: e.getClientRects().length > 0,
}))))`;

/**
 * A real Alt+<key>: keydown with the Alt modifier, then the character, then keyup —
 * the whole sequence a keyboard produces, because accesskey activation watches the
 * modifier-bearing keydown and Chrome ignores an event that has no text.
 */
async function pressAlt(session, k, key) {
	const vk = key.toUpperCase().charCodeAt(0);
	const base = {
		key,
		code: 'Key' + key.toUpperCase(),
		modifiers: 1,
		windowsVirtualKeyCode: vk,
		nativeVirtualKeyCode: vk,
	};
	await session._call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
	await session._call('Input.dispatchKeyEvent', { type: 'char', text: key, ...base });
	await session._call('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
	await new Promise((r) => setTimeout(r, 400)); // reveal + focus happen in the browser's own timing
	for (let i = 0; i < 16; i++) {
		if ((await k.evaluate(session, 'document.readyState')) === 'complete') break;
		await new Promise((r) => setTimeout(r, 250)); // a navigation would read as 'plugin not loaded'
	}
}

//** JSON or object: returnByValue gives an object, some paths give the string. */
function read(value) {
	return typeof value === 'string' ? JSON.parse(value) : value;
}

export async function run(session, k) {
	await k.open(session, k.url('mainpage.pl', {}));
	await k.login(session);
	const out = { pages: [] };
	for (const [page, params] of [
		['mainpage.pl', {}],
		['circ/circulation.pl', { borrowernumber: 606 }],
		['circ/returns.pl', {}],
	]) {
		await k.open(session, k.url(page, params));
		const page_out = { page, accesskeys: read(await k.evaluate(session, ATTRS)), presses: [] };
		for (const key of KEYS) {
			await pressAlt(session, k, key);
			// Spreading the unparsed JSON string yields a char-indexed object — every field of
			// the row reads undefined and the row looks like the plugin said nothing.
			page_out.presses.push({ alt: key, ...read(await k.evaluate(session, WHERE)) });
		}
		out.pages.push(page_out);
	}
	return out;
}
