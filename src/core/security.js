/*
 * What the tag says about itself is a claim, and Koha is the one that decides it.
 *
 * AFI 0xDA (secure) is what a book that is in the library carries; 0xD7 (unsecure) is
 * what an item on loan carries. The order of operations is the whole design: transaction
 * first, tag second. Write the tag before the submit and a refusal — a hold, an item that
 * was not on loan, a confirmation the page is waiting for — leaves the tag asserting what
 * the catalogue denied, with the previous state already destroyed and no way to retry
 * from a known starting point. So the tag is told afterwards, and only afterwards.
 *
 * Afterwards is a problem of its own, because "afterwards" is a page load: returns.pl
 * answers a check-in by navigating, and the page that learns the answer did not exist
 * when the write was scheduled. Hence the owed-write store — sessionStorage, which
 * survives the reload, and dies with the tab, which is the right life for "finish this
 * when you get the chance": an unacknowledged write resurrected three shifts from now
 * would shout at whoever is standing there, not at the person who left it.
 *
 * A write that cannot be done is the one failure not to whisper about. A wrong due date
 * is corrected at the desk; an item whose tag disagrees with the catalogue is corrected
 * when someone notices, and nobody is looking. So: if Koha confirmed and the tag is out
 * of range after `graceMs`, the alert opens and stays open until either the tag has been
 * written or a librarian says, deliberately, that it will not be. The second path records
 * what was left undone in `skipped` — a decision the librarian made should be readable
 * afterwards, not remembered.
 *
 * And the safe direction, twice over:
 *
 *  - an outcome that could not be confirmed drops the write. Most refusals are refusals,
 *    and an alarm on every "Not checked out" teaches everyone to dismiss alarms. If a
 *    real check-in was misread as a refusal, the cost is one tag left as it was — which
 *    the next scan of that book will not fix on its own, but which is a smaller error
 *    than writing to tags on a guess.
 *  - the target is only ever the state Koha just confirmed. Never "read the AFI and set
 *    it", which would let a tag that drifted decide what the plugin writes.
 */

export const AFI = { secure: 0xda, unsecure: 0xd7 };

const KEY = 'rfid_afi';
const hex = (b) => (typeof b === 'number' ? b.toString(16).toUpperCase().padStart(2, '0') : b || '');

/**
 * The owed-write machine. Everything browser-shaped is injected: `store` (sessionStorage),
 * `write({ barcode, sid, from, to })` (resolves when the tag reads back right), `alert`
 * (whose `show(entries)` is also how it is told to stop: an empty list is nothing to
 * shout about), `schedule` (a timer for the grace period).
 */
