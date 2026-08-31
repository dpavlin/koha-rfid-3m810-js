/*
 * Which box a scan goes into, and what the plugin is allowed to press.
 *
 * The shapes here come from tests/fixtures/circulation-pl-*.html and
 * renew-pl-patron.html, captured from the live fork. Two facts from those files are
 * the whole reason this file exists:
 *
 *   - circulation.pl has three forms with a field named `barcode` (checkout, plus the
 *     returns and renew boxes in the header), so a scan on a patron's page can fill
 *     the returns box while the librarian is standing at a checkout.
 *   - renew.pl has a hidden `#ren_barcode` in a display:none tab panel and the real
 *     box in a fieldset the librarian can see.
 *
 * And the policy that outranks both: the plugin posts check-ins and nothing else.
 * A return is reversible and Koha reports it; an issue takes the item out of the
 * library on a scan nobody confirmed.
 *
 *   node --test tests/pagetarget.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { install } from '../src/core/boot.js';
import { fakeWindow, form, field, fakeBoot } from './helpers/fakewindow.mjs';

const TAG = { sid: 'e00401003123b218', content: '1302079605', security: true, tag_type: 'rfid501' };

const RUNTIME = '/cgi-bin/koha';

/** The header boxes every staff page carries, as they are in the fixtures. */
const header = () => ({
	returns: form(`${RUNTIME}/circ/returns.pl`, { fields: { barcode: field({ id: 'ret_barcode' }) } }),
	renew: form(`${RUNTIME}/circ/renew.pl`, { fields: { barcode: field({ id: 'ren_barcode_hidden' }) } }),
});

function run({ pathname, page, forms, config = {} }) {
	const { win } = fakeWindow({
		serial: true,
		armed: true,
		ports: [{ open: async () => {}, close: async () => {} }],
		pathname,
		forms: Object.values(forms),
		config: { watch: false, hint: false, ...config },
		context: { page, branch: 'FFZG' },
	});
	const m0 = install(win, { boot: fakeBoot([TAG]) });
	return { m0, forms };
}

test('returns.pl: the check-in box is filled, and nothing else on the page', async () => {
	const head = header();
	const checkin = form(`${RUNTIME}/circ/returns.pl`, { fields: { barcode: field({ id: 'barcode' }) } });
	// the header copy must not win just because it comes first in the DOM
	const { m0 } = run({
		pathname: `${RUNTIME}/circ/returns.pl`,
		page: '/intranet/circ/returns.pl',
		forms: { headReturns: head.returns, headRenew: head.renew, checkin },
	});
	await m0.done;

	assert.equal(checkin.elements.barcode.value, '1302079605', 'the box the page posts to got the barcode');
	assert.equal(head.returns.elements.barcode.value, '', 'the header copy was left alone');
	assert.equal(checkin.submits, 0, 'filling is not submitting — that is the librarian\u2019s keypress');
	assert.equal(m0.target().page, 'checkin');
	assert.equal(m0.target().posts, true);
});

test('circulation.pl: three barcode forms, and only the checkout form is touched', async () => {
	const head = header();
	const patron = form(`${RUNTIME}/circ/circulation.pl`, { id: 'patronsearch', fields: { findborrower: field({ id: 'findborrower' }) } });
	const mainform = form(`${RUNTIME}/circ/circulation.pl`, {
		id: 'mainform',
		fields: { barcode: field({ id: 'barcode' }), duedatespec: field({ id: 'duedatespec' }) },
	});
	const { m0 } = run({
		pathname: `${RUNTIME}/circ/circulation.pl`,
		page: '/intranet/circ/circulation.pl',
		forms: { patron, headReturns: head.returns, headRenew: head.renew, mainform },
	});
	await m0.done;

	assert.equal(mainform.elements.barcode.value, '1302079605', 'the checkout box');
	assert.equal(head.returns.elements.barcode.value, '', 'not the returns box on the same page');
	assert.equal(head.renew.elements.barcode.value, '', 'not the renew box on the same page');
	assert.equal(m0.target().page, 'checkout');
	assert.equal(m0.target().posts, false, 'the plugin never posts a checkout — that is what PAGE_TARGETS says');
});

test('circulation.pl with autoCheckin on still does not issue the item', async () => {
	const head = header();
	const mainform = form(`${RUNTIME}/circ/circulation.pl`, { id: 'mainform', fields: { barcode: field({ id: 'barcode' }) } });
	const { m0 } = run({
		pathname: `${RUNTIME}/circ/circulation.pl`,
		page: '/intranet/circ/circulation.pl',
		forms: { headReturns: head.returns, mainform },
		config: { autoCheckin: true },
	});
	await m0.done;

	assert.equal(mainform.elements.barcode.value, '1302079605', 'it fills: the librarian sees what is on the pad');
	assert.equal(mainform.submits, 0, 'it does not submit: autoCheckin is a returns policy');
	assert.equal(head.returns.submits, 0, 'and it certainly does not check the item in from a checkout page');
});

test('a box the page disabled is left alone, and says why', async () => {
	// circulation.tt renders input#barcode disabled while #circ_needsconfirmation waits
	// for "Please confirm checkout" — captured in circulation-pl-checkedout.html
	const mainform = form(`${RUNTIME}/circ/circulation.pl`, {
		id: 'mainform',
		fields: { barcode: field({ id: 'barcode', disabled: true }) },
	});
	const { m0 } = run({
		pathname: `${RUNTIME}/circ/circulation.pl`,
		page: '/intranet/circ/circulation.pl',
		forms: { mainform },
	});
	await m0.done;

	assert.equal(mainform.elements.barcode.value, '', 'typing into a disabled box promises a submit that cannot happen');
	assert.ok(m0.log.some((l) => /disabled/.test(l)), 'the reason is in the log, not hidden');
});

test('renew.pl: the box the librarian can see, not the one in the hidden panel', async () => {
	const hidden = form(`${RUNTIME}/circ/renew.pl`, { fields: { barcode: field({ id: 'ren_barcode' }) } });
	const body = form(`${RUNTIME}/circ/renew.pl`, { fields: { barcode: field({ id: 'barcode' }) } });
	const { m0 } = run({
		pathname: `${RUNTIME}/circ/renew.pl`,
		page: '/intranet/circ/renew.pl',
		forms: { hiddenPanel: hidden, body },
	});
	await m0.done;

	// Both forms post to renew.pl and both fields are named `barcode`; the fixture page
	// puts `id="barcode"` on the visible one, which is what breaks the tie.
	assert.equal(body.elements.barcode.value, '1302079605', 'the fieldset box');
	assert.equal(hidden.elements.barcode.value, '', 'the display:none copy stays empty');
	assert.equal(body.submits, 0, 'renewals stay a human decision too');
	assert.equal(m0.target().page, 'renew');
});

test('a page with no scan box: silence, not a wrong box', async () => {
	const head = header();
	const someother = form(`${RUNTIME}/catalogue/search.pl`, { id: 'cat-search-block', fields: { q: field({ id: 'q' }) } });
	const { m0 } = run({
		pathname: `${RUNTIME}/catalogue/detail.pl`,
		page: '/intranet/catalogue/detail.pl',
		forms: { headReturns: head.returns, headRenew: head.renew, someother },
	});
	await m0.done;

	assert.equal(m0.filled, undefined, 'nothing filled');
	assert.equal(m0.target(), null, 'and the console says why');
	assert.equal(head.returns.elements.barcode.value, '', 'header boxes are not an excuse to act');
});
