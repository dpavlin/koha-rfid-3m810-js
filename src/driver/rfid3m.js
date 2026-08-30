/*
 * 3M 810 RFID reader in JavaScript — Web Serial, no server, no dependencies.
 *
 * JS port of internal/rfid/{reader,rfid501}.go + internal/rfidops/ops.go
 * (koha-rfid-go), of the protocol worked out in Biblio::RFID::Reader::3M810 —
 * see https://github.com/dpavlin/Biblio-RFID and README, "Provenance".
 *
 * Copyright (C) 2010-2026 Dobrica Pavlinusic <dpavlin@rot13.org>
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later
 * version. See LICENSE in the repository root.
 * No parameter validation: every caller is in this repo.
 *
 * Transport contract (Web Serial / Node / fake all implement it):
 *   write(bytes)     -> push a whole frame onto the wire
 *   read(timeoutMs)  -> Promise<Uint8Array> next chunk, empty on timeout
 *   reset()          -> optional: drop and re-open the port (recovery)
 *   close()          -> optional
 *
 * Frame on the wire (real capture: tests/fixtures/live-capture.txt):
 *   <prefix> <len:2 BE> <payload> <crc:2 BE>
 * len counts payload + crc. CRC is CRC-16/GENIBUS over len + payload
 * (poly 0x1021, init 0xFFFF, xorout 0xFFFF, no reflection); prefix excluded.
 */

export const AFI_SECURE = 0xda;   // item checked in
export const AFI_UNSECURE = 0xd7; // item on loan

const PROBE_FRAME = new Uint8Array([0xd5, 0x00, 0x05, 0x04, 0x00, 0x11, 0x8c, 0x66]);
const T_CMD = 1500;
const T_WRITE = 2500;
const RETRIES = 10;

// -- CRC-16/GENIBUS ---------------------------------------------------------

const crcTable = (() => {
	const t = new Uint16Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i << 8;
		for (let j = 0; j < 8; j++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
		t[i] = c;
	}
	return t;
})();

export function crc16(b) {
	let crc = 0xffff;
	for (let i = 0; i < b.length; i++) crc = ((crc << 8) ^ crcTable[((crc >> 8) ^ b[i]) & 0xff]) & 0xffff;
	return (crc ^ 0xffff) & 0xffff;
}

// -- hex -------------------------------------------------------------------

export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const unhex = (s) => new Uint8Array((s.replace(/ /g, '').match(/../g) || []).map((h) => parseInt(h, 16)));

export const concat = (parts) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) { out.set(p, o); o += p.length; }
	return out;
};

// -- RFID501 tag format: 8 blocks x 4 bytes --------------------------------
//
//   block 0    0x04, set<<4|total, 0x00, item type
//   block 1-4  barcode, 16 ASCII bytes, NUL padded
//   block 5    branch (12 bits) << 20 | library (20 bits), big endian
//   block 6    custom signed int, big endian
//   block 7    zero

export const ITEM_TYPES = {
	0: 'Other', 1: 'Book', 2: 'Magazine', 3: 'Bound Journal', 4: 'Audio Tape',
	5: 'Video', 6: 'CD/CD ROM', 7: 'Diskette', 8: 'Book with Diskette',
	9: 'Book with CD/CD ROM', 13: 'Book with Audio Tape',
};

const u32 = (n) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);

/** blocks = 8x4 bytes (Uint8Array of 32 or array of 4-byte blocks) -> fields */
export function decode501(blocks) {
	const d = blocks instanceof Uint8Array ? blocks : concat(blocks);
	if (d.length < 24) return null;
	const ascii = d.subarray(4, 20);
	const end = Math.max(0, ascii.indexOf(0) < 0 ? 16 : ascii.indexOf(0));
	const brlib = ((d[20] << 24) | (d[21] << 16) | (d[22] << 8) | d[23]) >>> 0;
	return {
		set: d[1] >> 4,
		total: d[1] & 0x0f,
		type: d[3],
		typeLabel: ITEM_TYPES[d[3]] || `Unknown(${d[3]})`,
		content: String.fromCharCode.apply(null, ascii.subarray(0, end)),
		branch: (brlib >>> 20) & 0xfff,
		library: brlib & 0xfffff,
		custom: ((d[24] << 24) | (d[25] << 16) | (d[26] << 8) | d[27]) | 0,
	};
}

/** encode({content, type, set=1, total=1, branch, library, custom}) -> 32 bytes */
export function encode501(o) {
	const type = o.type != null ? o.type : (o.content.startsWith('130') ? 1 : 0);
	const brlib = (((o.branch || 0) & 0xfff) << 20) | ((o.library || 0) & 0xfffff);
	const barcode = new Uint8Array(16);
	for (let i = 0; i < Math.min(16, o.content.length); i++) barcode[i] = o.content.charCodeAt(i) & 0xff;
	return concat([
		new Uint8Array([0x04, ((o.set || 1) << 4) | (o.total || 1), 0x00, type]),
		barcode,
		u32(brlib),
		u32(o.custom || 0),
		new Uint8Array(4),
	]);
}

