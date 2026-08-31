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
	const calls = { listeners: [], createElement: 0, appended: 0, elements: [] };
	const storage = {};
	if (armed) storage.rfid_armed = '1';

	const el = () => ({ style: { cssText: '' }, addEventListener() {}, textContent: '', href: '', title: '', id: '' });
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
		URLSearchParams,
		document: {
			getElementById: () => null,
			querySelector: () => null,
			querySelectorAll: () => [],
			createElement: () => (calls.createElement++, calls.elements.push(el()) && calls.elements.at(-1)),
			forms,
			body: { appendChild: () => calls.appended++ },
		},
		addEventListener: (type) => calls.listeners.push(type),
		RFID_CONFIG: config,
		RFID_CONTEXT: context,
	};
	return { win, calls, storage, elements: calls.elements };
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
