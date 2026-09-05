/*
 * A window like the Koha staff client, small enough to reason about.
 *
 * `install()` only ever touches a handful of browser surfaces, so the fake is honest
 * about them rather than pretending to be a DOM: forms are objects with getAttribute /
 * elements / submit, location has a pathname, `document.activeElement` is whichever field
 * the test says holds the cursor (that is what routes a scan — see core/intent.js), and
 * the elements the plugin creates are returned so a test can read their text and title.
 *
 * Anything the plugin starts using has to be added here on purpose — which is the
 * point: an accidental new browser dependency shows up as a failing test, not as a
 * white page on a librarian's screen.
 *
 * `setInterval` / `clearInterval` are faked and recorded rather than left global: a real
 * interval scheduled by a test is a test process that prints its results and then never
 * exits. If the plugin ever schedules one behind the window's back, that shows up here.
 */
export function fakeWindow({
	serial = false,
	armed = false,
	ports = [],
	search = '',
	pathname = '/cgi-bin/koha/circ/returns.pl',
	forms = [],
	focus = null, // the field holding the cursor: this is what routes a scan
	// Two fake windows sharing one `session` object is the same tab across a page load —
	// which is the only way to test anything that has to survive a reload.
	session = {},
	config = {},
	context = {
		page: '/intranet/circ/returns.pl',
		branch: 'FFZG',
		userid: 'dpavlin@ffzg.hr',
	},
} = {}) {
	const calls = {
		listeners: [],
		docListeners: [],
		createElement: 0,
		appended: 0,
		elements: [],
	};
	const timers = { intervals: [], cleared: [] };
	const storage = {};
	if (armed) storage.rfid_armed = '1';

	// Enough element for the pill (style, textContent, title) and for the security alarm,
	// which nests a span per tag and clears itself with `textContent = ''`. The setter
	// clears the children because that is what a browser does, and an element that kept
	// them would let the pill pass a test while still showing last book's barcode.
	const el = () => {
		const node = {
			tag: 'div',
			children: [],
			handlers: {},
			attrs: {},
			style: { cssText: '', display: 'none' },
			href: '',
			title: '',
			id: '',
			text: '',
			className: '',
			parentNode: null,
			setAttribute(k, v) {
				this.attrs[k] = v;
			},
			addEventListener(type, fn) {
				(this.handlers[type] ||= []).push(fn);
			},
			appendChild(n) {
				n.parentNode = this;
				this.children.push(n);
				return n;
			},
			removeChild(n) {
				const i = this.children.indexOf(n);
				if (i >= 0) this.children.splice(i, 1);
				n.parentNode = null;
				return n;
			},
			dispatch(type, ev = {}) {
				for (const fn of this.handlers[type] || []) fn({ preventDefault() {}, ...ev });
			},
			querySelector(sel) {
				if (sel !== 'button') return null;
				const walk = (n) =>
					n.children.find((c) => c.tag === 'button') || n.children.map(walk).find(Boolean) || null;
				return walk(this);
			},
			focus() {
				this.focusCalls = (this.focusCalls || 0) + 1;
			},
		};
		Object.defineProperty(node, 'textContent', {
			get() {
				// Like the DOM, whose textContent is an element's own text plus its children's:
				// a test can read "RFID \u2713 1302079605 IN" out of the pill without knowing that
				// the label and each tag are separate spans.
				return this.text + this.children.map((c) => c.textContent).join('');
			},
			set(v) {
				this.text = v;
				if (v === '') this.children.length = 0;
			},
		});
		return node;
	};
	const win = {
		navigator: serial
			? {
					serial: {
						getPorts: async () => ports,
						requestPort: async () => null,
					},
				}
			: {},
		localStorage: {
			getItem: (k) => (k in storage ? storage[k] : null),
			setItem: (k, v) => {
				storage[k] = String(v);
			},
			removeItem: (k) => {
				delete storage[k];
			},
		},
		sessionStorage: {
			data: session,
			getItem(k) {
				return k in this.data ? this.data[k] : null;
			},
			setItem(k, v) {
				this.data[k] = String(v);
			},
			removeItem(k) {
				delete this.data[k];
			},
		},
		location: { search, pathname },
		history: { replaceState() {} },
		setInterval: (fn, ms) => (timers.intervals.push({ fn, ms, on: true }), timers.intervals.length),
		clearInterval: (h) => (timers.cleared.push(h), timers.intervals[h - 1] && (timers.intervals[h - 1].on = false)),
		URLSearchParams,
		document: {
			getElementById: (id) => calls.elements.find((n) => n.id === id) || null,
			querySelector: () => null,
			// One selector shape, good enough for the panel and honest about being a fake:
			// 'div.dialog.message' matches a created div whose className contains both classes.
			// Anything fancier returns nothing, which is the safe direction: the caller then
			// leaves the page alone rather than pretending it changed something.
			querySelectorAll: (sel = '') => {
				const [tag, ...classes] = String(sel)
					.split(/(?=[.#])|\s+/)
					.filter(Boolean);
				return calls.elements.filter(
					(n) =>
						(!tag || n.tag === tag) &&
						classes.every((c) => ` ${n.className} `.includes(` ${c.replace(/[.#]/g, '')} `)),
				);
			},
			// A browser throws InvalidCharacterError for a name like "margin:2px 0", and the
			// first version of the panel made exactly that element. A fake that accepts anything
			// turns that into a panel that works in tests and throws on a librarian's screen.
			createElement: (tag) => {
				if (typeof tag !== 'string' || !/^[a-zA-Z][\w-]*$/.test(tag))
					throw new Error(`InvalidCharacterError: "${tag}" is not a valid element name`);
				return (
					calls.createElement++,
					calls.elements.push(Object.assign(el(), { tag })) && calls.elements.at(-1)
				);
			},
			addEventListener: (type, fn) => (calls.docListeners[type] ||= []).push(fn),
			dispatch(type, ev = {}) {
				for (const fn of calls.docListeners[type] || []) fn({ preventDefault() {}, ...ev });
			},
			forms,
			activeElement: focus,
			// Set it and `dispatch('visibilitychange')`: the plugin pauses the pad when the
			// tab goes away, which is a behaviour, not a constant.
			hidden: false,
			body: {
				children: [],
				appendChild(n) {
					return (calls.appended++, this.children.push(n) && n);
				},
			},
		},
		addEventListener: (type) => calls.listeners.push(type),
		RFID_CONFIG: config,
		RFID_CONTEXT: context,
	};
	return { win, calls, storage, timers, elements: calls.elements };
}

export const deadPort = () => ({
	opens: 0,
	reads: 0,
	readable: null,
	writable: null,
	async open() {
		this.opens++;
		throw new Error('no device attached');
	},
	async close() {},
});

/**
 * A field of a Koha form, as the code sees it. `form` is back-linked the way the DOM
 * does it, because the cursor is routed by which form a field belongs to: on
 * circulation.pl the checkout box and the header check-in box are both named `barcode`
 * and post to different pages.
 */
export const field = ({
	id,
	name = 'barcode',
	value = '',
	disabled = false,
	readOnly = false,
	type = 'text',
} = {}) => ({
	tagName: 'INPUT',
	type,
	id,
	name,
	value,
	disabled,
	readOnly,
	form: null,
	focusCalls: 0,
	focus() {
		this.focusCalls++;
	},
});

/**
 * A form of a Koha page. `posts` counts submits: on returns.pl a submit is the plugin
 * doing its job, on circulation.pl it is the plugin taking an item out of the library
 * without anyone asking, so the count is the assertion that matters.
 */
export function form(action, { id = '', fields = {}, trace = null } = {}) {
	const f = {
		id,
		elements: fields,
		getAttribute: (k) => (k === 'action' ? action : null),
		submits: 0,
		submit() {
			// `trace` is a shared timeline: the ordering claims (the tag is written before the
			// page navigates, because navigating closes the port) cannot be made from two
			// counters that both end at 1.
			if (trace) trace.push(`submit:${id || action}`);
			this.submits++;
		},
	};
	for (const [name, el] of Object.entries(fields)) {
		el.name = name;
		el.form = f;
	}
	return f;
}

/**
 * A reader that answered, with the pad as a variable a test can change.
 *
 * `pad` is mutable on purpose: `put(tag)` and `take(sid)` are the librarian moving books,
 * and `writes` is what the plugin did to them — the assertion that a security bit was
 * written is only worth anything if it is measured at the reader, not in the plugin's own
 * idea of what it wrote.
 */
export function fakeReader(
	tags = [],
	{ failWrites = false, trace = null, writeDelayMs = 0, strictWrites = false } = {},
) {
	const pad = [...tags];
	const writes = [];
	return {
		pad,
		writes,
		put: (...t) => pad.push(...t),
		take: (sid) => {
			const i = pad.findIndex((x) => String(x.sid).toLowerCase() === String(sid).toLowerCase());
			return i >= 0 ? pad.splice(i, 1) : [];
		},
		stats: { polls: 0, changes: 0, errors: 0, on: false },
		async scan() {
			this.polls++;
			return { tags: pad.map((t) => ({ ...t })) };
		},
		async inventory() {
			return pad.map((t) => t.sid);
		},
		async writeAfi(sid, afi) {
			if (failWrites) throw new Error('tag moved out of range');
			if (trace) trace.push(`write:${String(sid).slice(-4)}`);
			if (writeDelayMs) await new Promise((r) => setTimeout(r, writeDelayMs));
			// Checked after the delay, because that is when a reader fails: the book has to be
			// under the head at the moment of the write, not at the moment it was noticed.
			// Lenient by default; the walk-away test asks for the honest version.
			if (strictWrites && !pad.some((x) => String(x.sid).toLowerCase() === String(sid).toLowerCase())) {
				throw new Error('tag moved out of range');
			}
			const hex = afi.toString(16).toUpperCase().padStart(2, '0');
			writes.push({ sid: String(sid).toLowerCase(), afi, hex });
			const t = pad.find((x) => String(x.sid).toLowerCase() === String(sid).toLowerCase());
			if (t) t.security = hex;
			return true;
		},
		async readUserBlock() {
			return { word: '00000000' };
		},
		/** What to hand `install(win, { boot })` so the plugin boots against this pad. */
		installer() {
			const reader = this;
			return async () => ({
				out: {
					opened: true,
					readerVersion: '10.5.0.2',
					tags: pad.map((t) => ({ ...t })),
					error: null,
				},
				reader,
				transport: { close() {} },
			});
		},
	};
}