export function owed({
	store,
	now = () => Date.now(),
	graceMs = 8000,
	write = async () => {
		throw new Error('no writer was given');
	},
	alert = {},
	log = () => {},
	onChange = () => {},
	schedule = (fn) => setTimeout(fn, 0),
} = {}) {
	const open = () => {
		try {
			return JSON.parse(store.getItem(KEY)) || {};
		} catch {
			return {};
		}
	};

	let entries = open();
	let skipped = [];
	let lastTags = [];
	let busy = null; // one write at a time; pad views must not queue up behind each other

	const save = () => {
		try {
			store.setItem(KEY, JSON.stringify(entries));
		} catch {
			/* private mode: the writes still happen within this page load */
		}
	};

	const list = () =>
		Object.entries(entries).map(([barcode, e]) => ({
			barcode,
			...e,
			waiting: !e.confirmedAt,
			ageMs: now() - (e.confirmedAt || e.at),
		}));

	/**
	 * A transaction is in flight for this tag. `to` is what the tag must end up carrying
	 * if it works: DA after a check-in, D7 after an issue. Nothing is written yet.
	 */
	const owe = ({ barcode, sid, from = null, to = AFI.secure } = {}) => {
		if (!barcode || !sid) return null;
		entries[barcode] = { sid: String(sid).toUpperCase(), from: from || null, to, at: now(), confirmedAt: null };
		save();
		onChange();
		return entries[barcode];
	};

	/** Koha's verdict about the transaction that owed the write. */
	const verdict = ({ barcode, ok } = {}) => {
		const e = entries[barcode];
		if (!e) return;
		if (!ok) {
			delete entries[barcode];
			save();
			log('tag write dropped', `${barcode}: Koha did not confirm, so nothing was owed`);
			onChange();
			return;
		}
		e.confirmedAt = now();
		save();
		// The grace period has to have a timer of its own: a book carried away is the last
		// thing to change the pad, so nothing else would ever look again.
		schedule(() => pad({ tags: lastTags }), graceMs + 50);
		onChange();
	};

	// Which barcodes the screen is currently shouting about. Kept so that acknowledging
	// one of two does not repaint the alert with the one that was just let go.
	let loudNow = [];
	const show = (barcodes, pending = list()) => {
		if (!alert.show) return;
		// Nothing on the screen and nothing to put on it: the alert is not repainted on
		// every pad tick, which matters because repainting it steals focus under the reader.
		if (!barcodes.length && !loudNow.length) return;
		loudNow = barcodes;
		alert.show(pending.filter((e) => barcodes.includes(e.barcode)));
	};

	const finish = (barcode, how, tag) => {
		const e = entries[barcode];
		delete entries[barcode];
		save();
		log('tag ' + (how === 'written' ? 'updated' : 'already said ' + hex(e.to)), `${barcode} (sid ${e.sid})`);
		onChange({ barcode, how, tag });
	};

	/**
	 * Look at the pad. Anything owed, confirmed and in range gets written; anything owed,
	 * confirmed and gone for longer than the grace gets shouted about.
	 */
	const pad = async ({ tags = [] } = {}) => {
		lastTags = tags || [];
		const bySid = new Map(lastTags.filter((t) => t.sid).map((t) => [String(t.sid).toUpperCase(), t]));
		// Only these deserve the screen: confirmed and out of range, or in range and the
		// write did not stick. An in-flight transaction is not an emergency, and an alert
		// that cries wolf once is an alert that gets clicked through from now on.
		const shouting = [];

		for (const [barcode, e] of Object.entries(entries)) {
			const tag = bySid.get(String(e.sid).toUpperCase());

			if (!tag) {
				if (e.confirmedAt && now() - e.confirmedAt >= graceMs) shouting.push(barcode);
				continue;
			}
			if (!e.confirmedAt) continue;

			const current = tag.security ? parseInt(tag.security, 16) : null;
			if (current === e.to) {
				finish(barcode, 'already', tag); // somebody wrote it: another desk, a re-scan
				continue;
			}

			if (busy) await busy.catch(() => {});
			busy = write({ barcode, sid: e.sid, from: current === null ? e.from : hex(current), to: e.to });
			try {
				await busy;
				finish(barcode, 'written', tag);
			} catch (err) {
				// The tag is in front of us and still says the wrong thing.
				log('tag write failed', `${barcode}: ${String((err && err.message) || err)}`);
				if (entries[barcode]) shouting.push(barcode);
			} finally {
				busy = null;
			}
		}

		show(shouting);
		return list();
	};

	/**
	 * "It is not going back on the reader." The only exit that is not the write itself,
	 * and it records: barcode, tag, how long it waited, what the tag was left saying.
	 */
	const acknowledge = (barcode) => {
		const e = entries[barcode];
		if (!e) return false;
		skipped.push({
			barcode,
			sid: e.sid,
			leftAt: e.from || '?',
			wanted: hex(e.to),
			waitedMs: now() - (e.confirmedAt || e.at),
			at: now(),
		});
		if (skipped.length > 50) skipped.shift();
		delete entries[barcode];
		save();
		log('security bit left alone', `${barcode} stays at ${e.from || '?'}, not ${hex(e.to)} — acknowledged`);
		show(loudNow.filter((b) => b !== barcode));
		onChange({ barcode, how: 'skipped' });
		return true;
	};

	return {
		owe,
		verdict,
		pad,
		acknowledge,
		list,
		skipped: () => skipped.slice(),
		isShouting: () => list().some((e) => !e.waiting),
		state: () => ({ pending: list(), skipped: skipped.slice(), graceMs }),
		reset: () => {
			entries = {};
			save();
			onChange();
		},
	};
}
