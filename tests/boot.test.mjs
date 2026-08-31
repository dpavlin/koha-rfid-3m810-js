/*
 * The "don't bother the librarians who have no reader" rule, as code.
 *
 * These tests are the reason bootstrap is written against an injected window:
 * they assert not what the code does when a reader is present, but what it does
 * NOT do when one isn't — no DOM nodes, no listeners, no timers, no prompts.
 *
 *   node --test tests/boot.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { install } from '../src/core/boot.js';

function fakeWindow({ serial = false, armed = false, ports = [], search = '', forms = [] } = {}) {
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
		location: { search, pathname: '/cgi-bin/koha/circ/returns.pl' },
		history: { replaceState() {} },
		URLSearchParams,
		document: {
			getElementById: () => null,
			createElement: () => (calls.createElement++, calls.elements.push(el()) && calls.elements.at(-1)),
			forms,
			body: { appendChild: () => calls.appended++ },
		},
		addEventListener: (type) => calls.listeners.push(type),
		RFID_CONFIG: {},
		RFID_CONTEXT: { page: '/intranet/circ/returns.pl', branch: 'FFZG' },
	};
	return { win, calls, storage, elements: calls.elements };
}

const deadPort = () => ({
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

test('browser without Web Serial: nothing at all happens', async () => {
	const { win, calls } = fakeWindow({ serial: false });
	const m0 = install(win);

	assert.equal(m0.gate, 'unsupported');
	assert.equal(calls.createElement, 0, 'no DOM nodes');
	assert.equal(calls.appended, 0, 'nothing appended');
	assert.deepEqual(calls.listeners, [], 'no listeners — not even a keydown');
	assert.equal(m0.done, undefined, 'no async work scheduled');
});

test('Web Serial but never armed: opt-in affordances only, reader untouched', async () => {
	const port = deadPort();
	const { win, calls, storage, elements } = fakeWindow({ serial: true, ports: [port] });
	const m0 = install(win);
	await m0.done;

	assert.equal(m0.gate, 'idle');
	assert.equal(elements[0].textContent, 'RFID \u2014', 'the pill advertises itself without shouting');
	assert.equal(storage.rfid_armed, undefined, 'stays unarmed');
	assert.equal(port.opens, 0, 'port never opened');
	assert.ok(calls.listeners.includes('keydown'), 'Ctrl+Alt+R registered');
	assert.equal(calls.createElement, 1, 'one discreet hint link');
});

test('armed but the port is gone: report it, never throw', async () => {
	const port = deadPort();
	const { win } = fakeWindow({ serial: true, armed: true, ports: [port] });
	const m0 = install(win);
	await m0.done;

	assert.equal(port.opens, 3, 'tried to reconnect without a gesture, a few times: a reload can race the page before it for the port');
	assert.equal(m0.gate, 'error');
	assert.match(m0.error, /no device attached/);
});

test('?rfid=1 arms this browser, and a remembered port is required before booting', async () => {
	const { win, storage } = fakeWindow({ serial: true, search: '?rfid=1', ports: [] });
	const m0 = install(win);
	await m0.done;

	assert.equal(storage.rfid_armed, '1', 'armed for later page loads');
	assert.equal(m0.gate, 'needs-grant', 'asks for one click instead of failing silently');
});

test('the corner element reports what the reader is doing, including failures', async () => {
	const { win, elements } = fakeWindow({ serial: true, armed: true, ports: [deadPort()] });
	const m0 = install(win);
	await m0.done;

	const pill = elements[0];
	assert.ok(pill, 'one corner element');
	assert.equal(pill.textContent, 'RFID !', 'a failed reader is visible, not silent');
	assert.match(pill.title, /no device attached/, 'the reason is in the tooltip');
	assert.equal(m0.filled, undefined, 'nothing is typed into the page on a failure');
});

test('the console surface survives a broken reader', async () => {
	// Debugging a reader you cannot connect to is done by typing into devtools, so the
	// surface has to exist even when nothing opened. A rewrite of this file once
	// silently dropped inventory() and stop() from it — the page still looked fine.
	const { win } = fakeWindow({ serial: true, armed: true, ports: [deadPort()] });
	const m0 = install(win);
	await m0.done;

	for (const fn of ['connect', 'scan', 'rescan', 'program', 'readTag', 'inventory', 'stop'])
		assert.equal(typeof m0[fn], 'function', `${fn} is there to type`);
	assert.equal(await m0.inventory(), null, 'no reader: inventory answers nothing, and never throws');

	await m0.stop();
	assert.equal(m0.gate, 'disarmed');
});

test('keep-watching is a switch on this workstation, not a rebuild', async () => {
	// Default is to idle while the tab is not in front. A workstation where Koha lives
	// behind another window needs the pad to keep working there — and so does anyone
	// testing on real hardware without the browser focused.
	const { win, storage } = fakeWindow({ serial: true, armed: true, ports: [deadPort()] });
	const m0 = install(win);
	await m0.done;

	assert.equal(m0.keepWatching(true), true);
	assert.equal(storage.rfid_keepwatching, '1', 'remembered for the next page load');
	assert.equal(m0.keepWatching(false), false);
	assert.equal(storage.rfid_keepwatching, undefined);
});

test('?rfid=keep arms the reader and keeps the pad polled', async () => {
	const { win, storage } = fakeWindow({ serial: true, search: '?rfid=keep', ports: [] });
	const m0 = install(win);
	await m0.done;

	assert.equal(storage.rfid_armed, '1');
	assert.equal(storage.rfid_keepwatching, '1');
});

test('?rfid=0 disarms and says so', async () => {
	const { win, storage } = fakeWindow({ serial: true, armed: true, search: '?rfid=0' });
	const m0 = install(win);
	await m0.done;

	assert.equal(storage.rfid_armed, undefined);
	assert.equal(m0.gate, 'disarmed');
});
