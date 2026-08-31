/*
 * Writing to a tag is the only thing this plugin can do that damages the
 * catalogue: overwrite a barcode and the item keeps its record but stops being
 * findable, and nothing downstream complains. So the guard is the feature here,
 * not a wrapper around reader.program().
 *
 * The rules, in order of "how bad would this be":
 *
 *   1. The tag must be physically on the pad right now. No writing to a typed-in
 *      or remembered SID — you cannot mis-position a tag you are holding.
 *   2. A tag that already holds something that is not a book barcode (a patron
 *      card, anything outside bookPrefix) is only overwritten if the caller
 *      repeats that exact barcode back as `confirm`. Typos cannot satisfy that.
 *   3. The new barcode must not duplicate another tag on the pad: two items with
 *      one barcode is a circulation bug that surfaces months later.
 *   4. 1..16 printable ASCII characters (RFID501 field size), or the words
 *      "blank" / "3mblank", which is how the 3M world writes an empty tag.
 *
 * Nothing here trusts the driver's own readback either: after program() we read
 * the blocks and AFI again ourselves and report what is actually on the tag.
 */

import { decode501, hex } from '../driver/rfid3m.js';

const SID = /^[0-9a-fA-F]{16}$/;
const BLANKS = ['blank', '3mblank'];
const PRINTABLE = /^[\x20-\x7e]+$/;

const isBlank = (content) => !content || /^0+$/.test(content) || /^\s*$/.test(content);

/** @returns {{ok: true} | {ok: false, error: string}} */
export function guard({ tags = [], sid, content, confirm = null, bookPrefix = '130' } = {}) {
	if (!SID.test(String(sid))) return { ok: false, error: `sid must be 16 hex digits, got "${sid}"` };
	const wanted = sid.toLowerCase();
	const tag = tags.find((t) => t.sid.toLowerCase() === wanted);
	if (!tag) return { ok: false, error: `${sid} is not on the pad — put the tag you mean under the antenna` };

	if (typeof content !== 'string' || !content.length) return { ok: false, error: 'no content given' };
	if (BLANKS.includes(content.toLowerCase())) return { ok: true, blank: true, tag };

	if (content.length > 16) return { ok: false, error: `"${content}" is ${content.length} characters; RFID501 holds 16` };
	if (!PRINTABLE.test(content)) return { ok: false, error: 'content must be printable ASCII' };

	const here = tag.content || '';
	if (!isBlank(here) && !(bookPrefix && here.startsWith(bookPrefix))) {
		if (String(confirm) !== here) {
			return {
				ok: false,
				error: `tag holds "${here}", which is not a book barcode — repeat it as confirm to overwrite a patron card or an unknown tag`,
			};
		}
	}

	const twin = tags.find((t) => t.sid.toLowerCase() !== wanted && t.content === content);
	if (twin) return { ok: false, error: `"${content}" is already on the pad (${twin.sid}) — that would be a duplicate barcode` };

	return { ok: true, tag };
}

/**
 * Program one tag. `content` is a barcode, or "blank"/"3mblank" to write blanks
 * (which is what blanking is: programming with the 3M empty-tag pattern).
 *
 * Returns the tag as it reads *after* the write, so the caller never has to
 * believe the writer.
 */
export async function programTag({
	reader,
	tags = [],
	sid,
	content,
	confirm = null,
	bookPrefix = '130',
	log = () => {},
	now = () => Date.now(),
} = {}) {
	const entry = { at: now(), sid: sid.toLowerCase(), from: null, to: content, afi: null, verified: false, error: null };

	const allow = guard({ tags, sid, content, confirm, bookPrefix });
	if (!allow.ok) {
		entry.error = allow.error;
		log('program refused', entry.error);
		return entry;
	}
	entry.from = allow.tag.content || '';

	try {
		const res = await reader.program([{ sid, content }]);
		if (!res.ok) throw new Error((res.errors || ['program failed']).join('; '));

		const back = await readTag({ reader, sid });
		Object.assign(entry, back);
		// "Verified" means the tag says what we asked, read back from the tag. For a
		// blank that means empty all the way down: a blank that only cleared the head
		// of a written tag leaves the old barcode's tail behind and is not blank.
		entry.verified = BLANKS.includes(String(content).toLowerCase()) ? entry.empty : entry.content === content;
		log('programmed', `${sid} ${entry.from || '(blank)'} -> ${content} (afi ${entry.afi}, ${entry.verified ? 'verified' : 'NOT VERIFIED'})`);
	} catch (e) {
		entry.error = String((e && e.message) || e);
		log('program failed', `${sid}: ${entry.error}`);
	}
	return entry;
}

/** Read a tag back in full: AFI, raw blocks, decoded 501 fields. Read-only. */
export async function readTag({ reader, sid }) {
	const afiByte = await reader.readAfi(sid);
	const blocks = await reader.readBlocks(sid, 0, 8);
	const flat = new Uint8Array(blocks.reduce((acc, b) => acc.concat([...b]), []));
	const d = decode501(flat);
	return {
		afi: hex(new Uint8Array([afiByte])).toUpperCase(),
		secure: afiByte === 0xda,
		blocks: blocks.map((b) => hex(b)).join(' '),
		content: d ? d.content : '',
		itemType: d ? d.typeLabel : null,
		branch: d ? d.branch : null,
		library: d ? d.library : null,
		empty: !hex(flat).replace(/[05]/g, '').length,
	};
}
