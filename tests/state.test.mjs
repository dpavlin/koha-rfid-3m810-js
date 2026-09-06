/*
 * The state dump's probe, evaluated against a fake page.
 *
 * state.mjs shipped broken once — a backtick in a comment, inside the template literal the probe
 * is stored in, which ended the string and killed the file at import. Nothing caught it because
 * nothing imports state.mjs: no unit test touches it, and `node --check` on other files knows
 * nothing about it. So this test does the two things the tool does — parse the file, run the
 * probe as an expression in a page-shaped context — against a page with state in it.
 *
 *   node --test tests/state.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { PROBE, main } from '../tools/live/state.mjs';

const el = (textContent, { visible = true, form = null, id = '' } = {}) => ({
	id,
	textContent,
	form: form ? { getAttribute: () => form } : null,
	getClientRects: () => (visible ? [{ x: 0 }] : []),
});

const store = (o = {}) => {
	const keys = Object.keys(o);
	return { length: keys.length, key: (i) => keys[i], getItem: (k) => (k in o ? o[k] : null) };
};

const page = ({ m0, dialogs = [], fields = [], pill = null, panel = null, login = false } = {}) => {
	const sandbox = {
		URLSearchParams,
		JSON,
		console,
		location: {
			href: 'https://koha.test/cgi-bin/koha/catalogue/moredetail.pl?itemnumber=407&biblionumber=99',
			pathname: '/cgi-bin/koha/catalogue/moredetail.pl',
			search: '?itemnumber=407&biblionumber=99',
		},
		document: {
			title: 'Koha › Catalogue',
			querySelectorAll: (sel) => {
				if (sel === 'div.dialog.message') return dialogs;
				if (sel.startsWith('input[name=barcode')) return fields;
				return [];
			},
			querySelector: (sel) =>
				sel === '#rfid-boot-hint' ? pill : sel === '#rfid-program' ? panel : login ? el('') : null,
			activeElement: { tagName: 'INPUT', id: 'barcode', name: 'barcode' },
		},
		localStorage: store({ rfid_armed: '1' }),
		sessionStorage: store({ rfid_posted: '{"checkin:1302079605":1788626529352}' }),
	};
	sandbox.window = {
		rfidM0: m0,
		RFID_CONTEXT: { branch: 'FFZG', userid: 'staff' },
		RFID_CONFIG: { autoSubmit: true },
		RFID_ITEM: m0 ? { itemnumber: 407, barcode: '1302079605' } : null,
	};
	return vm.runInContext(PROBE, vm.createContext(sandbox));
};

test('the probe parses and dumps the shapes the tool promises', () => {
	const m0 = {
		gate: 'ready',
		watching: true,
		log: ['1 one', '2 two', '3 three', '4 four', '5 five'],
		logDropped: 3,
		programs: [{ at: 1, sid: 'e004', from: '1300000000', to: '1302079605', verified: true }],
		tags: [{ sid: 'e004', content: '1302079605', security: 'D7' }],
		paused: null,
	};
	const out = JSON.parse(
		page({
			m0,
			pill: el('RFID ✓ 1302079605 OUT'),
			dialogs: [el('Press F4 to add RFID tag'), el('Other message', { visible: false })],
			fields: [
				el('', { id: 'ret_barcode', form: 'returns.pl' }),
				el('1302079605', { id: 'ren_barcode', visible: false, form: 'renew.pl' }),
			],
		}),
	);

	assert.deepEqual(
		Object.keys(out).sort(),
		['koha', 'log', 'page', 'plugin', 'server', 'storage'],
		'the top-level shape is the contract tools/docs rely on',
	);
	assert.equal(out.page.params.itemnumber, '407');
	assert.equal(out.page.focus, 'INPUT#barcode[barcode]');
	assert.equal(out.koha.pill, 'RFID ✓ 1302079605 OUT');
	assert.deepEqual(
		out.koha.barcodeFields.map((f) => `${f.id}/${f.visible ? 'vis' : 'hid'}/${f.form}`),
		['ret_barcode/vis/returns.pl', 'ren_barcode/hid/renew.pl'],
	);
	assert.deepEqual(
		out.koha.dialogs2012.map((d) => `${d.mentionsF4 ? 'F4' : '-'}${d.visible ? '+vis' : '-hid'}`),
		['F4+vis', '--hid'],
	);
	assert.equal(out.server.RFID_ITEM.barcode, '1302079605');
	assert.deepEqual(Object.keys(out.plugin).sort(), ['gate', 'paused', 'programs', 'tags', 'watching']);

	// The point of the three numbers: a page that dropped 3 lines must not look like a page that
	// only ever wrote 5.
	assert.deepEqual(out.log, { total: 8, droppedByRing: 3, droppedByDump: 0, shown: 5, lines: m0.log });
	assert.equal(out.plugin.log, undefined, 'the log is reported once, with its counters');
	assert.deepEqual(out.storage, {
		localStorage: { rfid_armed: '1' },
		sessionStorage: { rfid_posted: '{"checkin:1302079605":1788626529352}' },
	});
});

test('a logged-out tab is described, not invented', () => {
	const out = JSON.parse(page({ m0: undefined, login: true }));
	assert.equal(out.plugin, null, 'no plugin, so no plugin state — and no throw either');
	assert.equal(out.log.total, 0);
	assert.deepEqual(
		out.storage.localStorage,
		{ rfid_armed: '1' },
		'the browser is still enrolled; the session is not',
	);
});

test('main exists so the tool can be run from a shell', () => {
	assert.equal(typeof main, 'function');
});
