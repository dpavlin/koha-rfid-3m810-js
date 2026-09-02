/*
 * The screen a librarian cannot walk past.
 *
 * A check-in that Koha took and the tag did not is invisible: the item is on the shelf,
 * the shelf list says so, the returns page has moved on. The tag says something else, and
 * the only system that reads tags is the one standing at the door. So this is not a toast
 * — a toast is what the last thing nobody read looks like, and this is the one error where
 * "nobody noticed" costs more than a few seconds of annoyance.
 *
 * It covers the page, it says the barcode bigger than anything else on the screen, it
 * repeats a tone until the book is back, and it has exactly two ways out: the tag gets
 * written, or a person records that it will not be. Not a timer. A modal that closes
 * itself after ten seconds is a modal that has already been dismissed by the time it is
 * read.
 *
 * `Esc` does the same thing as the button, which is a deliberate trade: a screen nobody
 * can leave is worse than one that can be left knowingly, because the requirement is that
 * the decision is loud and recorded, not that the plugin wins the argument.
 *
 * Browsers only allow sound after a gesture. Arming the reader is one, so on the normal
 * path the tone just works; where it does not, the overlay says so and the next click on
 * it makes the noise. If audio is refused entirely, the screen is still there.
 */

const ID = 'rfid-alert';

const BOX =
	'position:fixed;inset:0;z-index:10002;display:none;align-items:center;justify-content:center;' +
	'background:rgba(12,12,12,.92);color:#fff;font:16px/1.45 system-ui,sans-serif;text-align:center';
const CARD = 'max-width:44rem;padding:28px 36px;border:2px solid #fff;border-radius:8px;background:#111';
const HEAD = 'font-size:19px;font-weight:700;margin:0 0 6px';
const BARCODE = 'font:56px/1.1 ui-monospace,monospace;font-weight:700;letter-spacing:1px;margin:6px 0 2px';
const LINE = 'margin:2px 0;color:#eee';
const STATE = 'margin:10px 0 0;font-size:15px;color:#ffd75e';
const ROW = 'margin:18px 0;padding:14px 0;border-top:1px solid #444';
const BTN =
	'margin-top:14px;padding:8px 14px;font:14px system-ui,sans-serif;background:#fff;color:#111;' +
	'border:0;border-radius:4px;cursor:pointer';
const FOOT = 'margin-top:18px;font-size:13px;color:#bbb';

const plain = (s) => String(s == null ? '' : s);

/**
 * `show(entries)` is the whole interface: a non-empty list covers the page, an empty one
 * takes it off again. `onAcknowledge(barcode)` is the button and `Esc`, and is expected to
 * forget that entry (the module never decides that on its own).
 */
