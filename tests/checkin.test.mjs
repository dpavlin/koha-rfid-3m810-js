/*
 * The check-in session, without Koha, without a reader.
 *
 * The interesting property is not "it posts a barcode" but what happens around the
 * reload: a posted check-in that cannot be confirmed must never be posted again by a
 * machine, and the memory of posting has to survive the page that did it.
 *
 *   node --test tests/checkin.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classify, readCheckinResult, session } from '../src/core/checkin.js';

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

/** A page like returns.pl after one successful check-in. */
const fakeDoc = (confirmedText, notices = []) => ({
	querySelector: (sel) => (sel === 'table#checkedintable' ? { textContent: confirmedText } : null),
	querySelectorAll: () => notices.map((t) => ({ textContent: t })),
});

test('the verdict is membership, not wording', () => {
	const page = ' Due date Title Author Barcode Home library 2027-03-06 A commentary on Propertius 1302079605 FFZG ';
	assert.equal(classify({ barcode: '1302079605', confirmed: page }).ok, true);
	assert.equal(classify({ barcode: '1302099999', confirmed: page }).ok, false);
	assert.equal(classify({ barcode: null, confirmed: page }).ok, false, 'nothing posted, nothing confirmed');
});

test('a page that lists nothing confirms nothing, whatever it says', () => {
	// This is the upgrade-safe direction: wording changed, or the table was renamed —
	// the plugin stops claiming success, it does not start claiming it.
	const o = classify({ barcode: '1302079605', confirmed: '', messages: ['Checked in successfully!'] });
	assert.equal(o.ok, false);
	assert.match(o.detail, /not confirmed/);
});

test('readCheckinResult reads one selector and survives its absence', () => {
	assert.deepEqual(readCheckinResult(fakeDoc('x 1302079605 y')), { confirmed: 'x 1302079605 y', messages: [] });
	assert.deepEqual(readCheckinResult({}), { confirmed: '', messages: [] });
	assert.deepEqual(readCheckinResult(null), { confirmed: '', messages: [] });
});

test('nothing pending: the session reports nothing and posts nothing', () => {
	const s = session({ store: memStore(), submit: () => assert.fail('must not post') });
	assert.equal(s.report({ confirmed: 'anything' }), null);
	assert.equal(s.pump([]), null);
});

test('a tag on the pad is posted once, and once is once', () => {
	const posted = [];
	const s = session({ store: memStore(), submit: (bc) => posted.push(bc) });

	assert.equal(s.pump(tags('200000000042', '1302079605')), '1302079605', 'a patron card is not a book');
	assert.equal(s.pump(tags('200000000042', '1302079605')), null, 'one check-in in flight');
	assert.deepEqual(posted, ['1302079605']);
	assert.equal(s.state().pending, '1302079605');
});

test('the story survives the reload that the post causes', () => {
	const store = memStore();
	const outcomes = [];
	const first = session({ store, submit: () => {}, onOutcome: (o, bc) => outcomes.push([o.ok, bc]) });
	first.pump(tags('1302079605'));

	// The page navigated: fresh module state, same sessionStorage.
	const after = session({ store, submit: () => {}, onOutcome: (o, bc) => outcomes.push([o.ok, bc]) });
	const ok = after.report(readCheckinResult(fakeDoc('2027-03-06 A commentary 1302079605 FFZG')));

	assert.equal(ok.ok, true);
	assert.deepEqual(outcomes, [[true, '1302079605']]);
	assert.equal(after.state().pending, null);
});

test('an unconfirmed check-in is never posted again by a machine', () => {
	const store = memStore();
	const posted = [];
	const first = session({ store, submit: (bc) => posted.push(bc) });
	first.pump(tags('1302079605'));

	const after = session({ store, submit: (bc) => posted.push(bc) });
	const outcome = after.report(readCheckinResult(fakeDoc(''))); // page said nothing

	assert.equal(outcome.ok, false);
	assert.equal(after.pump(tags('1302079605')), null, 'the same item sits on the pad; it must not go round again');
	assert.deepEqual(posted, ['1302079605'], 'posted exactly once');
});

test('the next tag on the pad is the next check-in', () => {
	const store = memStore();
	const posted = [];
	const first = session({ store, submit: (bc) => posted.push(bc) });
	first.pump(tags('1302079605'));

	const after = session({ store, submit: (bc) => posted.push(bc) });
	after.report(readCheckinResult(fakeDoc('1302079605')));

	assert.equal(after.pump(tags('1302079605', '1302099999')), '1302099999');
	assert.deepEqual(posted, ['1302079605', '1302099999']);
});

test('a tag taken off the pad stops blocking its own barcode', () => {
	const s = session({ store: memStore(), submit: () => 'x' });
	s.pump(tags('1302079605'));
	s.report({ confirmed: '1302079605' });

	assert.equal(s.pump(tags('1302079605')), null);
	s.forget(['1302079605']);
	assert.equal(s.pump(tags('1302079605')), '1302079605');
});

test('remembering expires, so tomorrow is not blocked by today', () => {
	let now = 1_000;
	const s = session({ store: memStore(), submit: () => 'x', now: () => now, ttlMs: 5_000 });
	s.pump(tags('1302079605'));
	s.report({ confirmed: '1302079605' });

	assert.equal(s.pump(tags('1302079605')), null);
	now += 6_000;
	assert.equal(s.pump(tags('1302079605')), '1302079605');
});

test('private mode: no storage, still no double posting within the page', () => {
	const thrown = [];
	const broken = {
		getItem: () => {
			throw new Error('SecurityError');
		},
		setItem: () => {
			throw new Error('SecurityError');
		},
		removeItem: () => {},
	};
	const s = session({ store: broken, submit: (bc) => thrown.push(bc) });

	assert.equal(s.pump(tags('1302079605')), '1302079605');
	assert.equal(s.pump(tags('1302079605')), null);
	assert.deepEqual(thrown, ['1302079605']);
});

test('reset forgets everything, for the librarian who is done being clever', () => {
	const s = session({ store: memStore(), submit: () => 'x' });
	s.pump(tags('1302079605'));
	s.report({ confirmed: '1302079605' });
	s.reset();

	assert.deepEqual(s.state(), { pending: null, handled: {} });
	assert.equal(s.pump(tags('1302079605')), '1302079605');
});
