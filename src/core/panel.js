/*
 * The programming panel, on catalogue/moredetail.pl only.
 *
 * The guard (`core/tagwrite.js`) is what makes a wrong write hard; this is what makes a
 * wrong write visible while there is still time to stop. It has exactly one job: put the
 * barcode the page is for next to the barcode the tag holds, and refuse to act until a
 * person has seen both. Everything else — the write, the read-back, the refusal if the tag
 * holds something else — already happens below it, and would happen the same way if this
 * panel did not exist.
 *
 * Two rules the panel does not bend:
 *
 *   - **It only ever writes the page's barcode.** No text field, no typing, so what can be
 *     written is exactly one thing, and what that thing is gets printed in the button.
 *     A free-text box here would be a way to write a barcode no page has ever seen.
 *   - **Overwriting a different barcode needs the tag lifted and put back.** The guard
 *     insists the caller knows the old value; only the pad can say whether anybody looked
 *     at the tag. So the confirm is not a click, it is a physical act: the sid leaves the
 *     inventory and comes back, and the write goes with the confirmation it earned.
 *
 * It appears only when the installation has `programming` on, the page resolved an item,
 * and the reader is connected — a librarian with none of those three sees no panel, and
 * the page keeps the (still dead) "Press F4" notices it has always had, because taking
 * away a familiar signpost is only right when something better stands behind it.
 */

import { stateOf } from './intent.js';

const PANEL_ID = 'rfid-program';

const BOX =
	'margin:0 0 12px 0;padding:8px 10px;border:1px solid #b9c6d8;border-left:4px solid #4a6fa5;' +
	'background:#f7fafd;font-size:13px;line-height:1.5';
const ROW = 'margin:2px 0';
const BUTTON = 'margin:6px 6px 0 0;padding:3px 10px;font-size:13px';
const OK = 'color:#0c6b0c';
const WARN = 'color:#8a5300';
const BAD = 'color:#a11111';

// `css` defaults to a plain row because nearly every line in the panel is one. The style
// used to be an argument callers remembered to pass as the third of four, and several calls
// passed it in the `tag` slot instead — which a browser answers with InvalidCharacterError
// and the fake DOM, until it was hardened, answered with an element named "margin:2px 0".
const text = (d, what, css = ROW, tag = 'div') => {
	const el = d.createElement(tag);
	el.textContent = what;
	el.style.cssText = css;
	return el;
};

/**
 * Install the panel. Returns null when this page should not have one, so the caller can
 * stay in one line, and an object with `render`/`destroy`/`armed` for the tests and the
 * console.
 */
