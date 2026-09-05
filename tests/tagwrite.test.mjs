/*
 * The write guard, tested instead of trusted.
 *
 * programTag() writes to a physical object, so these tests are mostly about the
 * calls it refuses to make. A fake tag stores what it was told and reads it back
 * through the real 501 encoder/decoder, so "verified" means the round trip worked,
 * not that the writer said so.
 *
 *   node --test tests/tagwrite.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { guard, programTag, readTag } from '../src/core/tagwrite.js';
import { encode501 } from '../src/driver/rfid3m.js';

const BOOK = 'e004010031269117';
const CARD = 'e00401001f77fb98';
const NEW = 'e00401000a110a11';

const pad = () => [
	{ sid: BOOK, content: '1302099999' },
	{ sid: CARD, content: '200000000042' },
	{ sid: NEW, content: '' },
];

function fakeTag({ content = '', afi = 0xda, fail = false } = {}) {
	const state = {
		blocks: content ? encode501({ content }) : new Uint8Array(32),
		afi,
		fail,
		writes: [],
	};
	const reader = {
		state,
		async program(list) {
			for (const op of list) {
				state.writes.push(op);
				if (state.fail) continue;
				if (op.content.toLowerCase() === 'blank') {
					state.blocks = new Uint8Array(32);
					state.afi = 0xd7;
				} else {
					state.blocks = encode501({ content: op.content });
					state.afi = op.content.startsWith('130') ? 0xda : 0xd7;
				}
			}
			return state.fail ? { ok: 0, errors: ['simulated block write failure'] } : { ok: 1, errors: [] };
		},
		async readAfi() {
			return state.afi;
		},
		async readBlocks(sid, start, count) {
			const out = [];
			for (let i = 0; i < count; i++) out.push(state.blocks.subarray((start + i) * 4, (start + i) * 4 + 4));
			return out;
		},
	};
	return reader;
}

test('a tag that is not on the pad cannot be written', async () => {
	const r = await programTag({
		reader: fakeTag(),
		tags: pad(),
		sid: 'e004010012345678',
		content: '1309999998',
	});
	assert.equal(r.verified, false);
	assert.match(r.error, /not on the pad/);
});

test('a malformed sid is refused before anything is sent', async () => {
	assert.match(guard({ tags: pad(), sid: 'e0040100312691', content: 'x' }).error, /16 hex digits/);
	assert.match(guard({ tags: pad(), sid: 'zz04010031269117', content: 'x' }).error, /16 hex digits/);
});

test('overwriting a patron card needs the card barcode repeated exactly', async () => {
	const why = /not a book barcode/;
	assert.match(guard({ tags: pad(), sid: CARD, content: '1309999998' }).error, why);
	assert.match(
		guard({
			tags: pad(),
			sid: CARD,
			content: '1309999998',
			confirm: '20000000004',
		}).error,
		why,
		'a typo is not confirmation',
	);
	assert.ok(
		guard({
			tags: pad(),
			sid: CARD,
			content: '1309999998',
			confirm: '200000000042',
		}).ok,
	);
});

test('a different book on the tag is refused until its own barcode is repeated', () => {
	// The accident that happens at a real desk: the page shows one item while another lies
	// under the head. Both barcodes begin with the book prefix, so the rule this replaces —
	// anything inside bookPrefix may be overwritten — saw nothing to object to.
	const why = /a different book than "1305271134"/;
	assert.match(guard({ tags: pad(), sid: BOOK, content: '1305271134' }).error, why);
	assert.match(
		guard({ tags: pad(), sid: BOOK, content: '1305271134', confirm: '1305271135' }).error,
		why,
		'the barcode you meant to write is not confirmation either',
	);
	assert.ok(guard({ tags: pad(), sid: BOOK, content: '1305271134', confirm: '1302099999' }).ok);
});

test('writing the same barcode again is not a change, so it asks nothing', () => {
	// "Did that take?" is answered by doing it again; a confirm step here would train people
	// to click through the one that matters.
	assert.ok(guard({ tags: pad(), sid: BOOK, content: '1302099999' }).ok);
});

test('erasing a written tag is a change, so it asks as well', () => {
	const tags = [{ sid: NEW, content: '1309999998' }];
	assert.match(guard({ tags, sid: NEW, content: 'blank' }).error, /repeat that barcode to erase it/);
	assert.ok(guard({ tags, sid: NEW, content: 'blank', confirm: '1309999998' }).ok);
	assert.ok(guard({ tags: pad(), sid: NEW, content: 'blank' }).ok, 'a blank tag stays free');
});

test('a barcode already lying next to it is refused', async () => {
	const g = guard({ tags: pad(), sid: NEW, content: '1302099999' });
	assert.equal(g.ok, false);
	assert.match(g.error, /already on the pad \(e004010031269117\)/);
});

test('16 printable ASCII bytes is the whole tag', async () => {
	assert.match(guard({ tags: pad(), sid: NEW, content: '1'.repeat(17) }).error, /RFID501 holds 16/);
	assert.match(guard({ tags: pad(), sid: NEW, content: '130\u010d' }).error, /printable ASCII/);
	assert.match(guard({ tags: pad(), sid: NEW, content: '' }).error, /no content/);
	assert.ok(guard({ tags: pad(), sid: NEW, content: '1'.repeat(16) }).ok);
});

test('writing a book barcode to a blank tag verifies against the tag itself', async () => {
	const reader = fakeTag();
	const entry = await programTag({
		reader,
		tags: pad(),
		sid: NEW,
		content: '1309999998',
	});

	assert.equal(entry.error, null);
	assert.equal(entry.verified, true, 'read back from the tag, not assumed');
	assert.equal(entry.content, '1309999998');
	assert.equal(entry.afi, 'DA', 'a book goes down secured');
	assert.equal(entry.from, '');
	assert.match(entry.blocks, /^04110001 31333039/, 'block 0 says 1 of 1, Book; block 1 is "1309"');
});

test('blanking is programming with the empty pattern, and reads back empty', async () => {
	const reader = fakeTag({ content: '1309999998' });
	const entry = await programTag({
		reader,
		tags: [{ sid: NEW, content: '1309999998' }],
		sid: NEW,
		content: 'blank',
		confirm: '1309999998',
	});

	assert.equal(entry.verified, true);
	assert.equal(entry.content, '');
	assert.equal(entry.afi, 'D7');
	assert.equal(entry.empty, true);
	assert.deepEqual(
		reader.state.writes.map((w) => w.content),
		['blank'],
	);
});

test('a blank that leaves the tail of the old barcode is not "verified"', async () => {
	// The 12-byte blank payload inherited from the Go client, replayed: blocks 0-2
	// zeroed, blocks 3-4 still holding the previous barcode.
	const reader = fakeTag({ content: '1309999999' });
	reader.program = async () => {
		const tail = [...reader.state.blocks.subarray(12, 20)];
		reader.state.blocks = new Uint8Array(32);
		reader.state.blocks.set(new Uint8Array(tail), 12);
		reader.state.afi = 0xd7;
		return { ok: 1, errors: [] };
	};

	const entry = await programTag({
		reader,
		tags: [{ sid: NEW, content: '1309999999' }],
		sid: NEW,
		content: 'blank',
		confirm: '1309999999',
	});
	assert.equal(entry.content, '', 'the 501 decoder finds an empty barcode field...');
	assert.equal(entry.empty, false, '...but the tag is not empty');
	assert.equal(entry.verified, false, 'so it must not be reported as blanked');
});

test('a write that the reader reports as failed is not reported as done', async () => {
	const reader = fakeTag({ fail: true });
	const entry = await programTag({
		reader,
		tags: pad(),
		sid: NEW,
		content: '1309999998',
	});

	assert.equal(entry.verified, false);
	assert.match(entry.error, /simulated block write failure/);
});

test('readTag reports the decoded tag, read-only', async () => {
	const reader = fakeTag({ content: '1302079605' });
	const t = await readTag({ reader, sid: NEW });

	assert.equal(t.content, '1302079605');
	assert.equal(t.afi, 'DA');
	assert.equal(t.secure, true);
	assert.equal(t.itemType, 'Book');
	assert.equal(t.empty, false);
	assert.deepEqual(reader.state.writes, [], 'reading reads');
});

test('the guard is told what it refused, so a librarian sees why', async () => {
	const logged = [];
	await programTag({
		reader: fakeTag(),
		tags: pad(),
		sid: CARD,
		content: '1309999998',
		log: (s, v) => logged.push([s, v]),
	});
	assert.deepEqual(logged[0][0], 'program refused');
	assert.match(logged[0][1], /repeat it as confirm/);
});
