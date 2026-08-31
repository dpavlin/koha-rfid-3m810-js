/*
 * The check-in session, without Koha, without a reader.
 *
 * The interesting property is not "it posts a barcode" but what happens around the
 * reload: a posted check-in that cannot be confirmed must never be posted again by a
 * machine, and the memory of posting has to survive the page that did it.
 *
 * The verdict tests run against HTML captured from the live server
 * (tests/fixtures/checkedin-*.html), because the one case that matters — Koha
 * refusing, in a table that still contains the barcode — is not something I trust
 * myself to invent accurately.
 *
 *   node --test tests/checkin.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classify, readCheckinResult, session } from '../src/core/checkin.js';
import { returnsPage, plainRowsPage, noTablePage } from './helpers/returnsdom.mjs';

const OK = 'checkedin-returned.html';
const REFUSED = 'checkedin-not-checked-out.html';
const BARCODE = '1302079605';

const memStore = (init = {}) => ({
	data: { ...init },
	getItem(k) {
		return k in this.data ? this.data[k] : null;
	},
	setItem(k, v) {
		this.data[k] = String(v);
	},
	removeItem(k) {
		delete this.data[k];
	},
});

const tags = (...contents) => contents.map((content, i) => ({ sid: `e00401000000000${i}`, content }));

test('a row that returned something has a date; a refusal has words', () => {
	const page = readCheckinResult(returnsPage(OK));
	assert.deepEqual(page.returned, [BARCODE]);
	assert.equal(classify({ barcode: BARCODE, ...page }).ok, true);
});

test('a refusal is not a check-in, even though the barcode is on the page', () => {
	// The trap: returns.pl renders "Not checked out" as a row of the same table, with
	// the same title and the same barcode. Matching the table's text believed it.
	const page = readCheckinResult(returnsPage(REFUSED));
	assert.deepEqual(page.returned, [], 'the row is there, the return is not');
	assert.equal(classify({ barcode: BARCODE, ...page }).ok, false);
});

test('a barcode returned once in a table that mentions it twice is returned once', () => {
	const page = readCheckinResult(returnsPage(OK, REFUSED));
	assert.deepEqual(page.returned, [BARCODE]);
	assert.equal(classify({ barcode: BARCODE, ...page }).ok, true);
});

test('a template without the ci-* hooks still works, less precisely', () => {
	const page = readCheckinResult(plainRowsPage(['06/03/2027', 'A commentary', BARCODE], ['Not checked out', 'A commentary', BARCODE]));
	assert.deepEqual(page.returned, [BARCODE], 'a date anywhere in the row is enough');
});

test('no table, no rows: nothing is confirmed, and that is the safe direction', () => {
	assert.deepEqual(readCheckinResult(noTablePage).returned, []);
	assert.deepEqual(readCheckinResult(null).returned, []);
	assert.equal(classify({ barcode: BARCODE, ...readCheckinResult(noTablePage) }).ok, false);
});

test('nothing pending: the session reports nothing and posts nothing', () => {
	const s = session({ store: memStore(), submit: () => assert.fail('must not post') });
	assert.equal(s.report({ returned: [BARCODE] }), null);
	assert.equal(s.pump([]), null);
});

test('a tag on the pad is posted once, and once is once', () => {
	const posted = [];
	const s = session({ store: memStore(), submit: (bc) => posted.push(bc) });

	assert.equal(s.pump(tags('200000000042', BARCODE)), BARCODE, 'a patron card is not a book');
	assert.equal(s.pump(tags('200000000042', BARCODE)), null, 'one check-in in flight');
	assert.deepEqual(posted, [BARCODE]);
	assert.equal(s.state().pending, BARCODE);
});

test('the story survives the reload that the post causes', () => {
	const store = memStore();
	const outcomes = [];
	const first = session({ store, submit: () => {}, onOutcome: (o, bc) => outcomes.push([o.ok, bc]) });
	first.pump(tags(BARCODE));

	// The page navigated: fresh module state, same sessionStorage.
	const after = session({ store, submit: () => {}, onOutcome: (o, bc) => outcomes.push([o.ok, bc]) });
	const ok = after.report(readCheckinResult(returnsPage(OK)));

	assert.equal(ok.ok, true);
	assert.deepEqual(outcomes, [[true, BARCODE]]);
	assert.equal(after.state().pending, null);
});

test('an unconfirmed check-in is never posted again by a machine', () => {
	const store = memStore();
	const posted = [];
	session({ store, submit: (bc) => posted.push(bc) }).pump(tags(BARCODE));

	const after = session({ store, submit: (bc) => posted.push(bc) });
	// ...and what came back was Koha refusing. Same table, same barcode.
	const outcome = after.report(readCheckinResult(returnsPage(REFUSED)));

	assert.equal(outcome.ok, false);
	assert.equal(after.pump(tags(BARCODE)), null, 'the same item sits on the pad; it must not go round again');
	assert.deepEqual(posted, [BARCODE], 'posted exactly once');
});

test('the next tag on the pad is the next check-in', () => {
	const store = memStore();
	const posted = [];
	session({ store, submit: (bc) => posted.push(bc) }).pump(tags(BARCODE));

	const after = session({ store, submit: (bc) => posted.push(bc) });
	after.report(readCheckinResult(returnsPage(OK)));

	assert.equal(after.pump(tags(BARCODE, '1302099999')), '1302099999');
	assert.deepEqual(posted, [BARCODE, '1302099999']);
});

test('a tag taken off the pad stops blocking its own barcode', () => {
	const s = session({ store: memStore(), submit: () => 'x' });
	s.pump(tags(BARCODE));
	s.report({ returned: [BARCODE] });

	assert.equal(s.pump(tags(BARCODE)), null);
	s.forget([BARCODE]);
	assert.equal(s.pump(tags(BARCODE)), BARCODE);
});

test('remembering expires, so tomorrow is not blocked by today', () => {
	let now = 1_000;
	const s = session({ store: memStore(), submit: () => 'x', now: () => now, ttlMs: 5_000 });
	s.pump(tags(BARCODE));
	s.report({ returned: [BARCODE] });

	assert.equal(s.pump(tags(BARCODE)), null);
	now += 6_000;
	assert.equal(s.pump(tags(BARCODE)), BARCODE);
});

test('private mode: no storage, still no double posting within the page', () => {
	const posted = [];
	const broken = {
		getItem: () => {
			throw new Error('SecurityError');
		},
		setItem: () => {
			throw new Error('SecurityError');
		},
		removeItem: () => {},
	};
	const s = session({ store: broken, submit: (bc) => posted.push(bc) });

	assert.equal(s.pump(tags(BARCODE)), BARCODE);
	assert.equal(s.pump(tags(BARCODE)), null);
	assert.deepEqual(posted, [BARCODE]);
});

test('reset forgets everything, for the librarian who is done being clever', () => {
	const s = session({ store: memStore(), submit: () => 'x' });
	s.pump(tags(BARCODE));
	s.report({ returned: [BARCODE] });
	s.reset();

	assert.deepEqual(s.state(), { pending: null, handled: {} });
	assert.equal(s.pump(tags(BARCODE)), BARCODE);
});