export function installPanel({ win, m0, cfg = {}, note = () => {} } = {}) {
	const d = win.document;
	if (!d || d.getElementById(PANEL_ID)) return null;
	if (cfg.programming !== true) return null; // the capability is the installation's, not ours

	const item = win.RFID_ITEM || null;
	const host = d.getElementById('catalogue_detail_biblio') || d.body || d.documentElement;
	if (!host) return null;

	const el = d.createElement('div');
	el.id = PANEL_ID;
	el.style.cssText = BOX;
	host.appendChild(el);

	// The "Press F4" notices are a 2012 leftover: the client that listened for F4 polled a
	// local server and is gone, and nothing here binds the key yet. They are hidden only
	// once the panel that replaces them is actually on the page.
	const hideDeadNotices = () => {
		for (const n of d.querySelectorAll('div.dialog.message')) {
			if (/F4/.test(n.textContent || '')) n.style.display = 'none';
		}
	};

	// The confirm: armed by a press, earned by taking the tag off the pad and putting it
	// back. `lifted` is set when the pad stops reporting that sid, which is the only evidence
	// anybody has that the tag was actually looked at. `movedOn` is the other half: if some
	// *other* tag arrives in its place, the librarian has moved on, and the confirm they armed
	// for one book must not be spent on another.
	let armed = null;
	let last = null;

	const pad = () => m0.tags || [];
	const connected = () => m0.gate === 'ready';

	const disarm = () => {
		if (armed) note('programming not confirmed', `tag ${armed.sid} was not lifted and re-presented`);
		armed = null;
	};

	const track = () => {
		if (!armed) return;
		const now = pad().map((t) => String(t.sid).toLowerCase());
		if (now.includes(armed.sid)) return; // still there, or back again: nothing to note
		armed.lifted = true;
		if (now.length) armed.movedOn = true;
	};

	const write = async () => {
		if (!item) return;
		// Every way the panel can be asked and cannot answer says so in the box. A keystroke
		// that silently does nothing is how people conclude the reader is broken.
		if (!item.ok) {
			last = { error: `this page cannot program: ${item.why}` };
			return render();
		}
		if (!connected()) {
			last = { error: 'no reader connected — Ctrl+Alt+R' };
			return render();
		}
		const tags = pad();
		if (!tags.length) {
			last = { error: 'no tag on the pad' };
			return render();
		}
		const tag = tags[0];
		if (tags.length > 1) {
			last = { error: `${tags.length} tags on the pad — one at a time, please` };
			return render();
		}

		const from = tag.content || '';
		// A tag with nothing on it is not somebody's item, so writing it is not a change and
		// asks for nothing — the guard agrees (isBlank in tagwrite.js), and the panel has to or
		// the two disagree about what needs confirming. The /^0+$/ is 501-speak for "never
		// written", which some tags report rather than an empty string.
		const blank = !from || /^0+$/.test(from);
		const same = !blank && from === item.barcode;
		if (!same && !blank && !armed) {
			armed = { sid: String(tag.sid).toLowerCase(), from, to: item.barcode, lifted: false };
			note('confirm required', `overwriting "${from}" with "${item.barcode}"`);
			last = { error: `lift the tag off the pad and put it back to overwrite "${from}"` };
			return render();
		}
		if (!same && !blank && armed.movedOn) {
			disarm();
			last = { error: 'a different tag is under the head — start again' };
			return render();
		}
		if (!same && !blank && !armed.lifted) {
			last = { error: 'the tag has not left the pad yet — lift it off and put it back' };
			return render();
		}

		const entry = await m0.program(tag.sid, item.barcode, same || blank ? {} : { confirm: armed.from });
		armed = null;
		last = entry.error ? { error: entry.error } : { ok: entry };
		render();
	};

	const read = async () => {
		const tag = pad()[0];
		if (!tag) return;
		const t = await m0.readTag(tag.sid);
		last = t && t.error ? { error: t.error } : { read: t };
		render();
	};

	// One guarded path from "asked to write" to "wrote", for the button and the key alike:
	// a failing read of a real reader arrives as a rejected promise, and an unhandled one
	// leaves the panel showing yesterday's state.
	const run = () =>
		write().catch((e) => {
			last = { error: `programming failed: ${(e && e.message) || e}` };
			render();
		});

	const button = (label, onClick, enabled = true, id = '') => {
		const b = d.createElement('button');
		b.textContent = label;
		if (id) b.id = id;
		b.style.cssText = BUTTON;
		b.disabled = !enabled;
		b.addEventListener('click', (ev) => {
			if (ev && ev.preventDefault) ev.preventDefault();
			onClick();
		});
		return b;
	};

	const render = () =>
		safe(d, el, () => {
			track();
			el.textContent = '';
			el.appendChild(text(d, 'RFID tag', 'font-weight:bold;margin:0 0 4px 0'));

			if (!item) {
				el.appendChild(text(d, 'this page did not say which item it is, so there is nothing to write', WARN));
				return;
			}
			if (!item.ok) {
				el.appendChild(text(d, `cannot program from this page: ${item.why}`, WARN));
				return;
			}

			el.appendChild(
				text(
					d,
					`item ${item.itemnumber} — barcode ${item.barcode}${item.callnumber ? `, ${item.callnumber}` : ''}`,
				),
			);

			const tags = pad();
			if (!connected()) {
				el.appendChild(text(d, 'reader not connected — Ctrl+Alt+R', WARN));
			} else if (!tags.length) {
				el.appendChild(text(d, 'no tag on the pad'));
			} else {
				const t = tags[0];
				const state = stateOf(t.security);
				const line = `${t.content || '(blank tag)'} ${state.label}`;
				el.appendChild(
					text(
						d,
						tags.length > 1 ? `pad: ${tags.length} tags (one at a time)` : `on the pad: ${line}`,
						t.content ? (t.content === item.barcode ? OK : BAD) : WARN,
					),
				);
				if (!t.content) el.appendChild(text(d, 'this tag has never been written'));
			}

			if (last) {
				if (last.error) el.appendChild(text(d, last.error, BAD));
				else if (last.read) {
					el.appendChild(
						text(
							d,
							`tag reads: ${last.read.content || '(blank)'} — ${last.read.secure ? 'in library' : 'on loan'}` +
								(last.read.itemType ? ` — ${last.read.itemType}` : ''),
						),
					);
				} else if (last.ok) {
					el.appendChild(
						text(
							d,
							`wrote ${last.ok.content} — ${last.ok.verified ? 'read back and verified' : 'NOT verified'} (${last.ok.afi})`,
							last.ok.verified ? OK : BAD,
						),
					);
				}
			}

			const one = connected() && tags.length === 1;
			// Three states of the one button, because there are three things to say. Waiting for
			// the tag to move is not the same as being ready to overwrite, and a button that kept
			// saying "waiting" after the tag had come back would leave the confirm unspendable.
			const waiting = armed && !armed.lifted;
			const ready = armed && armed.lifted;
			el.appendChild(button('Read tag', read, one, 'rfid-read'));
			el.appendChild(
				button(
					waiting
						? 'Waiting: lift the tag, then replace it'
						: ready
							? `Overwrite ${armed.from} \u2192 ${item.barcode}`
							: `Program ${item.barcode}`,
					run,
					one && !waiting,
					'rfid-write',
				),
			);

			el.appendChild(
				text(
					d,
					'F4 (or Ctrl+Alt+P) is the same as the button, with the same rules',
					'color:#666;margin:6px 0 0 0',
				),
			);

			const writes = (m0.programs || []).slice(-3);
			if (writes.length)
				el.appendChild(
					text(
						d,
						`last writes: ${writes
							.map((w) => (w.error ? `refused ${w.to}` : `${w.to} ${w.verified ? '✓' : '✗'}`))
							.join(', ')}`,
						'color:#666;margin:6px 0 0 0',
					),
				);

			hideDeadNotices();
		});

	render();
	const off = m0.onpaint ? m0.onpaint(render) : null;

	// F4 is the muscle memory the 2012 template patch left behind, and Ctrl+Alt+P is there
	// because F4 belongs to some browsers and window managers. Both go through the same write()
	// as the button, arm-and-re-present included: a shortcut that skipped the confirmation
	// would unmake it. So this page takes two keystrokes and every other page in the plugin
	// still takes none (§5), and only while this panel is on the page — destroy() gives them
	// back. Nothing is taken from a field: a librarian typing in the search box at the top of
	// the page keeps their F4.
	const editable = (el) =>
		!!el &&
		(['INPUT', 'TEXTAREA', 'SELECT'].includes(String(el.tagName || '').toUpperCase()) || !!el.isContentEditable);

	const onKey = (ev) => {
		if (ev.defaultPrevented) return;
		const isF4 = ev.key === 'F4';
		const isP = ev.ctrlKey && ev.altKey && (ev.key === 'p' || ev.key === 'P' || ev.code === 'KeyP');
		if (!isF4 && !isP) return;
		if (editable(d.activeElement)) return;
		if (ev.preventDefault) ev.preventDefault();
		run();
	};
	win.addEventListener('keydown', onKey);

	return {
		el,
		render,
		armed: () => armed,
		reset: () => {
			last = null;
			disarm();
			render();
		},
		destroy: () => {
			if (off) off();
			if (win.removeEventListener) win.removeEventListener('keydown', onKey);
			if (el.parentNode && el.parentNode.removeChild) el.parentNode.removeChild(el);
		},
	};
}

// The panel is allowed to fail: a broken panel must not take the page, the pill, or the
// reader with it. Everything it does is inside this, and the failure says so in the box.
function safe(d, el, fn) {
	try {
		fn();
	} catch (e) {
		try {
			el.textContent = `RFID panel failed: ${(e && e.message) || e}`;
			el.style.cssText = BOX + ';' + BAD;
		} catch {
			/* nothing left to try */
		}
	}
}
