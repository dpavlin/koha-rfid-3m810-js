/*
 * Protocol parity tests for src/driver/rfid3m.js.
 *
 * Everything is pinned to tests/fixtures/live-capture.txt, a byte-for-byte
 * capture of a real 3M 810 session taken with the Go binary:
 *
 *   >> lines  bytes written by the host, CRC included
 *   << lines  frame prefix, 2-byte length, payload — the capture tool stripped
 *             the trailing CRC, so responses are rebuilt with wire() below
 *
 * If the JS port and the Go port ever disagree about the wire, these fail.
 *
 *   node --test tests/driver.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
	Reader3M, crc16, hex, unhex, concat, decode501, encode501, encodeContent,
	blankTag, blank3M, AFI_SECURE, AFI_UNSECURE,
} from '../src/driver/rfid3m.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'live-capture.txt');

const captured = (() => {
	const tx = [], rx = [];
	for (const line of readFileSync(FIXTURE, 'utf8').split('\n')) {
		const l = line.trim();
		if (l.startsWith('>>')) tx.push(hex(unhex(l.slice(2).trim())));
		else if (l.startsWith('<<')) rx.push(l.slice(2).trim().split(/\s+/).slice(3).join('')); // prefix, len, payload
	}
	return { tx, rx };
})();

const txFinding = (needle) => captured.tx.filter((f) => f.includes(needle));

/** wrap a payload exactly like the reader does: prefix + len(payload+crc) + payload + crc */
function wire(payloadHex, prefix = 'd6') {
	const payload = unhex(payloadHex);
	const head = unhex(prefix + (payload.length + 2).toString(16).padStart(4, '0'));
	const crc = crc16(concat([head.subarray(1), payload]));
	return hex(concat([head, payload, unhex(crc.toString(16).padStart(4, '0'))]));
}

/** fake transport: a response only becomes readable after the matching write */
class FakeTransport {
	constructor(responses = []) {
		this.responses = responses.slice();
		this.pending = [];
		this.written = [];
		this.resets = 0;
	}
	async write(bytes) {
		this.written.push(hex(bytes));
		const r = this.responses.shift();
		if (r) this.pending.push(unhex(r));
	}
	async read() {
		return this.pending.length ? this.pending.shift() : new Uint8Array(0);
	}
	async reset() { this.resets++; }
}

const [, CAP_INVENTORY, CAP_AFI_BOOK, CAP_BLOCKS_BOOK, CAP_AFI_CARD, CAP_BLOCKS_CARD] = captured.rx;

test('capture loaded', () => {
	assert.equal(captured.tx.length, 6);
	assert.equal(captured.rx.length, 6);
});

test('CRC-16/GENIBUS matches every frame the Go binary wrote', () => {
	for (const frame of captured.tx) {
		const b = unhex(frame);
		const len = (b[1] << 8) | b[2];
		assert.equal(b.length, len + 3, frame);
		assert.equal(
			crc16(b.subarray(1, len + 1)),
			(b[len + 1] << 8) | b[len + 2],
			frame,
		);
	}
});

test('inventory command is byte-identical to the Go binary', async () => {
	const t = new FakeTransport([wire(CAP_INVENTORY)]);
	assert.deepEqual(await new Reader3M(t).inventory(), ['e004010031269117', 'e00401001f77fb98']);
	assert.deepEqual(t.written, txFinding('fe0005'));
	assert.equal(t.written[0], 'd60005fe0005fa40');
});

test('read AFI command is byte-identical to the Go binary', async () => {
	const t = new FakeTransport([wire(CAP_AFI_BOOK)]);
	assert.equal(await new Reader3M(t).readAfi('e004010031269117'), AFI_SECURE);
	assert.deepEqual(t.written, txFinding('0ae004010031269117'));
	assert.equal(t.written[0], 'd6000b0ae004010031269117ec84');
});

test('read blocks command is byte-identical to the Go binary', async () => {
	const t = new FakeTransport([wire(CAP_BLOCKS_BOOK)]);
	const blocks = await new Reader3M(t).readBlocks('e004010031269117', 0, 8);
	assert.equal(blocks.length, 8);
	assert.equal(hex(blocks[0]), '04110001'); // RFID501 header + item type 1 (Book)
	assert.deepEqual(t.written, txFinding('02e0040100312691170008'));
	assert.equal(t.written[0], 'd6000d02e00401003126911700084e9b');
});