/** barcode only: item type follows the 3M spec, 130... = Book, else Other */
export const encodeContent = (content) => encode501({ content });

/** factory-fresh blank tag (3 zero blocks) */
export const blankTag = () => new Uint8Array(12);

/** 3M blank tag: six blocks of 0x55555555 + one zero block */
export const blank3M = () => concat([].concat(...Array(6).fill([u32(0x55555555)]), [new Uint8Array(4)]));

// -- reader -----------------------------------------------------------------

export class Reader3M {
	/** transport: see contract at the top of this file */
	constructor(transport, { log } = {}) {
		this.t = transport;
		this.log = log || (() => {});
		this.rx = new Uint8Array(0);
		this.errors = 0;
		this.tail = Promise.resolve(); // one exchange on the wire at a time
	}

	// --- framing over a byte stream ---

	_push(chunk) {
		if (!chunk || !chunk.length) return;
		const b = new Uint8Array(this.rx.length + chunk.length);
		b.set(this.rx);
		b.set(chunk, this.rx.length);
		this.rx = b;
	}

	async _need(n, end) {
		while (this.rx.length < n) {
			const left = end - Date.now();
			if (left <= 0) return false;
			this._push(await this.t.read(Math.min(250, left)));
		}
		return true;
	}

	/** next complete frame payload (CRC checked); resyncs on garbage */
	async _frame(timeoutMs) {
		const end = Date.now() + timeoutMs;
		for (;;) {
			if (!(await this._need(4, end))) throw new Error('reader timeout');
			const len = (this.rx[1] << 8) | this.rx[2];
			if (len < 3) { this.rx = this.rx.subarray(1); continue; }
			if (!(await this._need(3 + len, end))) throw new Error('reader timeout');
			const want = (this.rx[len + 1] << 8) | this.rx[len + 2];
			const got = crc16(this.rx.subarray(1, len + 1));
			if (got === want) {
				const payload = this.rx.slice(3, len + 1);
				this.rx = this.rx.subarray(len + 3);
				return payload;
			}
			this.rx = this.rx.subarray(1); // bad CRC: drop a byte and resync
		}
	}

	/** run fn() after everything queued before it has finished */
	async _lock(fn) {
		const prev = this.tail;
		let release;
		this.tail = new Promise((r) => { release = r; });
		await prev.catch(() => {});
		try {
			return await fn();
		} finally {
			release();
		}
	}

	/** drop late bytes from a command that timed out, so the next one starts clean */
	async _drain() {
		for (let i = 0; i < 8; i++) {
			const b = await this.t.read(5);
			if (!b.length) break;
		}
		this.rx = new Uint8Array(0);
	}

	/** send a command payload (framed) and return the response payload */
	async cmd(payload, timeoutMs = T_CMD) {
		return this._lock(async () => {
			await this._drain();
			return this._cmd(payload, timeoutMs);
		});
	}

	async _cmd(payload, timeoutMs) {
		const len = payload.length + 2; // length field counts payload + CRC
		const frame = new Uint8Array(3 + len);
		frame[0] = 0xd6;
		frame[1] = len >> 8;
		frame[2] = len & 0xff;
		frame.set(payload, 3);
		const crc = crc16(frame.subarray(1, 3 + payload.length)); // length + payload, no prefix, no CRC
		frame[3 + payload.length] = crc >> 8;
		frame[4 + payload.length] = crc & 0xff;
		this.log('>>', hex(frame));
		await this.t.write(frame);
		const resp = await this._frame(timeoutMs);
		this.log('<<', hex(resp));
		return resp;
	}

	// --- commands ---

	/** wake the reader; resolves to a hardware version string like "10.5.0.2" */
	async probe() {
		return this._lock(async () => {
			await this._drain();
			this.log('>>', hex(PROBE_FRAME));
			await this.t.write(PROBE_FRAME);
			const r = await this._frame(T_CMD);
			this.log('<<', hex(r));
			return r.slice(3, 7).join('.');
		});
	}

	/** SIDs currently in the field, lowercase hex */
	async inventory() {
		const r = await this.cmd(new Uint8Array([0xfe, 0x00, 0x05]));
		const n = r[4];
		const out = [];
		for (let i = 0; i < n; i++) out.push(hex(r.subarray(5 + i * 8, 13 + i * 8)));
		return out;
	}

