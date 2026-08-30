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
 * M1 replaces the inside of this file with the session state machine, the scan
 * loop and the toast/status UI; the page logic from koha-rfid.js moves in next
 * to it unchanged. Everything above this line stays the same either way.
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
		out.tags = tags.map(({ sid, content, security, tag_type }) => ({ sid, content, security, tag_type }));
	} catch (e) {
		out.error = String((e && e.message) || e);
		try {
			await t.close();
		} catch {
			/* nothing useful to do on a failed close */
		}
	}
	return { out, reader: r, transport: r ? t : null };
}
