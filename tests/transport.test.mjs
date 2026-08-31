/*
 * The transport's recovery paths, against a fake port.
 *
 * These are the paths that only happen on real workstations: a reload that races the
 * page before it for the port, a port that is already closed when asked to close.
 * Both were seen on hardware, and one of them was reported to the librarian as a
 * broken reader on a machine that had been working a second earlier.
 *
 *   node --test tests/transport.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SerialTransport } from '../src/transport/webserial.js';

function fakePort({ openFailures = 0, closeError = null } = {}) {
	const port = { opens: 0, closes: 0, readable: null, writable: null };
	port.open = async () => {
		port.opens++;
		if (port.opens <= openFailures) throw new Error("Failed to execute 'open' on 'SerialPort': Failed to open serial port.");
		port.readable = {
			getReader: () => {
				let done;
				return {
					read: () => new Promise((resolve) => (done = () => resolve({ done: true }))),
					cancel: async () => done && done(),
					releaseLock() {},
				};
			},
		};
		port.writable = { getWriter: () => ({ write: async () => {}, releaseLock() {} }) };
	};
	port.close = async () => {
		port.closes++;
		if (closeError) throw new Error(closeError);
		port.readable = null;
		port.writable = null;
	};
	return port;
}

test('a port that is busy is opened on the next try, not reported as broken', async () => {
	const port = fakePort({ openFailures: 2 });
	const log = [];
	const t = new SerialTransport(port, { log: (s, d) => log.push(`${s} ${d}`) });

	await t.open({ backoffMs: 1 });

	assert.equal(port.opens, 3, 'tried again instead of giving up');
	assert.ok(t.abort, 'the reader is draining');
	assert.equal(log.filter((l) => l.startsWith('open retry')).length, 2, 'the retries are visible, the success is quiet');
	await t.close();
});

test('a port that never opens says so, once', async () => {
	const port = fakePort({ openFailures: 99 });
	const log = [];
	const t = new SerialTransport(port, { log: (s, d) => log.push(`${s} ${d}`) });

	await assert.rejects(() => t.open({ attempts: 2, backoffMs: 1 }), /Failed to open serial port/);
	assert.equal(port.opens, 2, 'attempts honoured');
	assert.equal(log.filter((l) => l.startsWith('open retry')).length, 1, 'the last failure is the caller to report');
});

test('already closed is closed, not a failure to retry', async () => {
	const port = fakePort({ closeError: 'The port is already closed.' });
	const log = [];
	const t = new SerialTransport(port, { log: (s, d) => log.push(`${s} ${d}`) });

	await t.open({ backoffMs: 1 });
	await t.close();

	assert.equal(port.closes, 1, 'asked once');
	assert.deepEqual(log, [], 'nothing to complain about');
});

test('a port that refuses to close is given up on, and nothing throws', async () => {
	const port = fakePort({ closeError: 'device busy' });
	const log = [];
	const t = new SerialTransport(port, { log: (s, d) => log.push(`${s} ${d}`) });

	await t.open({ backoffMs: 1 });
	await t.close();

	assert.equal(port.closes, 3, 'three tries is enough');
	assert.equal(log.length, 3, 'and each one was worth logging');
});

test('a port held by another tab says what to do about it', async () => {
	const { boot } = await import('../src/main.js');
	const { out } = await boot({ port: fakePort({ openFailures: 99 }), log: () => {} });
	assert.match(out.error, /Failed to open serial port/, 'Chrome wording is kept');
	assert.match(out.error, /another tab/, 'and the reason is spelled out');
});
