/*
 * A window like the Koha staff client, small enough to reason about.
 *
 * `install()` only ever touches a handful of browser surfaces, so the fake is honest
 * about them rather than pretending to be a DOM: forms are objects with getAttribute /
 * elements / submit, location has a pathname (page logic picks the scan box by page —
 * circulation.pl has three forms whose field is named `barcode`), and the elements the
 * plugin creates are returned so a test can read their text and title.
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
	config = {},
	context = { page: '/intranet/circ/returns.pl', branch: 'FFZG', userid: 'dpavlin@ffzg.hr' },
} = {}) {
	const calls = { listeners: [], docListeners: [], createElement: 0, appended: 0, elements: [] };
	const timers = { intervals: [], cleared: [] };
	const storage = {};
	if (armed) storage.rfid_armed = '1';

	// Enough element for the pill (style, textContent, title) and for the security alarm,
	// which nests one row per book and clears itself with `textContent = ''`. The setter
	// clears the children because that is what a browser does, and an element that kept
	// them would let the alarm pass a test while still showing last book's barcode.
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
			setAttribute(k, v) {
				this.attrs[k] = v;
			},
			addEventListener(type, fn) {
				(this.handlers[type] ||= []).push(fn);
			},
			appendChild(n) {
				this.children.push(n);
				return n;
			},
			dispatch(type, ev = {}) {
				for (const fn of this.handlers[type] || []) fn({ preventDefault() {}, ...ev });
			},
			querySelector(sel) {
				if (sel !== 'button') return null;
				const walk = (n) => n.children.find((c) => c.tag === 'button') || n.children.map(walk).find(Boolean) || null;
				return walk(this);
			},
			focus() {
				this.focusCalls = (this.focusCalls || 0) + 1;
			},
		};
		Object.defineProperty(node, 'textContent', {
			get() {
				return this.children.length ? '' : this.text;
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
			data: {},
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
			querySelectorAll: () => [],
			createElement: (tag) => (calls.createElement++, calls.elements.push(Object.assign(el(), { tag })) && calls.elements.at(-1)),
			addEventListener: (type, fn) => (calls.docListeners[type] ||= []).push(fn),
			dispatch(type, ev = {}) {
				for (const fn of calls.docListeners[type] || []) fn({ preventDefault() {}, ...ev });
			},
			forms,
			body: { children: [], appendChild(n) { return calls.appended++, this.children.push(n) && n; } },
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

/** A field of a Koha form, as the code sees it. */
export const field = ({ id, value = '', disabled = false } = {}) => ({
	id,
	name: 'barcode',
	value,
	disabled,
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
export function form(action, { id = '', fields = {} } = {}) {
	const f = {
		id,
		elements: fields,
		getAttribute: (k) => (k === 'action' ? action : null),
		submits: 0,
		submit() {
			this.submits++;
		},
	};
	for (const [name, el] of Object.entries(fields)) el.name = name;
	return f;
}

/** A reader that answered: page logic needs one, and no fake SerialPort. */
export const fakeBoot = (tags, extra = {}) => async () => ({
	out: { opened: true, readerVersion: '10.5.0.2', tags, error: null, ...extra },
	reader: { async inventory() { return tags.map((t) => t.sid); } },
	transport: {},
});