export function takeover(win, { onAcknowledge = () => {}, beep = true, setInterval, clearInterval, AudioContext, blinkMs = 1000 } = {}) {
	const d = win.document;
	if (!d || !d.createElement) return { show: () => {}, isShowing: () => false, state: () => ({}) };

	// Timers come from the window the plugin was handed, the same reason serial ports do:
	// a test that cannot see the timer cannot make the beeping stop, and a module that
	// reaches for the global one holds the process open behind it.
	const every =
		setInterval ||
		((fn, ms) => (win.setInterval ? win.setInterval(fn, ms) : globalThis.setInterval(fn, ms)));
	const untick =
		clearInterval || ((h) => (win.clearInterval ? win.clearInterval(h) : globalThis.clearInterval(h)));
	const AudioCtor = AudioContext || win.AudioContext || win.webkitAudioContext;

	let root = null;
	let showing = false;
	let entries = [];
	let tick = null;
	let audio = null; // { ctx, suspended } once we have tried
	let titleSaved = null;
	let blink = null;
	let focusBefore = null;

	const box = () => {
		if (root) return root;
		const parent = d.body || d.documentElement;
		if (!parent || !parent.appendChild) return null;
		root = d.createElement('div');
		root.id = ID;
		root.setAttribute('role', 'alertdialog');
		root.setAttribute('aria-live', 'assertive');
		root.setAttribute('aria-label', 'RFID security bit was not updated');
		root.style.cssText = BOX;
		root.addEventListener('click', () => startBeep());
		// Esc acknowledges. A document that cannot take a listener still gets the screen
		// and the button; it just cannot be left with the keyboard.
		if (d.addEventListener)
			d.addEventListener('keydown', (ev) => {
				if (!showing || !entries.length) return;
				if (ev.key === 'Escape' || ev.key === 'Esc') {
					if (ev.preventDefault) ev.preventDefault();
					ack(entries[0].barcode);
				}
			});
		parent.appendChild(root);
		return root;
	};

	const render = () => {
		if (!root) return;
		root.textContent = '';
		const card = d.createElement('div');
		card.style.cssText = CARD;

		const h = d.createElement('h1');
		h.style.cssText = HEAD;
		h.textContent = 'A book left the reader before its security bit was updated';
		card.appendChild(h);

		const why = d.createElement('p');
		why.style.cssText = LINE;
		why.textContent =
			'Koha has recorded the transaction. The tag has not been told, so it still ' +
			'describes the item as it was before — and the door believes the tag.';
		card.appendChild(why);

		for (const e of entries) {
			const row = d.createElement('div');
			row.style.cssText = ROW;

			const bc = d.createElement('div');
			bc.style.cssText = BARCODE;
			bc.textContent = plain(e.barcode);
			row.appendChild(bc);

			const was = d.createElement('p');
			was.style.cssText = LINE;
			was.textContent = `Tag left at ${e.from || 'unknown'} — it should say ${hexOf(e.to)}. Put the book back on the reader.`;
			row.appendChild(was);

			const st = d.createElement('p');
			st.style.cssText = STATE;
			st.textContent = `Waiting ${human(e.ageMs)} — the item is checked in, the tag is not.`;
			row.appendChild(st);

			const b = d.createElement('button');
			b.type = 'button';
			b.style.cssText = BTN;
			b.textContent = "It cannot be done now — record that the tag stays as it is";
			b.addEventListener('click', () => ack(e.barcode));
			row.appendChild(b);

			card.appendChild(row);
		}

		const foot = d.createElement('p');
		foot.style.cssText = FOOT;
		foot.textContent =
			'This stays until the tag has been written or you record that it will not be. Esc does the same as the button.' +
			(audio && audio.suspended ? ' — sound needs a click first; click anywhere here.' : '');
		card.appendChild(foot);

		root.appendChild(card);
	};

	const ack = (barcode) => {
		try {
			onAcknowledge(barcode);
		} catch {
			/* a failing callback must not trap the librarian in the dialog */
		}
	};

	// --- sound ---------------------------------------------------------------
	const tone = (ctx, freq, at, dur) => {
		const o = ctx.createOscillator();
		const g = ctx.createGain();
		o.frequency.value = freq;
		o.connect(g);
		g.connect(ctx.destination);
		g.gain.setValueAtTime(0.0001, at);
		g.gain.exponentialRampToValueAtTime(0.35, at + 0.01);
		g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
		o.start(at);
		o.stop(at + dur + 0.02);
	};

	const startBeep = () => {
		if (!beep || !showing || !AudioCtor) return;
		try {
			if (!audio) audio = { ctx: new AudioCtor(), suspended: false };
			const ctx = audio.ctx;
			if (ctx.state === 'suspended') {
				audio.suspended = true;
				if (ctx.resume) ctx.resume();
				render();
				return;
			}
			audio.suspended = false;
			const t = ctx.currentTime;
			tone(ctx, 880, t, 0.12);
			tone(ctx, 660, t + 0.16, 0.2);
		} catch {
			/* no sound on this machine; the screen is the part that must work */
		}
	};

	const startTicking = () => {
		if (tick || !beep) return;
		startBeep();
		tick = every(() => startBeep(), 1500);
	};

	const stopTicking = () => {
		if (tick) untick(tick);
		tick = null;
	};

	// --- title ---------------------------------------------------------------
	// The one channel that works when the tab is in the background, which is where a
	// librarian who ignored the screen will be.
	const startBlink = () => {
		if (blink || !d) return;
		const wanted = `⚠ ${entries.length} RFID tag(s) need writing — put the book back on the reader`;
		if (titleSaved === null) titleSaved = plain(d.title);
		let on = true;
		d.title = wanted;
		blink = every(() => {
			d.title = (on = !on) ? wanted : titleSaved;
		}, blinkMs);
	};

	const stopBlink = () => {
		if (blink) untick(blink);
		blink = null;
		if (titleSaved !== null) {
			d.title = titleSaved;
			titleSaved = null;
		}
	};

	// --- the interface -------------------------------------------------------
	const show = (list = []) => {
		entries = (list || []).filter((e) => e && e.barcode);
		if (!entries.length) return hide();
		if (!box()) return { failed: 'no page to cover' };

		const was = showing;
		showing = true;
		root.style.display = 'flex';
		render();
		if (!was) {
			try {
				focusBefore = d.activeElement;
			} catch {}
			startTicking();
			startBlink();
			const b = root.querySelector && root.querySelector('button');
			if (b && b.focus) {
				try {
					b.focus();
				} catch {}
			}
		}
		return { showing: true, entries: entries.length };
	};

	const hide = () => {
		showing = false;
		entries = [];
		if (root) {
			root.style.display = 'none';
			root.textContent = '';
		}
		stopTicking();
		stopBlink();
		try {
			if (focusBefore && focusBefore.focus) focusBefore.focus();
		} catch {}
		focusBefore = null;
		return { showing: false };
	};

	return {
		show,
		hide,
		isShowing: () => showing,
		state: () => ({ showing, entries: entries.map((e) => e.barcode), sound: audio ? (audio.suspended ? 'needs click' : 'on') : beep ? 'not tried' : 'off' }),
	};
}

const hexOf = (b) => (typeof b === 'number' ? b.toString(16).toUpperCase().padStart(2, '0') : plain(b));

const human = (ms) => {
	const s = Math.max(0, Math.round((ms || 0) / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
};
