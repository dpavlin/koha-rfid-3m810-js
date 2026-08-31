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

/*
 * A return leaves a date behind; a refusal leaves words. That is the whole
 * discriminator, and it is what makes this survive a Koha upgrade: "Not checked
 * out.", "Item not checked out to this borrower", "Check in complete" — whatever the
 * wording, a row that did not return anything has nothing that looks like a date in
 * the due-date column, and a row that did has one. Both rows were captured from the
 * live server, in tests/fixtures/checkedin-*.html:
 *
 *   returned    <td class="ci-duedate">2027-03-06 23:59</td>
 *   refused     <td class="ci-duedate">Not checked out</td>
 *
 * The barcode column is identical in both, which is the trap: matching the table
 * text for the barcode believes Koha's own error message. It is also the safe
 * direction to be wrong in — see the header.
 */
const DATEISH = /\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/;

/** Did this page come back having checked `barcode` in? */
export function classify({ barcode = null, returned = [] } = {}) {
	const ok = !!barcode && returned.some((b) => b === barcode);
	return { ok, detail: ok ? barcode : 'not confirmed' };
}

/**
 * The returns.pl adapter: which barcodes does this page say it checked in?
 *
 * Cells are read by their `ci-*` class where the template has them (falls back to
 * the row's own text where it doesn't, so an older or newer template still works,
 * just less precisely). The notices are collected for the log only — a refusal is
 * Koha's message to read, not ours to repeat — so nothing here decides anything
 * based on them, and if those class names change all that is lost is detail in a log.
 */
export function readCheckinResult(doc) {
	const rows = doc && doc.querySelectorAll ? [...doc.querySelectorAll('table#checkedintable tbody tr')] : [];
	const returned = [];
	for (const row of rows) {
		const cell = (cls) => (row.querySelector ? text(row.querySelector('td.' + cls)) : '');
		const has = (cls) => !!(row.querySelector && row.querySelector('td.' + cls));
		// Without the ci-* hooks there is nothing better than a barcode-shaped token in
		// the row. Less precise, which is why the cell class is worth keeping an eye on.
		const barcode = has('ci-barcode') ? cell('ci-barcode') : (text(row).match(/\b\d{5,14}\b/) || [''])[0];
		const due = has('ci-duedate') ? cell('ci-duedate') : text(row);
		if (barcode && DATEISH.test(due)) returned.push(barcode);
	}
	return {
		returned,
		messages:
			doc && doc.querySelectorAll
				? [...(doc.querySelectorAll('.dialog.alert, .dialog.message') || [])].map(text).filter(Boolean)
				: [],
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