	/**
	 * Inventory that resets the serial port after 3 consecutive failures and tries
	 * once more — same recovery as the Go reader's InventoryWithReset, including
	 * the single retry (an endless retry loop just hides a dead reader).
	 */
	async scan_() {
		try {
			const ids = await this.inventory();
			this.errors = 0;
			return ids;
		} catch (e) {
			if (++this.errors < 3 || !this.t.reset) throw e;
			this.log('reset', String(e.message || e));
			try {
				await this.t.reset();
				this.errors = 0;
			} catch (err) {
				this.log('reset failed', String(err && err.message ? err.message : err));
			}
			this.rx = new Uint8Array(0);
			const ids = await this.inventory();
			this.errors = 0;
			return ids;
		}
	}

	/** AFI byte for a tag (0xda secure, 0xd7 unsecure) */
	async readAfi(sid) {
		const r = await this.cmd(concat([new Uint8Array([0x0a]), unhex(sid)]));
		if (r[1] !== 0) throw new Error('read AFI failed, status ' + r[1]);
		return r[10];
	}

	/** AFI write, retried until it reads back right */
	async writeAfi(sid, afi) {
		const id = unhex(sid);
		let back = -1;
		for (let i = 0; i < RETRIES; i++) {
			await this.cmd(new Uint8Array([0x09, ...id, afi]), T_WRITE);
			back = await this.readAfi(sid);
			if (back === afi) return;
		}
		throw new Error('AFI write did not stick: wanted ' + afi.toString(16) + ', read ' + (back >>> 0).toString(16));
	}

	/** blocks [start, start+count) as 4-byte blocks, in order */
	async readBlocks(sid, start, count) {
		const r = await this.cmd(new Uint8Array([0x02, ...unhex(sid), start, count]));
		if (r[1] !== 0) throw new Error('read blocks failed, status ' + r[1]);
		const n = r[10];
		const blocks = [];
		for (let i = 0; i < n; i++) blocks.push(r.subarray(13 + i * 6, 17 + i * 6));
		return blocks;
	}

	/** write blocks (multiple of 4 bytes from block 0) and verify */
	async writeBlocks(sid, data) {
		const id = unhex(sid);
		const n = data.length / 4;
		for (let i = 0; i < RETRIES; i++) {
			await this.cmd(concat([new Uint8Array([0x04, ...id, 0x00, n, 0x00]), data]), T_WRITE);
			if (hex(concat(await this.readBlocks(sid, 0, n))) === hex(data)) return;
		}
		throw new Error('block write did not stick on ' + sid);
	}

	// --- operations: same shape as the Go server's /scan/ /secure /program ---

	async scan() {
		const tags = [];
		for (const sid of await this.scan_()) {
			const tag = { sid, content: '', security: '', tag_type: 'RFID501', reader: '3M810' };
			try {
				tag.security = this._afiHex(await this.readAfi(sid));
				const blocks = await this.readBlocks(sid, 0, 8);
				const d = decode501(blocks);
				tag.content = d ? d.content : String.fromCharCode(...blocks[0]);
			} catch { /* tag left the field mid-read */ }
			tags.push(tag);
		}
		return { tags };
	}

	/** list = [{sid, content, tag?}] ; content "blank"/"3mblank" writes blanks */
	async program(list) {
		const errors = [];
		let ok = 1;
		for (const op of list) {
			const sid = op.sid.toUpperCase();
			const content = op.content;
			if (content.length > 16) {
				ok = 0;
				errors.push(`content for ${sid} exceeds the RFID501 16-byte limit`);
				continue;
			}
			try {
				let afi;
				if (content.toLowerCase() === 'blank') {
					await this.writeBlocks(sid, blankTag());
					afi = AFI_UNSECURE;
				} else if (content.toLowerCase() === '3mblank') {
					await this.writeBlocks(sid, blank3M());
					afi = AFI_UNSECURE;
				} else {
					await this.writeBlocks(sid, op.tag ? encode501(op.tag) : encodeContent(content));
					afi = content.startsWith('130') ? AFI_SECURE : AFI_UNSECURE;
				}
				await this.writeAfi(sid, afi);
			} catch (e) {
				ok = 0;
				errors.push(String(e.message || e));
			}
		}
		return { ok, errors };
	}

	/** list = [{sid, afi}] ; afi is a 2-char hex string or a byte */
	async secure(list) {
		for (const op of list) {
			try {
				await this.writeAfi(op.sid.toUpperCase(), typeof op.afi === 'string' ? parseInt(op.afi, 16) : op.afi);
			} catch (e) {
				return { ok: 0, error: String(e.message || e) };
			}
		}
		return { ok: 1 };
	}

	_afiHex(b) {
		return b.toString(16).padStart(2, '0').toUpperCase();
	}

	async close() {
		if (this.t.close) await this.t.close();
	}
}
