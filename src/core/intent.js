/*
 * Where a scanned barcode belongs, and what the tag ought to say afterwards.
 *
 * The cursor is the router. Koha focuses the box the librarian is working in — measured
 * on this install: returns.pl, circulation.pl with a patron and renew.pl all put the
 * cursor in `#barcode` on load — and its own shortcuts (`staff-global.js`: Alt+R, Alt+W,
 * Alt+U, plus this fork's Alt+Z/Alt+Y) move the cursor to the header quick-boxes from
 * anywhere. So "which transaction" is answered by the page, not by this plugin: the
 * field that holds the cursor is the one the librarian is using, and a scan belongs
 * there.
 *
 * That replaces a table of pages, which had two problems the cursor does not. The header
 * boxes exist on every staff page, so a page table either ignored them (and the plugin
 * did nothing on the page the shortcut had just focused) or guessed between three fields
 * that share the name `barcode`. And it made the plugin blind everywhere the table did not
 * reach: a scan on mainpage.pl after Alt+R had nowhere to go. Following the cursor works
 * there, and it cannot hit a decoy by accident — a decoy has to be focused to be hit, and
 * nobody focuses the renew box from the catalogue by accident.
 *
 * The transaction then decides what the tag under the head should carry:
 *
 *   returns    the item is in the building now  -> secure  (DA)
 *   renew      the item stays out with the same patron -> unsecure (D7)
 *   checkout   the item is going out            -> unsecure (D7)
 *   patron     a card, not an item              -> nothing
 *
 * Renew is in that table because it is where a wrong bit shows up: a book being renewed
 * that reads "in library" was never properly issued, and a renewal is the moment somebody
 * is holding it at a desk with a reader under it. The plugin corrects it and says so in
 * the pill, in the same breath as it corrects a returned book — see core/boot.js.
 *
 * Nothing here warns anybody. Every one of those writes is the state the transaction is
 * producing, so being wrong about one means the item is described as it is about to be,
 * which is the direction that gets noticed: a book that leaves while its tag says
 * "in library" is silent, and a book that stays while its tag says "on loan" alarms.
 * The second is embarrassing and self-correcting; the first is neither.
 */

// The two states a 3M tag carries, in the words a librarian uses. `afi` is the byte the
// driver writes; `glyph` is what the pill shows, because DA and D7 are not information
// to anybody at a desk. U+21E4/U+21E5 are an arrow against a bar: coming in, going out.
export const STATES = {
	// `hex` is how the driver reports the same byte, so a tag can be updated in the pill
	// from what was just written to it without a second round trip to the reader.
	inLibrary: {
		afi: 0xda,
		hex: 'DA',
		word: 'in library',
		glyph: '\u21e4',
		tone: 'in',
	},
	onLoan: {
		afi: 0xd7,
		hex: 'D7',
		word: 'on loan',
		glyph: '\u21e5',
		tone: 'out',
	},
	// A tag that answers with something else, or nothing: shown, never guessed at.
	unknown: {
		afi: null,
		hex: null,
		word: 'no security bit',
		glyph: '\u00b7',
		tone: 'none',
	},
};

const BY_AFI = {
	[STATES.inLibrary.afi]: STATES.inLibrary,
	[STATES.onLoan.afi]: STATES.onLoan,
};

/**
 * What the tag says now. The driver reports the AFI byte as a two-character hex string
 * ("D7"), which is what the reader stores; anything unparseable is unknown, not on loan.
 */
export function stateOf(afi) {
	const byte = typeof afi === 'string' ? parseInt(afi, 16) : afi;
	return BY_AFI[byte] || STATES.unknown;
}

// Which form the cursor is in, decided by where that form posts. The three circulation
// pages are identified by their target, not by the page the browser is on, because the
// header boxes post somewhere else from wherever they are: the check-in box on
// mainpage.pl is a check-in, and that is the whole point of pressing Alt+R.
const TRANSACTIONS = [
	{
		word: 'checkin',
		posts: /circ\/returns\.pl$/,
		kind: 'item',
		state: 'inLibrary',
	},
	{ word: 'renew', posts: /circ\/renew\.pl$/, kind: 'item', state: 'onLoan' },
	{
		word: 'checkout',
		posts: /circ\/circulation\.pl$/,
		kind: 'item',
		state: 'onLoan',
	},
	// The patron box takes a card number. Same gesture, different piece of plastic, and
	// no tag of ours is involved.
	{
		word: 'patron',
		posts: /circ\/circulation\.pl$/,
		kind: 'patron',
		state: null,
		name: 'findborrower',
	},
];

/**
 * The transaction the focused field means, or null when the cursor is not in one.
 *
 * `null` is the common answer and the correct one: the cursor is in a catalogue search,
 * an acquisitions form, a note box, and the plugin has no business there. It is also
 * what makes a scan land safely — with the cursor nowhere of ours, a tag on the pad
 * changes nothing but the pill.
 */
export function intentOf(active) {
	if (!active || String(active.tagName || '').toUpperCase() !== 'INPUT') return null;
	// circulation.pl disables its item box while a "Please confirm checkout" dialog is
	// open. Writing into it, or posting it, would look like readiness and do nothing.
	if (active.disabled || active.readOnly) return null;
	const field = active;
	const form = field.form;
	if (!form || !form.getAttribute) return null;
	const action = form.getAttribute('action') || '';
	const name = field.name || '';

	// The patron box is checked first: it also lives on circulation.pl, and its field is
	// the only one on that page not named `barcode`.
	const spec =
		TRANSACTIONS.find((t) => t.kind === 'patron' && t.name === name && t.posts.test(action)) ||
		(name === 'barcode' ? TRANSACTIONS.find((t) => t.kind === 'item' && t.posts.test(action)) : null);
	if (!spec) return null;

	return {
		word: spec.word,
		kind: spec.kind,
		state: spec.state,
		field,
		form,
		posts: action.split('/').pop(),
	};
}
