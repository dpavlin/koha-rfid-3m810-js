/*
 * One scan, one transaction: the tag is told, the box is filled, the form is posted.
 *
 * These drive `install()` — the wiring, not the parts — because the interesting failures
 * live in the wiring: the write racing the navigation, the book under the head being
 * transacted again on the page that comes back, a patron card being checked in as a book.
 * None of those are visible from a unit test of one function.
 *
 * The reader is a fake that records what was written to it. "The security bit was updated"
 * is only a claim about the reader, so it is measured there.
 *
 *   node --test tests/transaction.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { install } from '../src/core/boot.js';
import { fakeWindow, fakeReader, form, field } from './helpers/fakewindow.mjs';

const RUNTIME = '/cgi-bin/koha';

// D7 on the pad: on loan. Which is what a book at a returns desk is before the desk is done.
const BOOK = {
	sid: 'e00401003123b218',
	content: '1302079605',
	security: 'D7',
	tag_type: 'RFID501',
};
const SECOND = {
	sid: 'e004010031269117',
	content: '1302079606',
	security: 'D7',
	tag_type: 'RFID501',
};
const CARD = {
	sid: 'e004020000000001',
	content: '2000000042',
	security: 'D7',
	tag_type: 'RFID501',
};

const desk = ({
	tags = [],
	box = 'returns',
	config = {},
	session = {},
	failWrites = false,
	writeDelayMs = 0,
	strictWrites = false,
	now = undefined,
	value = '', // what the focused box already holds when the page loads
} = {}) => {
	// One timeline for the reader and the forms: "the tag was written before the page went
	// away" is a fact about order, and two counters that each end at 1 cannot say it.
	const trace = [];
	const reader = fakeReader(
		tags.map((t) => ({ ...t })),
		{ failWrites, trace, writeDelayMs, strictWrites },
	);
	const boxes = {
		returns: form(`${RUNTIME}/circ/returns.pl`, {
			id: 'checkin-form',
			fields: { barcode: field({ id: 'barcode' }) },
			trace,
		}),
		renew: form(`${RUNTIME}/circ/renew.pl`, {
			fields: { barcode: field({ id: 'barcode' }) },
			trace,
		}),
		issue: form(`${RUNTIME}/circ/circulation.pl`, {
			id: 'mainform',
			fields: { barcode: field({ id: 'barcode' }) },
			trace,
		}),
		patron: form(`${RUNTIME}/circ/circulation.pl`, {
			id: 'patronsearch',
			fields: {
				findborrower: field({ id: 'findborrower', name: 'findborrower' }),
			},
			trace,
		}),
		// The header quick-box: same transaction as `returns`, on a page that has no box of
		// its own. Alt+R focuses this one from anywhere.
		header: form(`${RUNTIME}/circ/returns.pl`, {
			fields: { barcode: field({ id: 'ret_barcode' }) },
			trace,
		}),
		catalog: form(`${RUNTIME}/catalogue/search.pl`, {
			id: 'cat-search-block',
			fields: { q: field({ id: 'search-form', name: 'q' }) },
			trace,
		}),
	};
	const focused = boxes[box].elements.barcode || boxes[box].elements.findborrower || boxes[box].elements.q;
	if (focused) focused.value = value;
	const { win, elements } = fakeWindow({
		serial: true,
		armed: true,
		ports: [{}],
		forms: Object.values(boxes),
		focus: focused,
		session,
		config: { watch: false, bookPrefix: '130', ...config },
	});
	const m0 = install(win, { boot: reader.installer(), ...(now ? { now } : {}) });
	return {
		m0,
		reader,
		trace,
		win,
		boxes,
		elements,
		focused,
		session: win.sessionStorage.data,
	};
};

// act() writes to the tag and then posts, so the assertions need the promise chain to be
// done. A macrotask boundary is enough, and is honest: nothing here waits on a timer.
const settled = async (n = 3) => {
	for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 1));
};

test('a scan in the returns box: the tag is told, the box filled, the form posted', async () => {
	const d = desk({ tags: [BOOK] });
	await d.m0.done;
	await settled();

	assert.deepEqual(d.reader.writes, [{ sid: BOOK.sid, afi: 0xda, hex: 'DA' }], 'D7 -> DA, at the reader');
	assert.equal(d.boxes.returns.elements.barcode.value, BOOK.content, 'the barcode is in the box');
	assert.equal(d.boxes.returns.submits, 1, 'and it went in');
	assert.equal(d.focused.focusCalls, 1, 'the box was focused, so a second scan by hand is visible');
});

test('a tag that already says the right thing is not written to', async () => {
	const d = desk({ tags: [{ ...BOOK, security: 'DA' }] });
	await d.m0.done;
	await settled();

	assert.deepEqual(d.reader.writes, [], 'no write, no wear on the tag');
	assert.equal(d.boxes.returns.submits, 1, 'and still checked in');
});

test('a header box posts the same transaction', async () => {
	// This is the page the old design could not see: mainpage.pl has no returns form of its
	// own, only the header one that Alt+R focuses.
	const d = desk({ tags: [BOOK], box: 'header' });
	await d.m0.done;
	await settled();

	assert.equal(d.boxes.header.submits, 1);
	assert.deepEqual(d.reader.writes, [{ sid: BOOK.sid, afi: 0xda, hex: 'DA' }]);
});

test('the same book is not transacted twice while it stays on the pad', async () => {
	// The reload is the hazard: the page comes back, the book has not been picked up yet,
	// and a plugin with no memory posts it again — every second, forever.
	const d = desk({ tags: [BOOK] });
	await d.m0.done;
	await settled();

	await d.m0.act({ replaceStale: true });
	await d.m0.act({ replaceStale: true });
	await settled();

	assert.equal(d.boxes.returns.submits, 1, 'one post');
	assert.equal(d.reader.writes.length, 1, 'one write');
	assert.match(JSON.stringify(d.m0.posted()), new RegExp(BOOK.content), 'the memory says why');
});

test('the next page load does not post it either', async () => {
	// sessionStorage is the whole trick: the same tab, a new page, the same book.
	const session = {};
	const first = desk({ tags: [BOOK], session });
	await first.m0.done;
	await settled();
	assert.equal(first.boxes.returns.submits, 1);

	const second = desk({ tags: [BOOK], session });
	await second.m0.done;
	await settled();

	assert.equal(second.boxes.returns.submits, 0, 'not again');
	assert.equal(second.boxes.returns.elements.barcode.value, '', 'and the box is left empty for the next book');
});

test('a stack of books is a queue, and taking one off hands the next its turn', async () => {
	const d = desk({ tags: [BOOK, SECOND] });
	await d.m0.done;
	await settled();

	assert.equal(d.boxes.returns.submits, 1, 'one book per page load');
	assert.equal(d.boxes.returns.elements.barcode.value, BOOK.content, 'the first one');

	d.reader.take(BOOK.sid); // the librarian put it on the trolley
	// The plugin only knows the pad it last saw, and the watch is off in these tests, so the
	// rescan affordance is what notices. It is also the honest sequence: a book leaving the
	// pad is a change, and a stale box may be written over only once it is stale.
	await d.m0.rescan();
	await settled();

	assert.equal(d.boxes.returns.submits, 2, 'the next one goes in');
	assert.equal(d.boxes.returns.elements.barcode.value, SECOND.content);
	assert.equal(d.reader.writes.length, 2, 'and its tag was told too');
});

test('a renewal corrects a book that still says it is in the library', async () => {
	// The reason renew is in the table at all: a book being renewed that reads "in library"
	// was never properly issued, and a renewal is the moment it is lying on a reader.
	const d = desk({ tags: [{ ...BOOK, security: 'DA' }], box: 'renew' });
	await d.m0.done;
	await settled();

	assert.deepEqual(d.reader.writes, [{ sid: BOOK.sid, afi: 0xd7, hex: 'D7' }]);
	assert.equal(d.boxes.renew.submits, 1);
});

test('a book that is already out is renewed without being written to', async () => {
	const d = desk({ tags: [BOOK], box: 'renew' });
	await d.m0.done;
	await settled();

	assert.deepEqual(d.reader.writes, []);
	assert.equal(d.boxes.renew.submits, 1);
});

test('a card is not a book, and the returns box knows it', async () => {
	const d = desk({ tags: [CARD] });
	await d.m0.done;
	await settled();

	assert.equal(d.boxes.returns.submits, 0, 'not checked in');
	assert.deepEqual(d.reader.writes, [], 'and its tag is nobody’s business');
	assert.equal(d.boxes.returns.elements.barcode.value, '');
});

test('the same card in the patron box is a patron', async () => {
	const d = desk({ tags: [CARD], box: 'patron' });
	await d.m0.done;
	await settled();

	assert.equal(d.boxes.patron.submits, 1, 'the search ran');
	assert.deepEqual(d.reader.writes, [], 'and no tag was written');
});

test('the checkout box issues, and leaves the tag on loan', async () => {
	const d = desk({ tags: [{ ...BOOK, security: 'D7' }], box: 'issue' });
	await d.m0.done;
	await settled();

	assert.equal(d.boxes.issue.submits, 1);
	assert.deepEqual(d.reader.writes, [], 'on loan already: nothing to change');
});

test('a book coming in from the header while the page is a checkout page is a check-in', async () => {
	// The three boxes on one page, told apart by where they post.
	const d = desk({ tags: [BOOK], box: 'header' });
	await d.m0.done;
	await settled();

	assert.equal(d.boxes.issue.submits, 0, 'not an issue');
	assert.equal(d.boxes.header.submits, 1);
});

test('a cursor that is not in one of our boxes means nothing happens', async () => {
	const d = desk({ tags: [BOOK], box: 'catalog' });
	await d.m0.done;
	await settled();

	assert.equal(d.boxes.returns.submits, 0);
	assert.deepEqual(d.reader.writes, []);
	assert.equal(d.m0.target(), null, 'and the console says so');
});

test('autoSubmit: false fills and stops, without posting or forgetting', async () => {
	const d = desk({ tags: [BOOK], config: { autoSubmit: false } });
	await d.m0.done;
	await settled();

	assert.equal(d.boxes.returns.elements.barcode.value, BOOK.content, 'filled');
	assert.equal(d.boxes.returns.submits, 0, 'Return is the librarian’s to press');
	assert.deepEqual(d.m0.posted(), {}, 'nothing was posted, so nothing is remembered');
	assert.deepEqual(d.reader.writes, [{ sid: BOOK.sid, afi: 0xda, hex: 'DA' }], 'the tag was still told');
});

test('securityBit: false reads tags and never changes them', async () => {
	const d = desk({ tags: [BOOK], config: { securityBit: false } });
	await d.m0.done;
	await settled();

	assert.deepEqual(d.reader.writes, []);
	assert.equal(d.boxes.returns.submits, 1, 'the transaction is still what was asked for');
});

test('fill: false leaves the page alone', async () => {
	const d = desk({ tags: [BOOK], config: { fill: false } });
	await d.m0.done;
	await settled();

	assert.equal(d.boxes.returns.elements.barcode.value, '');
	assert.equal(d.boxes.returns.submits, 0);
});

test('a write that fails still transacts, and the pill keeps telling the truth', async () => {
	// The tag is the slower half of the transaction, and it can fail (the book shifted an
	// inch). Koha still gets the return, because that is what the librarian asked for; the
	// state shown afterwards is the one the tag reported, not the one we wanted.
	const d = desk({ tags: [BOOK], failWrites: true });
	await d.m0.done;
	await settled();

	assert.equal(d.boxes.returns.submits, 1, 'the check-in is not held hostage to a bit');
	assert.equal(d.m0.tags[0].security, 'D7', 'shown as still on loan, which is what the tag says');
	assert.ok(
		d.elements[0].children.map((c) => c.textContent).includes(`${BOOK.content} OUT`),
		`the chip says OUT, not the IN we wanted: ${d.elements[0].textContent}`,
	);
	assert.ok(
		d.m0.log.some((l) => /security bit NOT written/.test(l)),
		'and the failure is in the log',
	);
});

test('what the plugin wrote is what the pill shows next time it paints', async () => {
	const d = desk({ tags: [BOOK] });
	await d.m0.done;
	await settled();

	const chips = d.elements[0].children.map((c) => c.textContent);
	assert.ok(chips.includes(`${BOOK.content} IN`), `in library after the write: ${chips}`);
});

// --- the ordering, the races, and the memory's expiry -------------------------------
// Everything above asks *what* happened. These ask *when*, because the design decision
// this whole file rests on is a when: the tag is written before the page navigates, since
// navigating closes the serial port and a write still in flight is a book silently left on
// loan. Two counters that both end at 1 cannot tell you that; one timeline can.

test('the tag is written, then the page is posted — in that order', async () => {
	const d = desk({ tags: [BOOK] });
	await d.m0.done;
	await settled();

	assert.deepEqual(d.trace, [`write:${BOOK.sid.slice(-4)}`, 'submit:checkin-form'], d.trace.join(' , '));
});

test('a slow write holds the post; it does not race it', async () => {
	const d = desk({ tags: [BOOK], writeDelayMs: 40 });
	await d.m0.done;
	await settled(); // the write is still open 40ms away

	assert.equal(d.boxes.returns.submits, 0, 'nothing posted while the tag is still being told');
	assert.equal(d.boxes.returns.elements.barcode.value, BOOK.content, 'the box is filled already');

	await new Promise((r) => setTimeout(r, 60));
	assert.equal(d.boxes.returns.submits, 1, 'and it goes in once the reader has answered');
	assert.deepEqual(d.trace, [`write:${BOOK.sid.slice(-4)}`, 'submit:checkin-form']);
});

test('a book that left the pad mid-write is still returned, and the log says the bit was not told', async () => {
	const d = desk({ tags: [BOOK], writeDelayMs: 30, strictWrites: true });
	await new Promise((r) => setTimeout(r, 5)); // the act is in flight, the write has not run
	d.reader.take(BOOK.sid); // the librarian picked the book up
	await new Promise((r) => setTimeout(r, 60));

	assert.deepEqual(d.reader.writes, [], 'the write never landed');
	assert.equal(d.boxes.returns.submits, 1, 'Koha decides whether that barcode is a return, not us');
	assert.ok(
		d.m0.log.some((l) => /write|bit/i.test(l) && /tag moved out of range/.test(l)),
		`the failure is in the log: ${d.m0.log.slice(-4).join(' | ')}`,
	);
});

test('the posted memory expires, so a stuck tag cannot block the desk forever', async () => {
	const stale = { rfid_posted: JSON.stringify({ [`checkin:${BOOK.content}`]: Date.now() - 60_000 }) };
	const d = desk({ tags: [BOOK], session: stale, config: { postedTtl: 45 } });
	await d.m0.done;
	await settled();

	assert.equal(d.boxes.returns.submits, 1, '60s old with a 45s memory: it is a new scan again');
});

test('a box that already holds a barcode still under the head is left alone', async () => {
	const d = desk({ tags: [BOOK], value: BOOK.content });
	await d.m0.done;
	await settled();

	assert.equal(d.boxes.returns.submits, 0, 'a value the librarian typed is a transaction in progress');
	assert.deepEqual(d.reader.writes, [], 'and the tag under the head is not told anything either');
});

test('two acts at once are one transaction, not two posts of the same page', async () => {
	const d = desk({ tags: [], writeDelayMs: 30 });
	await d.m0.done;

	// A stack shifting under the head: the watch fires again while the first book's write is
	// still open. Two posts of the same page load is a double transaction, not two.
	d.reader.put({ ...BOOK });
	await d.m0.rescan(); // a scan returns immediately; the act it starts is still in flight
	await new Promise((r) => setTimeout(r, 5));
	d.reader.put({ ...SECOND });
	await d.m0.rescan();
	await new Promise((r) => setTimeout(r, 60));

	assert.equal(d.boxes.returns.submits, 1, `one page load, one transaction: ${d.trace.join(' , ')}`);
	assert.equal(d.boxes.returns.elements.barcode.value, BOOK.content, 'the book that landed first');
});
