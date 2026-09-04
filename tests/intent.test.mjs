/*
 * Where the cursor is, is where the scan goes.
 *
 * These run against the field and form shapes captured from the live server
 * (tools/live/focus-map.mjs): every circulation page carries a `#barcode` in its own form,
 * and every staff page additionally carries the header quick-boxes — `#ret_barcode`
 * posting returns.pl, `#ren_barcode` posting renew.pl, `#findborrower` posting
 * circulation.pl — which is what Koha's Alt+R / Alt+W / Alt+U focus. The page table this
 * replaced could only see the first kind, so a scan after Alt+R landed in a box the plugin
 * refused to touch.
 *
 *   node --test tests/intent.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { intentOf, stateOf, STATES } from '../src/core/intent.js';
import { form, field } from './helpers/fakewindow.mjs';

const RUNTIME = '/cgi-bin/koha';

// The three pages, each with the header boxes that are on it. On returns.pl Koha leaves
// the check-in tab out of its own header, which is why that one has no `ret_barcode`.
const pages = () => {
	const returns = form(`${RUNTIME}/circ/returns.pl`, {
		id: 'checkin-form',
		fields: { barcode: field({ id: 'barcode' }) },
	});
	const renew = form(`${RUNTIME}/circ/renew.pl`, {
		fields: { barcode: field({ id: 'barcode' }) },
	});
	const issue = form(`${RUNTIME}/circ/circulation.pl`, {
		id: 'mainform',
		fields: { barcode: field({ id: 'barcode' }) },
	});
	const patron = form(`${RUNTIME}/circ/circulation.pl`, {
		id: 'patronsearch',
		fields: {
			findborrower: field({ id: 'findborrower', name: 'findborrower' }),
		},
	});
	const headerRet = form(`${RUNTIME}/circ/returns.pl`, {
		fields: { barcode: field({ id: 'ret_barcode' }) },
	});
	const headerRenew = form(`${RUNTIME}/circ/renew.pl`, {
		fields: { barcode: field({ id: 'ren_barcode' }) },
	});
	const catalog = form(`${RUNTIME}/catalogue/search.pl`, {
		id: 'cat-search-block',
		fields: { q: field({ id: 'search-form', name: 'q' }) },
	});
	return { returns, renew, issue, patron, headerRet, headerRenew, catalog };
};

const intent = (f) => intentOf(f.elements.barcode || f.elements.findborrower);

test('each page has one intent, and it names the transaction, not the page', () => {
	const p = pages();
	assert.equal(intent(p.returns).word, 'checkin');
	assert.equal(intent(p.renew).word, 'renew');
	assert.equal(intent(p.issue).word, 'checkout');
	assert.equal(intent(p.patron).word, 'patron');
});

test('the transaction decides what the tag should say afterwards', () => {
	const p = pages();
	// A returned book is in the building; a renewed or issued one is out of it. A patron
	// card is not a book and has nothing to say.
	assert.equal(intent(p.returns).state, 'inLibrary');
	assert.equal(intent(p.renew).state, 'onLoan');
	assert.equal(intent(p.issue).state, 'onLoan');
	assert.equal(intent(p.patron).state, null);
});

test('a header box is the transaction it posts, on whatever page it is standing on', () => {
	const p = pages();
	// The point of the design: mainpage.pl has no circulation forms of its own, only these.
	// Alt+R focuses the first, and a scan there is a check-in as much as on returns.pl.
	assert.equal(intent(p.headerRet).word, 'checkin');
	assert.equal(intent(p.headerRet).state, 'inLibrary');
	assert.equal(intent(p.headerRenew).word, 'renew');
	assert.equal(intent(p.headerRenew).state, 'onLoan');
});

test('two fields named barcode on one page are told apart by their form', () => {
	// circulation.pl: the checkout box and the header check-in box share a field name, and
	// putting a scan in the wrong one is a check-in nobody meant. Intent is asked of the
	// focused field, so the ambiguity does not exist — but it would if this used a selector.
	const p = pages();
	assert.equal(intentOf(p.issue.elements.barcode).word, 'checkout');
	assert.equal(intentOf(p.headerRet.elements.barcode).word, 'checkin');
});

test('the patron box takes the card, and no tag of ours is involved', () => {
	const p = pages();
	const it = intent(p.patron);
	assert.equal(it.kind, 'patron');
	assert.equal(it.state, null, 'a card has no security bit');
});

test('a cursor anywhere else means the plugin does nothing', () => {
	const p = pages();
	assert.equal(intentOf(p.catalog.elements.q), null, 'catalogue search');
	assert.equal(intentOf(null), null, 'nothing focused');
	assert.equal(intentOf({ tagName: 'BODY' }), null, 'the page itself');
	assert.equal(intentOf({ tagName: 'INPUT', name: 'barcode' }), null, 'a barcode field with no form');
	assert.equal(intentOf({ tagName: 'INPUT', name: 'something', form: p.returns }), null, 'not a barcode field');
});

test('a box the page switched off is left switched off', () => {
	// circulation.pl disables #barcode while it waits for "Please confirm checkout". Filling
	// it would look like readiness and post a form that does nothing.
	const p = pages();
	p.issue.elements.barcode.disabled = true;
	assert.equal(intentOf(p.issue.elements.barcode), null);

	const ro = form(`${RUNTIME}/circ/returns.pl`, {
		fields: { barcode: field({ id: 'barcode', readOnly: true }) },
	});
	assert.equal(intentOf(ro.elements.barcode), null);
});

test('a tag is read as a state, in words, never as hex', () => {
	const inLibrary = stateOf('DA');
	const onLoan = stateOf('D7');
	assert.equal(inLibrary.word, 'in library');
	assert.equal(onLoan.word, 'on loan');
	assert.equal(inLibrary.label, 'IN');
	assert.equal(onLoan.label, 'OUT');
	assert.equal(onLoan.tone, 'out');

	// Plain ASCII, and that is the requirement, not a style preference: the pill is 11px
	// monospace, where the arrows this used to carry turned into one smudge, and the word is
	// the only thing distinguishing the two chips besides a green/amber hue one staff member
	// in twenty cannot rely on. A pictograph in here would pass every other test in this file.
	for (const s of Object.values(STATES)) {
		assert.match(s.label, /^[A-Z?]{2,3}$/, `"${s.label}" must be two or three ASCII capitals`);
	}

	// The driver gives the byte as text; a number is accepted because writing is by byte.
	assert.equal(stateOf(0xda).word, 'in library');
	assert.equal(stateOf('00').word, 'no security bit');
	assert.equal(stateOf(undefined).word, 'no security bit');
	assert.equal(stateOf('00').tone, 'none', 'unreadable is shown as unknown, not guessed at');
	assert.equal(STATES.inLibrary.afi, 0xda);
	assert.equal(STATES.onLoan.hex, 'D7');
});
