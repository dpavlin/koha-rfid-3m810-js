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
 * When it is running it says so, in the corner, in the language of the desk: every
 * barcode on the pad and whether each one is `in library` or `on loan`, in colour, with
 * an arrow saying which way the book is going. Not the reader's firmware version, which
 * nobody at a desk can act on. A reader that works but is invisible is indistinguishable
 * from a reader that is not installed, and a reader that is visible but says nothing a
 * librarian can read is nearly as bad.
 *
 * What it does with a scan is decided by where the cursor is (see core/intent.js) and
 * happens in one breath: the tag is written to the state that transaction produces, the
 * barcode goes into the box, the box's form is posted. `autoSubmit: false` stops at the
 * fill; `securityBit: false` stops at the write. Nothing is typed over what a librarian
 * already typed, and nothing is posted twice for the same tag while it stays on the pad.
 *
 * While connected the pad is watched: a tag put down (or taken away) after the page
 * loaded is noticed within about half a second, the pill flashes, and a box whose barcode
 * has left the pad is filled from what is on it now. Polling stops when the tab is hidden
 * and when the page goes away, so an open tab never holds the port hostage from the 3M
 * tool or a CLI.
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
import { intentOf, stateOf, STATES } from './intent.js';

const VERSION = '0.1.0';
const ARM_KEY = 'rfid_armed';
const KEEP_KEY = 'rfid_keepwatching';
const HINT_ID = 'rfid-boot-hint';

