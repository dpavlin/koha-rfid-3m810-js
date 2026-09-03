/*
 * App entry point.
 *
 * Copyright (C) 2026 Dobrica Pavlinusic <dpavlin@rot13.org>
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later
 * version. See LICENSE in the repository root.
 *
 * M0 spike scope: open the granted port, wake the reader, do one inventory.
 * watch() adds the second half of a real workstation loop: notice tags being put
 * down and taken away. The old Go-server client is the behaviour spec, not
 * something to port: no code here talks to localhost:9000.
 */

import { Reader3M } from './driver/rfid3m.js';
import { SerialTransport } from './transport/webserial.js';

export async function boot({ port, log = () => {} }) {
	const out = { opened: false, readerVersion: null, tags: null, error: null };
	const t = new SerialTransport(port, { log });
	let r = null;
	try {
		await t.open();
		out.opened = true;
		r = new Reader3M(t, { log });
		out.readerVersion = await r.probe();
		const { tags } = await r.scan();
		out.tags = tags.map(({ sid, content, security, tag_type }) => ({
			sid,
			content,
			security,
			tag_type,
		}));
	} catch (e) {
		out.error = String((e && e.message) || e);
		// Chrome says "Failed to open serial port" and stops there. On a workstation
		// with the staff client open in two tabs — which is how the staff client is
		// used — that is the whole story: the other tab has the reader, and every
		// reload of this one will fail until it lets go. Say the useful part.
		if (/open/i.test(out.error) && /serial port/i.test(out.error))
			out.error += ' — another tab or window may be holding the reader';
		try {
			await t.close();
		} catch {
			/* nothing useful to do on a failed close */
		}
	}
	return { out, reader: r, transport: r ? t : null };
}

/*
 * Watch the pad so a tag placed later is noticed without reloading the page.
 *
 * inventory() is a single command (a few tens of ms, even over usbip); scan() reads
 * AFI and blocks for every tag, roughly 60 ms per tag. So poll inventory and pay
 * for a full scan only when the set of tags actually changed. Reader3M serialises
 * commands, so a scan here can never interleave frames with the app's own reads.
 *
 * It gives up by itself after `maxErrors` consecutive read failures — a reader on a
 * USB/IP tunnel disappears more often than a reader on a desk — and the caller owns
 * start/stop (page visibility, disconnect, pagehide).
 */
export function watch({
	reader,
	initial = [],
	intervalMs = 600,
	maxErrors = 3,
	onChange = () => {},
	onError = () => {},
	onStop = () => {},
	now = () => Date.now(),
} = {}) {
	const stats = {
		on: false,
		polls: 0,
		changes: 0,
		errors: 0,
		scanning: false,
		startedAt: null,
		stoppedAt: null,
		stopReason: null,
	};
	let stopped = true;
	let timer = null;
	let failing = 0;
	let seen = new Map(initial.map(({ sid, content }) => [sid, content]));

	const sig = (list) => list.slice().sort().join(',');

	const finish = (why) => {
		if (!stats.on) return stats; // already stopped: onStop must fire once
		stopped = true;
		if (timer) clearTimeout(timer);
		timer = null;
		stats.on = false;
		stats.stoppedAt = now();
		stats.stopReason = why;
		onStop(why);
		return stats;
	};

	const again = () => {
		if (!stopped) timer = setTimeout(tick, intervalMs);
	};

	const bump = (e) => {
		if (stopped) return undefined; // disconnected mid-read: not an error worth logging
		stats.errors++;
		failing++;
		onError(String((e && e.message) || e), failing);
		if (failing >= maxErrors) return finish(`gave up after ${failing} read failures`);
		again();
		return undefined;
	};

	async function tick() {
		if (stopped) return;
		let sids;
		try {
			sids = await reader.inventory();
		} catch (e) {
			return bump(e);
		}
		stats.polls++;
		failing = 0;

		if (sig(sids) === sig([...seen.keys()])) return again();

		stats.scanning = true;
		let tags;
		try {
			({ tags } = await reader.scan());
		} catch (e) {
			stats.scanning = false;
			return bump(e);
		}
		stats.scanning = false;

		const next = new Map(tags.map((t) => [t.sid, t.content]));
		const added = tags.filter((t) => !seen.has(t.sid));
		const removed = [...seen.keys()]
			.filter((sid) => !next.has(sid))
			.map((sid) => ({ sid, content: seen.get(sid) }));
		seen = next;
		stats.changes++;

		try {
			await onChange({ tags, added, removed });
		} catch (e) {
			stats.errors++;
			onError(`onChange: ${String((e && e.message) || e)}`, 0);
		}
		again();
	}

	return {
		start() {
			if (stats.on) return stats;
			stopped = false;
			failing = 0;
			stats.on = true;
			stats.startedAt = now();
			stats.stopReason = null;
			tick();
			return stats;
		},
		stop: finish,
		stats,
	};
}
