/*
 * A check-in spans two page loads.
 *
 * returns.pl has no API: you post a barcode and it answers with a whole new page.
 * So the machine has to survive the reload — remember what was posted, look at the
 * page that came back, decide.
 *
 * The failure mode this exists to prevent is the loop: post, fail to tell whether it
 * worked, post again. A check-in you cannot confirm is a check-in that may happen
 * twice, and the second one lands on the *next* loan of that item. So the verdict is
 * two-valued — worked, or not — and "not" marks the barcode handled so a machine
 * never posts it again. A human can; that is a different risk.
 *
 * Two things are deliberately not done here.
 *
 * No message wording is parsed. Matching on "Not checked out." or "No item with
 * barcode" pins this to one template and fails silently on upgrade: the wording
 * changes, and check-ins that worked start being reported as failures. One thing is
 * trusted instead — that a page which checked something in lists it among the things
 * it checked in — and the caller says which part of the page that is (`confirmed`).
 * If Koha ever renames that region the failure is a false "not confirmed", which is
 * the safe direction: nothing gets reposted.
 *
 * And failures are not repeated to the librarian. Koha renders its own error on the
 * page that just reloaded, in context, with the patron and the title next to it. A
 * second, blunter copy from the plugin would be noise — so a failed check-in goes to
 * the log, and only a successful one is announced.
 */

const KEY = 'rfid_checkin';
const text = (el) => (el && (el.textContent || el.innerText) || '').replace(/\s+/g, ' ').trim();

/** Did this page come back having checked `barcode` in? `confirmed` is the text of
 *  the region that lists what the post did (returns.pl: the checked-in table). */
export function classify({ barcode = null, confirmed = '' } = {}) {
	const ok = !!barcode && confirmed.includes(barcode);
	return { ok, detail: ok ? barcode : 'not confirmed' };
}

/**
 * The returns.pl adapter. One selector decides the verdict: the table of items this
 * page checked in. The notices are collected for the log only — a failed check-in is
 * Koha's message to read, not ours to repeat, so nothing here decides anything based
 * on them, and if those class names ever change all that is lost is detail in a log.
 */
export function readCheckinResult(doc) {
	if (!doc || !doc.querySelector) return { confirmed: '', messages: [] };
	return {
		confirmed: text(doc.querySelector('table#checkedintable')),
		messages: [...(doc.querySelectorAll('.dialog.alert, .dialog.message') || [])].map(text).filter(Boolean),
	};
}

/**
 * The session. `store` is sessionStorage — it must die with the tab, because a posted
 * check-in remembered until tomorrow's shift is a result reported to nobody. `submit`
 * posts the form, and is expected to navigate away.
 */
export function session({
	store,
	now = () => Date.now(),
	ttlMs = 60000,
	bookPrefix = '130',
	submit = () => {},
	onOutcome = () => {},
	log = () => {},
} = {}) {
	const open = () => {
		try {
			return JSON.parse(store.getItem(KEY)) || null;
		} catch {
			return null;
		}
	};

	let st = open() || { pending: null, handled: {} };
	const save = () => {
		try {
			store.setItem(KEY, JSON.stringify(st));
		} catch {
			/* private mode: the machine still works within this page load */
		}
	};

	const handled = (barcode) => !!st.handled[barcode];
	const usable = (barcode) => barcode && barcode !== st.pending && (!bookPrefix || barcode.startsWith(bookPrefix)) && !handled(barcode);

	/** Just after a load: what happened to the barcode posted before the reload? */
	const report = (result) => {
		if (!st.pending) return null;
		const barcode = st.pending;
		const outcome = classify({ barcode, ...result });
		st.handled[barcode] = now();
		st.pending = null;
		save();
		log('check-in ' + barcode, outcome.ok ? 'ok' : 'not confirmed');
		onOutcome(outcome, barcode);
		return outcome;
	};

	/** Post the next unhandled tag on the pad, if there is one and nothing is in flight. */
	const pump = (tags) => {
		if (st.pending) return null;
		for (const [barcode, at] of Object.entries(st.handled)) if (now() - at > ttlMs) delete st.handled[barcode];
		const barcode = (tags || []).map((t) => t.content).filter(Boolean).find(usable) || null;
		if (!barcode) return null;
		st.pending = barcode;
		save();
		log('check-in posted', barcode);
		submit(barcode);
		return barcode;
	};

	/** A tag taken off the pad stops being remembered, so the next item is not blocked. */
	const forget = (barcodes) => {
		let changed = false;
		for (const bc of barcodes || []) if (st.handled[bc]) { delete st.handled[bc]; changed = true; }
		if (changed) save();
	};

	return {
		report,
		pump,
		forget,
		handled,
		state: () => JSON.parse(JSON.stringify(st)),
		reset: () => {
			st = { pending: null, handled: {} };
			save();
		},
	};
}
