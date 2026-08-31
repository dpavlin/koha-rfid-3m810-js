/*
 * One quiet line at the bottom of the screen: what the reader just did, without the
 * librarian having to look for it.
 *
 * Successes only. Koha renders its own failures on the page that just reloaded, in
 * context, with the patron and the title beside them; a second, blunter copy from the
 * plugin would be noise, and worse, would compete with the real message for
 * attention. Failures live in rfidM0.log and in the pill's tooltip for whoever is
 * debugging.
 *
 * It is deliberately not a dialog: a modal that must be dismissed is a modal that a
 * librarian learns to hit Enter through without reading.
 */

const BOX_ID = 'rfid-toasts';

export function toasts(win, { holdMs = 5000, max = 3, setTimeout: schedule = globalThis.setTimeout } = {}) {
	const d = win.document;
	if (!d || !d.createElement) return () => {};

	const box = () => {
		let b = d.getElementById && d.getElementById(BOX_ID);
		if (b) return b;
		b = d.createElement('div');
		b.id = BOX_ID;
		b.setAttribute('role', 'status');
		b.setAttribute('aria-live', 'polite');
		b.style.cssText =
			'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:10000;' +
			'font:13px/1.5 system-ui,sans-serif;pointer-events:none;text-align:center';
		(d.body || d.documentElement).appendChild(b);
		return b;
	};

	return (line) => {
		try {
			const b = box();
			const el = d.createElement('div');
			el.textContent = line;
			el.style.cssText =
				'display:inline-block;margin-top:4px;padding:5px 12px;border-radius:4px;' +
				'background:#0f7a0f;color:#fff;box-shadow:0 2px 6px rgba(0,0,0,.25)';
			b.insertBefore(el, b.firstChild);
			while (b.children.length > max) b.removeChild(b.lastChild);
			schedule(() => {
				if (el.parentNode) el.parentNode.removeChild(el);
			}, holdMs);
		} catch {
			/* a page we cannot paint on is not a page we should break */
		}
	};
}
