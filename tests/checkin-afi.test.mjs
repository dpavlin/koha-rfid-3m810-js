/*
 * The whole check-in, on the fake window: pad → post → reload → verdict → tag.
 *
 * security.test.mjs holds the machine apart; this one runs `install()` the way a page
 * does, because the ordering that matters lives in the wiring: the write is remembered
 * before the form navigates, it waits for the verdict that only the next page can read,
 * and it is the reader — not the plugin's good intentions — that is told last.
 *
 * Three page loads, three outcomes: the book is still on the pad (write it), the book is
 * gone (say so, loudly, after the grace), and Koha refused (say nothing, write nothing).
 *
 *   node --test tests/checkin-afi.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { install } from '../src/core/boot.js';
import { fakeWindow, form, field } from './helpers/fakewindow.mjs';
import { returnsPage, noTablePage } from './helpers/returnsdom.mjs';

const BARCODE = '1302079605';
const SID = 'e004010031269117';
const DA = 0xda;

const onPad = (security = 'D7') => [{ sid: SID, content: BARCODE, security, tag_type: 'RFID501' }];

/** The settle a real page gets for free: the write is fired off, not awaited by anyone. */
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * One page load at one desk. `session` is the tab: pass the previous page's and the
 * owed-write store comes with it, which is the entire point of putting it in sessionStorage.
 */
function desk({ doc = noTablePage, tags = [], session = null, config = {}, afi = [] }) {
	const returns = form('/cgi-bin/koha/circ/returns.pl', { fields: { barcode: field({ id: 'barcode' }) } });
	const { win, elements, timers } = fakeWindow({
		serial: true,
		armed: true,
		ports: [{}, {}],
		forms: [returns],
		config: { autoCheckin: true, watch: false, debug: true, ...config },
	});
	if (session) win.sessionStorage.data = session;
	// returns.pl's answer is read out of the document, so the fake has to carry the table.
	win.document.querySelectorAll = (sel) => doc.querySelectorAll(sel);
	win.document.querySelector = (sel) => doc.querySelector(sel);

	// The pad, as the reader would report it: `putBack()` is the librarian setting the
	// book down again, and `m0.rescan()` is the plugin noticing it — the same path the
	// watch takes on a real page.
	const pad = [...tags];
	const m0 = install(win, {
		boot: async () => ({
			out: { opened: true, readerVersion: '10.5.0.2', tags, error: null },
			reader: {
				async writeAfi(sid, byte) {
					afi.push({ sid, afi: byte });
				},
				async scan() {
					return { tags: pad.map((t) => ({ ...t })) };
				},
				async inventory() {
					return pad.map((t) => t.sid);
				},
			},
			transport: {},
		}),
	});
	const putBack = (...back) => (pad.length = 0, pad.push(...back));
	return { win, m0, returns, afi, elements, timers, putBack, session: win.sessionStorage.data };
}

const owedOf = (session) => JSON.parse(session.rfid_afi || '{}');
const textOf = (n) => [n.text, ...n.children.map(textOf)].filter(Boolean).join('\n');

test('posting a check-in owes the tag a DA, and remembers the AFI it read', async () => {
	const { win, m0, returns, session } = desk({ tags: onPad() });
	await m0.done;

	assert.equal(returns.submits, 1, 'the form went in');
	assert.deepEqual(Object.keys(owedOf(session)), [BARCODE]);
	assert.deepEqual(
		{ ...owedOf(session)[BARCODE], at: 0, confirmedAt: 0 },
		{ sid: SID.toUpperCase(), from: 'D7', to: DA, at: 0, confirmedAt: 0 },
		'what it was, what it must become, and nothing written yet',
	);
});

test('the next page says it worked, and the tag on the pad is told', async () => {
	const first = desk({ tags: onPad() });
	await first.m0.done;

	const afi = [];
	const second = desk({ doc: returnsPage('checkedin-returned.html'), tags: onPad(), session: first.session, afi });
	await second.m0.done;
	await settle();

	assert.deepEqual(afi, [{ sid: SID.toUpperCase(), afi: DA }], 'one AFI write, after the verdict');
	assert.deepEqual(Object.keys(owedOf(second.session)), [], 'and nothing is owed any more');
	assert.deepEqual(second.returns.submits, 0, 'the barcode was handled; it is not posted twice');
});

test('a refusal writes nothing and makes no noise', async () => {
	const first = desk({ tags: onPad() });
	await first.m0.done;

	const afi = [];
	const second = desk({
		doc: returnsPage('checkedin-not-checked-out.html'),
		tags: [], // and the librarian has already walked off with it
		session: first.session,
		afi,
		config: { securityGraceMs: 1 },
	});
	await second.m0.done;
	await settle(40);

	assert.deepEqual(afi, [], 'Koha did not take the return, so the tag keeps its bits');
	assert.deepEqual(Object.keys(owedOf(second.session)), [], 'and the debt is cancelled, not carried');
	assert.equal(second.elements.filter((n) => n.id === 'rfid-alert').length, 0, 'no alarm for a refusal');
});

test('a confirmed check-in whose tag left the pad covers the screen', async () => {
	const first = desk({ tags: onPad() });
	await first.m0.done;

	const afi = [];
	const second = desk({
		doc: returnsPage('checkedin-returned.html'),
		tags: [], // carried away while the page was reloading
		session: first.session,
		afi,
		config: { securityGraceMs: 5 },
	});
	await second.m0.done;
	await settle(60);

	const alarm = second.elements.find((n) => n.id === 'rfid-alert');
	assert.ok(alarm, 'the takeover exists');
	assert.equal(alarm.style.display, 'flex', 'and it is covering the page');
	assert.equal(alarm.attrs.role, 'alertdialog');
	assert.match(textOf(alarm), new RegExp(BARCODE));
	assert.match(textOf(alarm), /left at D7/);
	assert.deepEqual(afi, [], 'nothing was written — the tag is not in range');
	assert.ok(second.timers.intervals.length >= 2, 'beeping and a moving title bar were scheduled');
});

test('the book goes back on the reader and the screen comes down', async () => {
	const first = desk({ tags: onPad() });
	await first.m0.done;

	const afi = [];
	const second = desk({
		doc: returnsPage('checkedin-returned.html'),
		tags: [],
		session: first.session,
		afi,
		config: { securityGraceMs: 5 },
	});
	await second.m0.done;
	await settle(60);
	assert.equal(second.elements.find((n) => n.id === 'rfid-alert').style.display, 'flex');


	second.putBack(...onPad('D7'));
	await second.m0.rescan(); // "I put it back on" — Ctrl+Alt+R, or the watch noticing
	await settle();
	assert.deepEqual(afi, [{ sid: SID.toUpperCase(), afi: DA }], 'written as soon as it was back');
	assert.equal(second.elements.find((n) => n.id === 'rfid-alert').style.display, 'none', 'screen down');
	assert.ok(second.timers.cleared.length, 'and the beeping was actually stopped, not left running');
	assert.deepEqual(second.m0.tagWrites(), [], 'nothing owed');
});
