/*
 * The programming panel: what it offers, and what it refuses to do without being made to.
 *
 * The guard is tested in tagwrite.test.mjs; these tests are about the second line of
 * defence — the one a librarian looks at. Two claims matter and everything else is styling:
 *
 *   - the panel can only ever write the barcode the page resolved, and says which one;
 *   - overwriting a different barcode requires the tag to leave the pad and come back,
 *     so a click is never enough to lose a book's barcode.
 *
 * `install()` is used once, to prove the wiring (the panel exists on moredetail.pl and
 * nowhere else); the rest drives `installPanel` with a small reader-shaped stand-in, so a
 * test can say "the pad went empty, then this tag came back" without simulating a wire.
 *
 *   node --test tests/panel.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { install } from '../src/core/boot.js';
import { installPanel } from '../src/core/panel.js';
import { fakeWindow } from './helpers/fakewindow.mjs';

const MOREDETAIL = '/cgi-bin/koha/catalogue/moredetail.pl';
const BARCODE = '1305271134';
const ITEM = { ok: true, itemnumber: 561408, barcode: BARCODE, callnumber: 'CC01.2 BIO' };

const tag = (content, sid = 'e00401003123b218', security = 'DA') => ({ sid, content, security });

/** An m0 shaped like the real one, with the pad and the two writes a panel can ask for. */
function fakeM0({ tags = [], gate = 'ready', programming = true } = {}) {
	const m0 = {
		gate,
		tags,
		programs: [],
		writes: [],
		called: [],
		onpaint(fn) {
			m0.painters.push(fn);
			return () => m0.painters.splice(m0.painters.indexOf(fn), 1);
		},
		painters: [],
		pad(next) {
			m0.tags = next;
			for (const fn of m0.painters) fn(); // what boot's paint loop does
		},
		async program(sid, content, opts = {}) {
			m0.called.push({ sid, content, opts });
			// The shape programTag returns: `from` is what the tag held, `content` is what the
			// tag says after the write, read back rather than echoed. The panel prints both, so a
			// fake that invented its own field names would pass while the panel showed undefined.
			const entry = {
				at: 0,
				sid,
				from: (m0.tags.find((t) => t.sid === sid) || {}).content || '',
				to: content,
				content,
				blocks: '04110001 31333035',
				afi: 'DA',
				verified: true,
				empty: false,
				error: null,
			};
			if (!programming) entry.error = 'tag programming is off for this installation';
			m0.programs.push(entry);
			if (!entry.error) m0.pad([tag(content, sid)]);
			return entry;
		},
		async readTag(sid) {
			m0.reads = (m0.reads || 0) + 1;
			return {
				content: (m0.tags.find((t) => t.sid === sid) || {}).content || '',
				secure: true,
				itemType: 'Book',
			};
		},
	};
	return m0;
}

/** A moredetail page: window with the item the server resolved, plus the dead F4 notices. */
function page({ item = ITEM, notices = 2 } = {}) {
	const { win, elements } = fakeWindow({ pathname: MOREDETAIL });
	if (item) win.RFID_ITEM = item;
	for (let i = 0; i < notices; i++) {
		const n = win.document.createElement('div');
		n.className = 'dialog message';
		n.textContent = 'Press F4 to add RFID tag.';
		n.style.display = 'block';
	}
	return { win, elements };
}

const panel = ({ win, m0, cfg = { programming: true } }) => {
	const p = installPanel({ win, m0, cfg, note: () => {} });
	if (!p) return null;
	p.text = () => p.el.textContent;
	p.buttonWith = (needle) => p.el.children.find((c) => c.tag === 'button' && c.textContent.includes(needle));
	// Found by id, not by label: the label is the thing that changes with the state, and a
	// test that hunts for "Program" cannot tell a missing button from a renamed one.
	p.writeBtn = () => p.el.children.find((c) => c.id === 'rfid-write');
	p.readBtn = () => p.el.children.find((c) => c.id === 'rfid-read');
	return p;
};

const click = (b) => b.dispatch('click', {});
const settled = () => new Promise((r) => setImmediate(r));

test('the panel appears on moredetail.pl and nowhere else', () => {
	// A browser without Web Serial gets no panel either — that is decision 5, and it is why
	// both windows here have to be told the browser is Chrome: otherwise this test passes for
	// the wrong reason.
	const here = fakeWindow({ pathname: MOREDETAIL, serial: true, config: { programming: true } });
	here.win.RFID_ITEM = ITEM;
	install(here.win);
	assert.ok(
		here.elements.some((n) => n.id === 'rfid-program'),
		'a page that can program a tag shows how',
	);

	const elsewhere = fakeWindow({
		pathname: '/cgi-bin/koha/circ/returns.pl',
		serial: true,
		config: { programming: true },
	});
	install(elsewhere.win);
	assert.ok(!elsewhere.elements.some((n) => n.id === 'rfid-program'), 'a circulation page gets no panel');
});

test('the capability stays with the installation: no programming, no panel', () => {
	const { win } = page();
	const m0 = fakeM0();
	assert.equal(installPanel({ win, m0, cfg: { programming: false } }), null);
});

test('a page that resolved no item says so, and offers no write', () => {
	const { win } = page({ item: null });
	const p = panel({ win, m0: fakeM0() });
	assert.match(p.text(), /did not say which item/);
	assert.equal(p.buttonWith('Program'), undefined, 'nothing to write, so no button to write it');
});