test('decoded blocks of both captured tags match the Go decoder', async () => {
	const read = async (payload) => {
		const t = new FakeTransport([wire(payload)]);
		const sid = hex(unhex(payload).subarray(2, 10));
		return decode501(await new Reader3M(t).readBlocks(sid, 0, 8));
	};
	const book = await read(CAP_BLOCKS_BOOK);
	assert.equal(book.content, '1302099999');
	assert.equal(book.type, 1);
	assert.equal(book.typeLabel, 'Book');
	const card = await read(CAP_BLOCKS_CARD);
	assert.equal(card.content, '200000000042');
	assert.equal(card.typeLabel, 'Other');
});

test('write AFI frame', async () => {
	const t = new FakeTransport([wire('0900'), wire(CAP_AFI_BOOK)]);
	await new Reader3M(t).writeAfi('e004010031269117', AFI_SECURE);
	assert.equal(t.written[0], wire('09e004010031269117da'));
});

test('encode501 / decode501 round-trip', () => {
	for (const content of ['1302099999', '200000000042', 'A', '1234567890123456', '']) {
		assert.equal(decode501(encode501({ content })).content, content, content);
	}
	assert.equal(decode501(new Uint8Array(8)), null, 'too short to be a tag');
	assert.equal(encode501({ content: '1302099999' }).length, 32);
	assert.equal(encode501({ content: '200000000042' })[3], 0, 'non-130 content is not a Book');
});

test('encodeContent matches encode501 default fields', () => {
	assert.equal(hex(encodeContent('1302099999')), hex(encode501({ content: '1302099999' })));
});

test('blank tag payloads', () => {
	assert.equal(hex(blankTag()), '00'.repeat(12));
	assert.equal(hex(blank3M()), '55555555'.repeat(6) + '00000000');
});

test('scan() returns the same JSON as GET /scan/', async () => {
	const t = new FakeTransport([
		wire(CAP_INVENTORY), wire(CAP_AFI_BOOK), wire(CAP_BLOCKS_BOOK),
		wire(CAP_AFI_CARD), wire(CAP_BLOCKS_CARD),
	]);
	assert.deepEqual((await new Reader3M(t).scan()).tags, [
		{ sid: 'e004010031269117', content: '1302099999', security: 'DA', tag_type: 'RFID501', reader: '3M810' },
		{ sid: 'e00401001f77fb98', content: '200000000042', security: 'DA', tag_type: 'RFID501', reader: '3M810' },
	]);
});

test('scan() survives a tag that stops answering mid-read', async () => {
	const t = new FakeTransport([
		wire(CAP_INVENTORY),
		wire('0a06e004010031269117'),  // AFI read reports an error status
		wire(CAP_INVENTORY.replace(/^.{10}/, 'fe00000500')), // nothing else answers
	]);
	const { tags } = await new Reader3M(t, { log: () => {} }).scan();
	assert.equal(tags.length, 2);
	assert.deepEqual(tags[0], { sid: 'e004010031269117', content: '', security: '', tag_type: 'RFID501', reader: '3M810' });
});

test('secure() writes AFI and verifies it', async () => {
	const t = new FakeTransport([wire('0900'), wire(CAP_AFI_BOOK)]);
	assert.deepEqual(await new Reader3M(t).secure([{ sid: 'E004010031269117', afi: 'DA' }]), { ok: 1 });
});

test('secure() reports the failure instead of throwing', async () => {
	const stuck = [];
	for (let i = 0; i < 12; i++) stuck.push(wire('0900'), wire('0a00e004010031269117d7'));
	const t = new FakeTransport(stuck);
	const res = await new Reader3M(t, { log: () => {} }).secure([{ sid: 'e004010031269117', afi: 'DA' }]);
	assert.equal(res.ok, 0);
	assert.match(res.error, /AFI write did not stick/);
});

