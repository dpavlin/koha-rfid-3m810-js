/*
 * Web Serial transport for the 3M 810 (Chromium and Firefox 151+ desktop).
 * Uses only the standard API surface: requestPort/getPorts, port.open, the
 * readable/writable streams and reader/writer locks — nothing Chromium-specific.
 *
 *   const port = await SerialTransport.pick();      // needs a user gesture
 *   const t = new SerialTransport(port);
 *   await t.open();
 *   const r = new Reader3M(t);
 *
 * A background loop keeps draining the port into a queue, so frames can be
 * parsed across read boundaries and nothing is lost between commands.
 */

export class SerialTransport {
	static BAUD = 19200;

	/** show the browser chooser; returns null if the user cancelled */
	static async pick(filters) {
		try {
			return await navigator.serial.requestPort(filters ? { filters } : {});
		} catch {
			return null;
		}
	}

	/** ports the site was already granted access to */
	static async remembered() {
		return await navigator.serial.getPorts();
	}

	constructor(port, { baud = SerialTransport.BAUD, log } = {}) {
		this.port = port;
		this.baud = baud;
		this.log = log || (() => {});
		this.queue = [];
		this.waiters = [];
		this.abort = null;
		this.reading = null;
		this.reader = null;
	}

	async open() {
		if (!this.port.readable) await this.port.open({ baudRate: this.baud });
		this.abort = new AbortController();
		this.reading = this._drain(this.abort.signal);
	}

	async _drain(signal) {
		while (this.port.readable && !signal.aborted) {
			const reader = this.port.readable.getReader();
			this.reader = reader;
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done || signal.aborted) break;
					if (value && value.length) this._push(value);
				}
			} catch (e) {
				this.log('read error', String(e && e.message ? e.message : e));
			} finally {
				this.reader = null;
				try { reader.releaseLock(); } catch { /* already released */ }
			}
			if (signal.aborted) break;
			await new Promise((r) => setTimeout(r, 20)); // port busy/closed: retry
		}
	}

	_push(chunk) {
		const w = this.waiters.shift();
		if (w) w(chunk);
		else this.queue.push(chunk);
		if (this.queue.length > 64) this.queue.shift();
	}

	/** nobody waits on a closed port */
	_wakeAll() {
		while (this.waiters.length) this.waiters.shift()(new Uint8Array(0));
	}

	async write(bytes) {
		const writer = this.port.writable.getWriter();
		try {
			await writer.write(bytes);
		} finally {
			writer.releaseLock();
		}
	}

	/** next chunk of received bytes, empty if nothing within timeoutMs */
	async read(timeoutMs) {
		if (this.queue.length) return this.queue.shift();
		return await new Promise((resolve) => {
			const timer = setTimeout(() => {
				const i = this.waiters.indexOf(waiter);
				if (i >= 0) this.waiters.splice(i, 1);
				resolve(new Uint8Array(0));
			}, timeoutMs);
			const waiter = (chunk) => { clearTimeout(timer); resolve(chunk); };
			this.waiters.push(waiter);
		});
	}

	/** recovery: the reader stops answering until it is re-opened */
	async reset() {
		await this.close();
		await new Promise((r) => setTimeout(r, 250));
		await this.open();
	}

	/** close must never hang: the reader may be mid-command when the user hits disconnect */
	async close() {
		const beat = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
		if (this.abort) this.abort.abort();
		this._wakeAll();
		// the reader held by _drain() owns the pending read(); cancel it or port.close() fails
		if (this.reader) await beat(this.reader.cancel(), 400);
		await beat(this.reading, 400);
		for (let i = 0; i < 3; i++) {
			try {
				await this.port.close();
				break;
			} catch (e) {
				this.log('~~', 'close retry: ' + String(e && e.message ? e.message : e));
				await new Promise((r) => setTimeout(r, 200));
			}
		}
		this.reading = null;
		this.reader = null;
		this.abort = null;
		this.queue.length = 0;
	}
}
