/*
 * Dormant-by-default bootstrap, inlined by the Koha plugin on a handful of pages.
 *
 * Copyright (C) 2026 Dobrica Pavlinusic <dpavlin@rot13.org>
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later
 * version. See LICENSE in the repository root.
 *
 * The rule this file exists to enforce: a librarian whose workstation has no RFID
 * reader must notice nothing. So, in this order —
 *
 *   1. no navigator.serial                      -> stop. No DOM, no listeners, no timers.
 *   2. no port granted for this origin AND
 *      localStorage.rfid_armed not set          -> stop, after registering the two
 *                                                  opt-in affordances only
 *                                                  (Ctrl+Alt+R, and ?rfid=1).
 *   3. armed + remembered port                  -> boot the app, silently.
 *
 * A granted port is remembered by Chrome for this origin, so step 3 costs no user
 * interaction from then on: getPorts() + open() need no gesture, requestPort() does.
 *
 * Nothing in here may throw into the host page — RFID is an accelerator, never a
 * dependency. Everything is wrapped, and window.rfidM0 carries the diagnosis for
 * remote debugging over CDP (see docs/rollout.md).
 *
 * install(win) takes the global object as an argument so the dormancy rules above
 * are testable in plain node (tests/boot.test.mjs).
 */

import { boot as bootReader } from '../main.js';

const VERSION = '0.1.0';
const ARM_KEY = 'rfid_armed';
const HINT_ID = 'rfid-boot-hint';

export function install(win, { now = () => Date.now() } = {}) {
	const m0 = {
		version: VERSION,
		installedAt: now(),
		gate: 'dormant',
		server: win.RFID_CONTEXT || null,
		config: win.RFID_CONFIG || {},
		log: [],
	};
	win.rfidM0 = m0;

	const note = (step, value) => {
		m0.log.push(`${now()} ${step}${value === undefined ? '' : ': ' + value}`);
		return m0.log.length;
	};
	const safe = (what, fn) => {
		try {
			return fn();
		} catch (e) {
			note(`${what} failed`, String((e && e.message) || e));
			return undefined;
		}
	};
	const store = {
		get: (k) => safe('localStorage.get', () => win.localStorage.getItem(k)),
		set: (k, v) => safe('localStorage.set', () => win.localStorage.setItem(k, v)),
		del: (k) => safe('localStorage.del', () => win.localStorage.removeItem(k)),
	};

	// --- gate 1: does this browser speak Web Serial at all? -------------------
	const serial = safe('navigator.serial', () => win.navigator && win.navigator.serial);
	if (!serial) {
		m0.gate = 'unsupported';
		note('no navigator.serial — staying dormant');
		return m0;
	}
	m0.hasSerial = true;

	const cfg = m0.config;
	const isArmed = () => store.get(ARM_KEY) === '1';
	const setArmed = (on) => (on ? store.set(ARM_KEY, '1') : store.del(ARM_KEY));

	// Ports are reached through the injected window, never the global navigator,
	// so the dormancy rules stay testable in plain node (tests/boot.test.mjs).
	const portsOf = async () => {
		try {
			return (await serial.getPorts()) || [];
		} catch (e) {
			note('getPorts failed', String((e && e.message) || e));
			return [];
		}
	};

	// --- the app itself (armed path) -----------------------------------------
	let reader = null;
	let transport = null;

	const start = async (ports) => {
		m0.gate = 'booting';
		const { out, reader: r, transport: t } = await bootReader({ port: ports[0], log: (s, d) => note(s, d) });
		reader = r;
		transport = t;
		Object.assign(m0, out);
		m0.gate = out.error ? 'error' : 'ready';
		note('gate', m0.gate);
		return m0;
	};

	const connect = async () => {
		m0.gate = 'choosing';
		// the only gesture-requiring call in the whole codebase
		let port = null;
		try {
			port = await serial.requestPort();
		} catch (e) {
			note('requestPort failed', String((e && e.message) || e));
		}
		if (!port) {
			m0.gate = 'cancelled';
			note('chooser cancelled');
			return m0;
		}
		setArmed(true);
		return start([port]);
	};

	const stop = async () => {
		setArmed(false);
		m0.gate = 'disarmed';
		if (transport) safe('close', () => transport.close());
		reader = null;
		transport = null;
		return m0;
	};

	const scan = async () => {
		if (!reader) return { error: 'not connected' };
		try {
			const { tags } = await reader.scan();
			return { tags: tags.map(({ sid, content, security }) => ({ sid, content, security })) };
		} catch (e) {
			return { error: String((e && e.message) || e) };
		}
	};

	m0.connect = connect;
	m0.stop = stop;
	m0.scan = scan;

	// --- gate 2: opt-in affordances, and nothing else ------------------------
	const arm = () => {
		setArmed(true);
		note('armed');
		return connect();
	};

	win.addEventListener('keydown', (ev) => {
		if (ev.ctrlKey && ev.altKey && (ev.key === 'r' || ev.key === 'R' || ev.code === 'KeyR')) {
			ev.preventDefault();
			safe('shortcut', () => (isArmed() ? stop() : arm()));
		}
	});

	if (cfg.hint !== false)
		safe('hint', () => {
			const d = win.document;
			if (!d || d.getElementById(HINT_ID)) return;
			const el = d.createElement('a');
			el.id = HINT_ID;
			el.href = '#';
			el.textContent = 'RFID';
			el.title = 'RFID reader — Ctrl+Alt+R to connect or disconnect';
			el.style.cssText = 'position:fixed;right:6px;bottom:6px;z-index:9999;font:11px/1.4 monospace;opacity:.45;color:#666';
			el.addEventListener('click', (ev) => {
				ev.preventDefault();
				safe('hint click', () => arm());
			});
			(d.getElementById('footer') || d.body || d.documentElement).appendChild(el);
		});

	// --- gate 3: armed already? reconnect silently, no gesture needed --------
	m0.done = (async () => {
		const params = safe('search', () => new win.URLSearchParams(win.location.search));
		if (params && params.get('rfid') === '1') {
			setArmed(true);
			note('armed via ?rfid=1');
			safe('replaceState', () => win.history.replaceState(null, '', win.location.pathname));
		} else if (params && params.get('rfid') === '0') {
			setArmed(false);
			m0.gate = 'disarmed';
			return;
		}

		const ports = await portsOf();
		m0.ports = ports.length;
		if (!isArmed()) {
			m0.gate = 'idle';
			note('not armed — dormant', `ports remembered: ${ports.length}`);
			return;
		}
		if (!ports.length) {
			m0.gate = 'needs-grant';
			note('armed but no port granted — needs one click');
			return;
		}
		await start(ports);
	})().catch((e) => {
		m0.gate = 'error';
		note('boot threw', String((e && e.message) || e));
	});

	return m0;
}

/* c-f-i-f-e: the plugin inlines this bundle, so run on load. */
if (typeof window !== 'undefined' && typeof window.document !== 'undefined') install(window);