test('program() rejects content longer than RFID501 holds', async () => {
	const t = new FakeTransport([]);
	const res = await new Reader3M(t).program([{ sid: 'e004010031269117', content: 'x'.repeat(17) }]);
	assert.equal(res.ok, 0);
	assert.match(res.errors[0], /16-byte limit/);
	assert.deepEqual(t.written, [], 'must not touch the tag');
});

/** program()/secure() policy without the wire: record the primitives */
class Recording extends Reader3M {
	constructor() { super(new FakeTransport([]), { log: () => {} }); this.calls = []; }
	async writeBlocks(sid, data) { this.calls.push(['blocks', sid, hex(data)]); }
	async writeAfi(sid, afi) { this.calls.push(['afi', sid, afi]); }
	async readAfi() { return AFI_SECURE; }
}

test('program() picks AFI by content and blanks clear it', async () => {
	const p = new Recording();
	await p.program([
		{ sid: 'e004010031269117', content: '1302099999' },   // item barcode -> secure
		{ sid: 'E00401001F77FB98', content: '200000000042' }, // patron card -> unsecure
		{ sid: 'E00401003126A0C8', content: 'blank' },
	]);
	assert.deepEqual(p.calls.map((c) => c[0]), ['blocks', 'afi', 'blocks', 'afi', 'blocks', 'afi']);
	assert.equal(p.calls[1][2], AFI_SECURE);
	assert.equal(p.calls[3][2], AFI_UNSECURE);
	assert.equal(p.calls[5][2], AFI_UNSECURE, 'a blank tag must never be secured');
	assert.equal(p.calls[4][2], hex(blankTag()));
	assert.equal(p.calls[0][1], 'E004010031269117', 'SID uppercased like the Go server');
	assert.equal(p.calls[0][2], hex(encodeContent('1302099999')));
});

test('program() keeps going after one tag fails and reports it', async () => {
	class Fails extends Recording {
		async writeBlocks(sid, data) {
			if (sid.endsWith('BEEF')) throw new Error('tag not found');
			return super.writeBlocks(sid, data);
		}
	}
	const p = new Fails();
	const res = await p.program([
		{ sid: 'e0040100deadbeef', content: '1302099999' },
		{ sid: 'e004010031269117', content: '1302000001' },
	]);
	assert.equal(res.ok, 0);
	assert.deepEqual(res.errors, ['tag not found']);
	assert.ok(p.calls.some((c) => c[0] === 'afi'), 'second tag still programmed');
});

test('queued commands each get their own response, never the other\'s', async () => {
	const t = new FakeTransport([
		wire('fe00000501e004010031269117'),
		wire('fe00000501e00401001f77fb98'),
	]);
	const r = new Reader3M(t, { log: () => {} });
	const [a, b] = await Promise.all([r.inventory(), r.inventory()]);
	assert.deepEqual(a, ['e004010031269117']);
	assert.deepEqual(b, ['e00401001f77fb98']);
	assert.deepEqual(t.written, [t.written[0], t.written[0]], 'both commands were the same frame');
});

test('bytes left over from an aborted command are drained before the next one', async () => {
	const t = new FakeTransport([wire('fe00000501e004010031269117')]);
	t.pending.push(unhex(wire('fe00000501e00401001f77fb98'))); // garbage from a command that timed out
	const r = new Reader3M(t, { log: () => {} });
	assert.deepEqual(await r.inventory(), ['e004010031269117'], 'stale frame must not be answered as the new one');
});

test('a stalled reader resets the port after 3 consecutive inventory failures (as Go does)', async () => {
	const t = new FakeTransport([]);
	const r = new Reader3M(t, { log: () => {} });
	for (let i = 0; i < 2; i++) await assert.rejects(() => r.scan_(), /timeout/);
	assert.equal(t.resets, 0, 'no reset before the third failure');
	await assert.rejects(() => r.scan_(), /timeout/);
	assert.equal(t.resets, 1);
});

test('probe() reads the hardware version', async () => {
	const t = new FakeTransport([wire('0400110a050002')]);
	assert.equal(await new Reader3M(t).probe(), '10.5.0.2');
	assert.equal(t.written[0], 'd500050400118c66');
});