// `boot` is injectable for the same reason `now` is: the page logic is worth testing
// with a reader that answered, and the alternative is a fake SerialPort playing back
// frames for every page-behaviour test.
export function install(win, { now = () => Date.now(), boot = bootReader } = {}) {
	const m0 = {
		version: VERSION,
		installedAt: now(),
		gate: 'dormant',
		server: win.RFID_CONTEXT || null,
		config: win.RFID_CONFIG || {},
		watching: false,
		programs: [],
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

	// Whether to keep polling the pad when the tab is not in front. Default: don't — a
	// transaction that fires on a page nobody is looking at is a surprise, and a pill
	// nobody sees is not feedback.
	//
	// The catch is that Chrome also reports `hidden` when another application covers
	// the window, so a workstation that keeps Koha behind a spreadsheet would see the
	// reader go dead. That machine opts out with ?rfid=keep, or the installation does
	// with pauseWatchWhenHidden: false. Serial itself never needed the focus — this is
	// a decision about when the plugin is allowed to act on the page.
	const idleWhenHidden = () => !(cfg.pauseWatchWhenHidden === false || store.get(KEEP_KEY) === '1');

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

	// The corner element is the librarian's only view of the reader, so it shows what is
	// under the head: every barcode on the pad, and beside each one an arrow saying which
	// way that book is supposed to go, coloured the same way. The reader's firmware
	// version is in the tooltip and on the console, where the person debugging it is.
	const PILL_BASE =
		'position:fixed;right:6px;bottom:6px;z-index:9999;font:11px/1.7 monospace;' +
		'padding:1px 5px;border:1px solid transparent;border-radius:3px;text-decoration:none;' +
		'max-width:55vw;text-align:right';

	// One chip per tag, because a stack of returns is a list and a count of them is not
	// feedback. Green arrow in, amber arrow out; a tag whose bit the plugin cannot read
	// gets a grey dot rather than a guess.
	const CHIP = 'display:inline-block;margin:0 0 0 5px;padding:0 4px;border-radius:2px;';
	const TONE = {
		in: 'color:#0c6b0c;background:#d8f0d8',
		out: 'color:#8a5300;background:#ffeccd',
		none: 'color:#555;background:#e6e6e6',
	};

	const paint = () =>
		safe('paint', () => {
			if (!hint) return;
			const d = win.document;
			const tags = m0.tags || [];
			let head = 'RFID —',
				title = 'RFID reader: dormant',
				css = 'opacity:.45;color:#666';
			if (m0.gate === 'ready') {
				head = `RFID ✓${tags.length ? '' : ' no tag on the pad'}`;
				title = `reader ${m0.readerVersion || '?'}, ${tags.length} tag(s) on the pad`;
				css = 'opacity:1;color:#075707;background:#e8f6e8;border-color:#a9d9a9';
			} else if (m0.gate === 'error') {
				head = 'RFID !';
				title = 'reader failed: ' + (m0.error || 'unknown');
				css = 'opacity:.95;color:#a11111;background:#fdeeee;border-color:#e6b3b3';
			} else if (m0.gate === 'unsupported') {
				head = 'RFID ✗';
				title = 'this browser has no Web Serial — nothing will happen here';
				css = 'opacity:.5;color:#a11111';
			} else if (m0.gate === 'needs-grant' || m0.gate === 'cancelled') {
				head = 'RFID ?';
				title = 'armed, but no device chosen yet';
				css = 'opacity:.85;color:#8a6100;background:#fff8e5;border-color:#e4cf9a';
			} else if (m0.gate === 'choosing' || m0.gate === 'booting') {
				head = 'RFID …';
				title = 'waiting for the device chooser / reader';
				css = 'opacity:.85;color:#333';
			} else if (m0.gate === 'disarmed') {
				title = 'RFID reader: disarmed (click to connect)';
			}
			for (const t of tags) {
				const s = stateOf(t.security);
				title += `; ${t.content || t.sid} ${s.word}`;
			}
			if (m0.lastAction) title += `; last: ${m0.lastAction}`;
			if (!m0.watching && m0.paused) title += `; watch paused (${m0.paused})`;
			const flashing = m0.pulseUntil && now() < m0.pulseUntil;

			// Rebuilt every paint: emptying with `textContent = ''` drops the children in
			// every browser this targets, which is also what the tests assert against. Tag
			// content only ever goes in as text, never as markup — a barcode is whatever
			// somebody wrote on the tag.
			hint.textContent = '';
			const chip = (text, tone) => {
				const s = safe('pill span', () => d.createElement('span'));
				if (!s) return;
				s.textContent = text;
				s.style.cssText = tone ? CHIP + TONE[tone] : 'margin:0 0 0 5px';
				safe('pill append', () => hint.appendChild(s));
			};
			chip(head, null);
			for (const t of tags) {
				const s = stateOf(t.security);
				chip(`${t.content || t.sid} ${s.glyph}`, s.tone);
			}
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

	// The check-in form, picked by where it posts to. Not by the field name: Koha
	// reuses name=barcode for renewal, which checks an item in *and issues it back*
	// out with a new due date.
	/*
	 * Which box a scan belongs in is answered by the cursor — see core/intent.js. The page
	 * table that used to sit here could not see the header quick-boxes, which exist on
	 * every staff page and are exactly what Koha's Alt+R / Alt+W / Alt+U focus, and it went
	 * blind on any page it had not been told about.
	 */
	const target = () => safe('intent', () => intentOf(win.document && win.document.activeElement));

	// --- what this page has already posted ------------------------------------------
	//
	// A transaction is a page load, and the book does not leave the pad during one. With no
	// memory the new page finds the same tag under the head and posts it again — once a
	// second, forever, renewing one item until the renewal limit refuses it. So a tag is
	// posted once, remembered in sessionStorage because it has to survive the reload, and
	// forgotten when the tag leaves the pad because that is a different book.
	//
	// The same list is what turns a stack of returns into a queue: each page load takes the
	// first tag that has not been posted yet, so a pile of books is checked in one pass
	// without anybody touching a keyboard.
	const POST_KEY = 'rfid_posted';
	const postedTtlMs = () => (cfg.postedTtl === undefined ? 45 : cfg.postedTtl) * 1000;

	// Pruned on every read: these entries exist to stop a loop, and a loop cannot have
	// started before the TTL has passed since the last page load.
	const postedMap = () => {
		let raw = null;
		safe('sessionStorage.get', () => (raw = win.sessionStorage.getItem(POST_KEY)));
		let map = {};
		try {
			map = JSON.parse(raw || '{}') || {};
		} catch {
			map = {};
		}
		for (const k of Object.keys(map)) if (now() - map[k] > postedTtlMs()) delete map[k];
		return map;
	};
	const savePosted = (map) =>
		safe('sessionStorage.set', () => win.sessionStorage.setItem(POST_KEY, JSON.stringify(map)));
	const postedAgo = (intent, barcode) => postedMap()[intent.word + ':' + barcode] || 0;
	const markPosted = (intent, barcode) => {
		const map = postedMap();
		map[intent.word + ':' + barcode] = now();
		savePosted(map);
	};
	// A tag that left the pad is out of the queue and stops blocking anything.
	const forgetPosted = (barcodes) => {
		const gone = (barcodes || []).filter(Boolean);
		if (!gone.length) return;
		const map = postedMap();
		const set = new Set(gone);
		let changed = false;
		for (const k of Object.keys(map)) if (set.has(k.slice(k.indexOf(':') + 1))) (delete map[k], (changed = true));
		if (changed) savePosted(map);
	};

	/**
	 * Tell the tag what this transaction is producing.
	 *
	 * Silently, and before the page goes away. Every state written here is the state the
	 * transaction is creating — that is what makes it safe to write first, and worth the
	 * 150 ms it costs. See the direction argument in core/intent.js for why being wrong
	 * about one of these is loud rather than quiet.
	 *
	 * It answers with a promise even when there is nothing to do, because `act` must not
	 * post until the tag has heard: posting navigates, navigation closes the serial port,
	 * and a write still in flight is a tag silently unwritten. That is the bug this whole
	 * rewrite exists to remove, so it is not left to a race.
	 */
	const fixBit = (tag, intent) => {
		const want = intent.state ? STATES[intent.state] : null;
		if (!want || want.afi === null) return Promise.resolve(false); // a card, or nothing to say
		if (cfg.securityBit === false) return Promise.resolve(false);
		if (stateOf(tag.security).afi === want.afi) return Promise.resolve(false); // already right: no write, no wear
		if (!reader) return Promise.resolve(false);
		return Promise.resolve()
			.then(() => reader.writeAfi(tag.sid, want.afi))
			.then(() => {
				const t = (m0.tags || []).find((x) => String(x.sid).toLowerCase() === String(tag.sid).toLowerCase());
				if (t) t.security = want.hex; // the watcher compares SIDs, so it would not notice
				m0.lastAction = `${tag.content} now ${want.word}`;
				note('security bit written', `${tag.content}: ${want.hex} (${want.word})`);
				return true;
			})
			.catch((e) => {
				// No warning. The pill shows the bit as the tag last reported it, which is
				// the truth; the reason is here for whoever gets asked later.
				note('security bit NOT written', `${tag.content} ${want.hex}: ${(e && e.message) || e}`);
				return false;
			});
	};

	/**
	 * The one page action this plugin has, and the only asynchronous one — everything else
	 * that awaits is the port itself. Read the pad, ask the cursor what it wants, tell the
	 * tag, fill the box, post it. In that order, because posting navigates and takes the
	 * port with it.
	 *
	 * `replaceStale` is what makes watching useful: once the barcode in the box is no longer
	 * on the pad, whatever it referred to has been dealt with, and whatever is on the pad now
	 * takes its turn.
	 */
	const doAct = ({ replaceStale = false } = {}) => {
		const t = target();
		if (!t) return Promise.resolve(null); // the cursor is nowhere of ours
		if (cfg.fill === false) return Promise.resolve(null);
		const seen = (m0.tags || []).filter((x) => x.content);
		if (!seen.length) return Promise.resolve(null);

		// Books for the item boxes: a patron card under the head at a returns desk is not a
		// return. Cards are welcome in the patron box, which is what it is for.
		const prefix = cfg.bookPrefix || '';
		const ours = (x) => t.kind !== 'item' || !prefix || String(x.content).startsWith(prefix);
		const pick = seen.filter(ours).find((x) => !postedAgo(t, x.content));
		if (!pick) {
			note(`${t.word}: nothing to post`, `${seen.length} tag(s) on the pad, none of them new`);
			return Promise.resolve(null);
		}
		// Only an empty box, or one we filled, is ours. A barcode that is already in the box was
		// put there by a person — typed, or scanned by a keyboard wedge, which is the same thing
		// to this code — and the transaction it belongs to is theirs: the plugin fills boxes, it
		// does not press Return on someone else's typing. A value that has left the pad is stale,
		// and on a rescan stale loses.
		const typedByUs = m0.filled === pick.content;
		if (t.field.value && !typedByUs && (!replaceStale || seen.some((x) => x.content === t.field.value))) {
			note(`${t.word} box left alone`, `holds "${t.field.value}"`);
			return Promise.resolve(null);
		}

		t.field.value = pick.content;
		m0.filled = pick.content;
		safe('focus', () => t.field.focus && t.field.focus());
		note(`${t.word} box filled`, `${pick.content} (sid ${pick.sid}) from ${seen.length} tag(s) on the pad`);
		paint();

		// The tag first, then the navigation. A disabled auto-submit stops here: filling is
		// the whole job on a workstation that wants to press Return itself.
		return fixBit(pick, t).then(() => {
			// Painted again because the tag may have just changed state: the pill that stays
			// behind says what the tag says now, and after a write it should not say otherwise.
			paint();
			if (cfg.autoSubmit === false) {
				m0.lastAction = `${pick.content} filled, not posted`;
				return { word: t.word, barcode: pick.content, posted: false };
			}
			markPosted(t, pick.content);
			m0.lastAction = `${t.word}: ${pick.content}`;
			note(`${t.word} posted`, pick.content);
			stopWatch(`${t.word} posted`);
			safe('submit', () => t.form.submit());
			return { word: t.word, barcode: pick.content, posted: true };
		});
	};

	/**
	 * One transaction at a time. A stack shifting under the head makes the watch fire again
	 * while the first book's write is still open, and two posts on one page load is one too
	 * many: at best an "item is not checked out" error where the return already worked, at
	 * worst a second issue. A caller that arrives mid-transaction is not queued behind it —
	 * the transaction in flight will have posted by the time it matters, and the page it
	 * posted is already navigating away.
	 */
	let inFlight = null;
	const act = (opts) => {
		if (inFlight) return inFlight;
		const p = doAct(opts).finally(() => {
			if (inFlight === p) inFlight = null;
		});
		inFlight = p;
		return p;
	};

	const start = async (ports) => {
		m0.gate = 'booting';
		const { out, reader: r, transport: t } = await boot({ port: ports[0], log: (s, d) => note(s, d) });
		reader = r;
		transport = t;
		Object.assign(m0, out);
		m0.gate = out.error ? 'error' : 'ready';
		note('gate', m0.gate);
		paint();
		if (m0.gate === 'ready') {
			// One tag per page load: act() posts and navigates, and the page that comes back
			// takes the next one. When there is nothing to post the watch is the whole job, so
			// a book put down after this page loaded is treated like one that was here already.
			startWatch();
			act();
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
			return {
				tags: tags.map(({ sid, content, security }) => ({
					sid,
					content,
					security,
				})),
			};
		} catch (e) {
			return { error: String((e && e.message) || e) };
		}
	};

	// The surface a human types at. `inventory` is the cheap look at the pad (one
	// command, no EPC memory read) and `stop` hands the port back — the CLI cannot
	// open it while a browser tab is holding it.
	m0.connect = connect;
	m0.stop = stop;
	m0.inventory = () => (reader ? reader.inventory() : Promise.resolve(null));
	// What has been posted for the tags on the pad, so "why didn't it check this in twice"
	// and "why is my book sitting there" are answerable without the log: the tag leaves the
	// pad, or postedTtl seconds pass, and it is eligible again.
	m0.posted = () => postedMap();
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
				m0.tags = tags.map(({ sid, content, security, tag_type }) => ({
					sid,
					content,
					security,
					tag_type,
				}));
				const names = (list) => list.map((t) => t.content || t.sid).join(' ');
				note(
					'pad changed',
					`${added.length ? `+${names(added)} ` : ''}${removed.length ? `-${names(removed)}` : ''}`.trim() +
						` (${m0.tags.length} on the pad)`,
				);
				pulse();
				// A book taken off the pad is dealt with: it leaves the queue, and whatever
				// stayed on it gets its turn.
				forgetPosted(removed.map((t) => t.content));
				act({ replaceStale: true });
			},
			onError: (msg, n) => note(n ? `watch error #${n}` : 'watch error', msg),
			onStop: (why) => {
				m0.watching = false;
				m0.paused = why;
				note('watch stopped', why);
				paint();
			},
		});
		pad.start();
		m0.watching = true;
		m0.paused = null;
		m0.watch = pad.stats;
		note('watching the pad', `inventory every ${every} ms`);
		paint();

		// A page that is going away must not leave the port open behind the next one;
		// a page that is only out of sight idles, unless this workstation opted out.
		safe('watch listeners', () => {
			const d = win.document;
			if (!pad || !d || !d.addEventListener) return;
			d.addEventListener('visibilitychange', () => {
				if (d.hidden) {
					if (idleWhenHidden()) pad.stop('tab hidden');
					else note('tab hidden — keep-watching is on, still polling');
				} else if (!pad.stats.on) {
					pad.start();
					m0.watching = true;
					m0.paused = null;
					note('watch resumed');
					paint();
				}
			});
			win.addEventListener('pagehide', () => stopWatch('page hiding'));
		});
	};

	// Manual re-scan, for the moment a librarian is not sure the pad was read.
	const rescan = async () => {
		if (!reader) return { error: 'not connected' };
		try {
			const { tags } = await reader.scan();
			m0.tags = tags.map(({ sid, content, security, tag_type }) => ({
				sid,
				content,
				security,
				tag_type,
			}));
			note('rescan', `${m0.tags.length} tag(s) on the pad`);
			pulse();
			act({ replaceStale: true });
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
		if (cfg.programming !== true)
			return {
				error: 'tag programming is off for this installation (config: "programming": true)',
			};
		const entry = await programTag({
			reader,
			tags: m0.tags || [],
			sid,
			content,
			bookPrefix: cfg.bookPrefix,
			log: note,
			...opts,
		});
		m0.programs.push(entry);
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

	// Keep polling the pad even when the tab is not in front — for a workstation where
	// Koha sits behind another window, and for testing on real hardware without having
	// to keep the browser focused.
	m0.keepWatching = (on = true) => {
		on ? store.set(KEEP_KEY, '1') : store.del(KEEP_KEY);
		note('keep-watching', on ? 'on' : 'off');
		if (!on && win.document && win.document.hidden && pad) pad.stop('tab hidden');
		return !idleWhenHidden();
	};

	m0.scan = scan;
	// what the plugin thinks this page's scan box is — the answer when a fill goes to
	// the wrong place, or nowhere: `null` means the cursor is not in a box this plugin acts
	// on, which is the normal state of a staff page that is not being used to circulate
	m0.target = () => {
		const t = safe('target', target);
		return t
			? {
					word: t.word,
					kind: t.kind,
					state: t.state,
					posts: t.posts,
					id: t.field.id || null,
					disabled: !!t.field.disabled,
					value: t.field.value,
				}
			: null;
	};
	m0.rescan = rescan;
	// The one page action, exposed so it can be driven — and awaited — from a console.
	m0.act = act;
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
		if (params && (params.get('rfid') === 'keep' || params.get('rfid') === 'nokeep')) {
			const keep = params.get('rfid') === 'keep';
			setArmed(true); // asking to keep watching is asking for the reader to run
			m0.keepWatching(keep);
			safe('replaceState', () => win.history.replaceState(null, '', win.location.pathname));
		} else if (params && params.get('rfid') === '1') {
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
