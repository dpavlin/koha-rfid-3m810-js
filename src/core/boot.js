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
 * When it is running it says so: the corner element is a status pill (`RFID ✓
 * 10.5.0.2 · 3`), not just an opt-in link, and the first item barcode from a scan
 * is written into the check-in box — never submitted, and never over what a
 * librarian already typed. A reader that works but is invisible is indistinguishable
 * from a reader that is not installed.
 *
 * While connected the pad is watched: a tag put down (or taken away) after the page
 * loaded is noticed within about half a second, the pill flashes, and a check-in box
 * whose barcode has left the pad is refilled from what is on it now. Polling stops
 * when the tab is hidden and when the page goes away, so an open tab never holds the
 * port hostage from the 3M tool or a CLI.
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

import { boot as bootReader, watch } from '../main.js';
import { programTag, readTag } from './tagwrite.js';

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
		watching: false,
		writes: [],
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
	let hint = null;

	// The corner element doubles as the status light. Everything worth knowing
	// before scanning is in it: connected or not, reader version, how many tags it
	// can see, or what failed.
	const PILL_BASE =
		'position:fixed;right:6px;bottom:6px;z-index:9999;font:11px/1.4 monospace;' +
		'padding:1px 5px;border:1px solid transparent;border-radius:3px;text-decoration:none';

	const paint = () =>
		safe('paint', () => {
			if (!hint) return;
			const n = (m0.tags || []).length;
			let text = 'RFID —', title = 'RFID reader: dormant', css = 'opacity:.45;color:#666';
			if (m0.gate === 'ready') {
				const seen = (m0.tags || []).map((t) => t.content || t.sid).join(', ');
				text = `RFID ✓ ${m0.readerVersion || '?'}${n ? ` · ${n}` : ''}`;
				title = `reader ${m0.readerVersion}; ${n} tag(s)${seen ? ': ' + seen : ''}`;
				css = 'opacity:1;color:#075707;background:#e8f6e8;border-color:#a9d9a9';
			} else if (m0.gate === 'error') {
				text = 'RFID !';
				title = 'reader failed: ' + (m0.error || 'unknown');
				css = 'opacity:.95;color:#a11111;background:#fdeeee;border-color:#e6b3b3';
			} else if (m0.gate === 'unsupported') {
				text = 'RFID ✗';
				title = 'this browser has no Web Serial — nothing will happen here';
				css = 'opacity:.5;color:#a11111';
			} else if (m0.gate === 'needs-grant' || m0.gate === 'cancelled') {
				text = 'RFID ?';
				title = 'armed, but no device chosen yet';
				css = 'opacity:.85;color:#8a6100;background:#fff8e5;border-color:#e4cf9a';
			} else if (m0.gate === 'choosing' || m0.gate === 'booting') {
				text = 'RFID …';
				title = 'waiting for the device chooser / reader';
				css = 'opacity:.85;color:#333';
			} else if (m0.gate === 'disarmed') {
				title = 'RFID reader: disarmed (click to connect)';
			}
			const flashing = m0.pulseUntil && now() < m0.pulseUntil;
			hint.textContent = text;
			hint.title = `${title}${m0.watching ? ' (watching)' : ''} — click, or Ctrl+Alt+R`;
			hint.style.cssText = `${PILL_BASE};${css}${flashing ? ';background:#fff3b0;opacity:1' : ''}`;
		});

	// Brief highlight when the pad changes: a librarian who is looking at the
	// screen, not at the reader, should still notice that something changed.
	let pulseTimer = null;
	const pulse = () => {
		m0.pulseUntil = now() + 1200;
		paint();
		if (pulseTimer) safe('clear pulse', () => clearTimeout(pulseTimer));
		pulseTimer = safe('pulse timer', () =>
			setTimeout(() => {
				m0.pulseUntil = 0;
				paint();
			}, 1300),
		);
	};

	// M1's first slice of page logic, deliberately small: put a scanned barcode in
	// the check-in box and let the librarian press Return. Books first, because a
	// patron card on the pad is just another 10-digit barcode as far as we know.
	//
	// `replaceStale` is what makes watching useful: once the barcode in the box is
	// no longer on the pad, whatever it referred to has been dealt with, so a tag
	// that is on the pad should take its place.
	const fillCheckin = ({ replaceStale = false } = {}) =>
		safe('fill checkin', () => {
			if (cfg.fillCheckin === false || !win.document || !win.document.forms) return;
			const seen = (m0.tags || []).filter((t) => t.content);
			if (!seen.length) return;
			const form = [...win.document.forms].find((f) => /circ\/returns\.pl$/.test(f.getAttribute('action') || ''));
			if (!form || !form.elements || !form.elements['barcode']) return;
			const field = form.elements['barcode'];
			if (field.value) {
				const onPad = seen.some((t) => t.content === field.value);
				if (onPad || !replaceStale) {
					note('checkin left alone', `field holds "${field.value}"${onPad ? ' (still on the pad)' : ''}`);
					return;
				}
			}
			const pick = (cfg.bookPrefix && seen.find((t) => t.content.startsWith(cfg.bookPrefix))) || seen[0];
			if (pick.content === field.value) return;
			field.value = pick.content;
			m0.filled = pick.content;
			safe('focus', () => field.focus && field.focus());
			note('checkin filled', `${pick.content} (sid ${pick.sid}) from ${seen.length} tag(s) on the pad`);
		});

	const start = async (ports) => {
		m0.gate = 'booting';
		const { out, reader: r, transport: t } = await bootReader({ port: ports[0], log: (s, d) => note(s, d) });
		reader = r;
		transport = t;
		Object.assign(m0, out);
		m0.gate = out.error ? 'error' : 'ready';
		note('gate', m0.gate);
		paint();
		if (m0.gate === 'ready') {
			fillCheckin();
			startWatch();
		}
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
			paint();
			return m0;
		}
		setArmed(true);
		return start([port]);
	};

	const stop = async () => {
		stopWatch('disconnected');
		setArmed(false);
		m0.gate = 'disarmed';
		paint();
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
	// --- watching: a tag put down later must not need a page reload ----------
	let pad = null;

	const stopWatch = (why) => {
		if (!pad) return;
		safe('watch stop', () => pad.stop(why));
		pad = null;
		m0.watching = false;
	};

	const startWatch = () => {
		if (cfg.watch === false || !reader || pad) return;
		const every = cfg.watchIntervalMs || 600;
		pad = watch({
			reader,
			initial: m0.tags || [],
			intervalMs: every,
			onChange: ({ tags, added, removed }) => {
				m0.tags = tags.map(({ sid, content, security, tag_type }) => ({ sid, content, security, tag_type }));
				const names = (list) => list.map((t) => t.content || t.sid).join(' ');
				note(
					'pad changed',
					`${added.length ? `+${names(added)} ` : ''}${removed.length ? `-${names(removed)}` : ''}`.trim() +
						` (${m0.tags.length} on the pad)`,
				);
				pulse();
				fillCheckin({ replaceStale: true });
			},
			onError: (msg, n) => note(n ? `watch error #${n}` : 'watch error', msg),
			onStop: (why) => {
				m0.watching = false;
				note('watch stopped', why);
				paint();
			},
		});
		pad.start();
		m0.watching = true;
		m0.watch = pad.stats;
		note('watching the pad', `inventory every ${every} ms`);
		paint();

		// A hidden tab nobody is looking at does not need to hold the port, and a
		// page that is going away must not leave it open behind the next one.
		safe('watch listeners', () => {
			const d = win.document;
			if (!pad || !d) return;
			if (d.addEventListener)
				d.addEventListener('visibilitychange', () => {
					if (!pad) return;
					if (d.hidden) pad.stop('tab hidden');
					else if (!pad.stats.on) { pad.start(); m0.watching = true; note('watch resumed'); paint(); }
				});
			win.addEventListener('pagehide', () => stopWatch('page hiding'));
		});
	};

	// Manual re-scan, for the moment a librarian is not sure the pad was read.
	const rescan = async () => {
		if (!reader) return { error: 'not connected' };
		try {
			const { tags } = await reader.scan();
			m0.tags = tags.map(({ sid, content, security, tag_type }) => ({ sid, content, security, tag_type }));
			note('rescan', `${m0.tags.length} tag(s) on the pad`);
			pulse();
			fillCheckin({ replaceStale: true });
			return { tags: m0.tags };
		} catch (e) {
			return { error: String((e && e.message) || e) };
		}
	};

	// --- writing: off unless the installation says otherwise ------------------
	// Blank is just programming with the 3M empty-tag pattern, so "blanking" a tag
	// goes through the same guard as writing a barcode onto it.
	const program = async (sid, content, opts = {}) => {
		if (!reader) return { error: 'not connected' };
		if (cfg.programming !== true) return { error: 'tag programming is off for this installation (config: "programming": true)' };
		const entry = await programTag({ reader, tags: m0.tags || [], sid, content, bookPrefix: cfg.bookPrefix, log: note, ...opts });
		m0.writes.push(entry);
		if (!entry.error) {
			// The SID set did not change, so the watcher would not notice this on its own.
			const t = (m0.tags || []).find((x) => x.sid.toLowerCase() === String(sid).toLowerCase());
			if (t) {
				t.content = entry.content || '';
				t.security = entry.afi;
			}
			pulse();
		}
		return entry;
	};

	m0.scan = scan;
	m0.rescan = rescan;
	m0.program = program;
	m0.readTag = (sid) => (reader ? readTag({ reader, sid }) : Promise.resolve({ error: 'not connected' }));
	m0.canProgram = cfg.programming === true;

	// --- gate 2: opt-in affordances, and nothing else ------------------------
	const connected = () => !!transport;

	// Clicking the corner element while connected used to open a second device
	// chooser, and picking a port there re-opened an already open port — which
	// threw, making a working reader report itself broken. Both affordances toggle.
	const arm = () => {
		if (connected()) {
			note('already connected — chooser skipped');
			return m0;
		}
		setArmed(true);
		note('armed');
		return connect();
	};

	const toggle = () => (connected() ? stop() : arm());

	win.addEventListener('keydown', (ev) => {
		if (ev.ctrlKey && ev.altKey && (ev.key === 'r' || ev.key === 'R' || ev.code === 'KeyR')) {
			ev.preventDefault();
			safe('shortcut', toggle);
		}
	});

	if (cfg.hint !== false)
		safe('hint', () => {
			const d = win.document;
			if (!d || d.getElementById(HINT_ID)) return;
			const el = d.createElement('a');
			el.id = HINT_ID;
			el.href = '#';
			el.addEventListener('click', (ev) => {
				ev.preventDefault();
				safe('pill click', toggle);
			});
			hint = el;
			paint();
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
			paint();
			return;
		}
		await start(ports);
	})().catch((e) => {
		m0.gate = 'error';
		m0.error = String((e && e.message) || e);
		note('boot threw', m0.error);
		paint();
	});

	return m0;
}

/* c-f-i-f-e: the plugin inlines this bundle, so run on load. */
if (typeof window !== 'undefined' && typeof window.document !== 'undefined') install(window);