test('a page with several items explains itself instead of guessing', () => {
	const { win } = page({
		item: { ok: false, why: 'several items on this biblio — open the single-item view to tag one', count: 805 },
	});
	const p = panel({ win, m0: fakeM0({ tags: [tag('')] }) });
	assert.match(p.text(), /cannot program from this page: several items/);
	assert.equal(p.buttonWith('Program'), undefined);
});

test('a blank tag is programmed in one press, and the result read back is shown', async () => {
	const { win } = page();
	const m0 = fakeM0({ tags: [tag('')] });
	const p = panel({ win, m0 });

	assert.match(p.text(), /1305271134, CC01.2 BIO/, 'the barcode and call number of the item on screen');
	assert.match(p.text(), /\(blank tag\)/, 'and what the tag says now');

	click(p.writeBtn());
	await settled();

	assert.deepEqual(
		m0.called.map((c) => [c.content, c.opts]),
		[[BARCODE, {}]],
		'a fresh tag needs no confirmation',
	);
	assert.match(p.text(), /wrote 1305271134 — read back and verified \(DA\)/);
});

test('the panel writes only the page barcode: it is never given a barcode to type', () => {
	const { win } = page();
	const m0 = fakeM0({ tags: [tag('')] });
	const p = panel({ win, m0 });
	assert.ok(!p.el.children.some((c) => c.tag === 'input' || c.tag === 'textarea'), 'no field, no typing');
	assert.equal(p.writeBtn().textContent, `Program ${BARCODE}`, 'the button says out loud what it will write');
});

test('overwriting another barcode needs the tag lifted and put back', async () => {
	const onPad = tag('1302079605'); // a different book, lying under the head
	const { win } = page();
	const m0 = fakeM0({ tags: [onPad] });
	const p = panel({ win, m0 });

	assert.match(p.text(), /1302079605 IN/, 'shown in red by the tone, and in text');

	click(p.writeBtn());
	await settled();
	assert.deepEqual(m0.called, [], 'the first press writes nothing at all');
	assert.match(p.text(), /lift the tag off the pad and put it back/);
	assert.equal(p.writeBtn().disabled, true, 'the button is disabled until the tag moves');
	assert.match(p.writeBtn().textContent, /Waiting: lift the tag/);

	m0.pad([]); // taken off the antenna
	assert.match(p.text(), /no tag on the pad/);
	m0.pad([onPad]); // and put back, which is the confirmation

	assert.equal(
		p.writeBtn().textContent,
		`Overwrite 1302079605 \u2192 ${BARCODE}`,
		'the button now says what it is about to destroy',
	);
	assert.equal(p.writeBtn().disabled, false, 'and it is pressable: the confirm has been earned');

	click(p.writeBtn());
	await settled();
	assert.deepEqual(
		m0.called.map((c) => [c.content, c.opts.confirm]),
		[[BARCODE, '1302079605']],
		'the write carries the barcode the tag held, which is what the guard asks for',
	);
});

test('a different tag under the head spends nothing', async () => {
	const wanted = tag('1302079605');
	const other = tag('1309999999', 'e004010031269117');
	const { win } = page();
	const m0 = fakeM0({ tags: [wanted] });
	const p = panel({ win, m0 });

	click(p.writeBtn());
	await settled();

	m0.pad([]);
	m0.pad([other]); // somebody else's book, put down in its place

	click(p.writeBtn());
	await settled();
	assert.deepEqual(m0.called, [], 'the confirm was armed for a different tag');
	assert.match(p.text(), /a different tag is under the head|the tag has not left the pad/);
});

test('two tags on the pad is refused rather than resolved by whichever came first', async () => {
	const { win } = page();
	const m0 = fakeM0({ tags: [tag('1302079605'), tag('', 'e004010031269117')] });
	const p = panel({ win, m0 });
	assert.match(p.text(), /2 tags \(one at a time\)/);

	click(p.writeBtn());
	await settled();
	assert.deepEqual(m0.called, []);
	assert.match(p.text(), /2 tags on the pad — one at a time, please/);
});

test('with no reader the panel still explains the one thing that is missing', () => {
	const { win } = page();
	const p = panel({ win, m0: fakeM0({ tags: [], gate: 'needs-grant' }) });
	assert.match(p.text(), /reader not connected — Ctrl\+Alt\+R/);
});

test('Read tag reads, and does not write', async () => {
	const { win } = page();
	const m0 = fakeM0({ tags: [tag('1302079605')] });
	const p = panel({ win, m0 });

	click(p.readBtn());
	await settled();

	assert.equal(m0.reads, 1);
	assert.deepEqual(m0.called, [], 'reading a tag writes nothing');
	assert.match(p.text(), /tag reads: 1302079605 — in library — Book/);
});

test('the dead "Press F4" notices go away when something real takes their place', () => {
	const { win } = page({ notices: 2 });
	panel({ win, m0: fakeM0({ tags: [tag('')] }) });
	const notices = win.document.querySelectorAll('div.dialog.message');
	assert.equal(notices.length, 2, 'the page does have them');
	assert.deepEqual(
		notices.map((n) => n.style.display),
		['none', 'none'],
		'hidden, because F4 does nothing in this build',
	);
});

test('a panel that cannot render says so in its own box instead of taking the page', () => {
	const { win } = page();
	const m0 = fakeM0();
	const p = panel({ win, m0 });
	// Whatever breaks the next paint, the box admits it and the item line survives to the
	// paint after: a dead panel must not become a dead catalogue page.
	Object.defineProperty(m0, 'tags', {
		configurable: true,
		get() {
			throw new Error('pad exploded');
		},
	});
	assert.doesNotThrow(() => p.render(), 'the exception stays inside the panel');
	assert.match(p.text(), /RFID panel failed: pad exploded/);
});
