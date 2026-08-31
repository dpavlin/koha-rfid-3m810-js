/*
 * The pad-watching loop, without a pad.
 *
 * watch() is the difference between "reads what is there when the page loads" and
 * "reads what the librarian puts down", so its contract is worth pinning:
 *
 *   - inventory() is polled; scan() is paid for only when the set of tags changed
 *   - a change reports what was added AND what was removed, by content where known
 *   - transient read failures are reported, and the loop gives up after a few
 *   - stop() is final: no polls after it, so the port is genuinely free
 *
 *   node --test tests/watch.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { watch } from '../src/main.js';

const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what = 'condition', ms = 3000) => {
	const t0 = Date.now();
	while (!fn()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await nap(3);
	}
};

/** A reader whose pad changes on a script: each entry is what inventory() answers next. */
function fakeReader(script, contents = {}) {
	const r = { inventories: 0, scans: 0, i: 0, sids: [] };
	r.inventory = async () => {
		const step = script[Math.min(r.i, script.length - 1)];
		r.i++;
		r.inventories++;
		if (step instanceof Error) throw step;
		r.sids = step;
		return step;
	};
	r.scan = async () => {
		r.scans++;
		return { tags: r.sids.map((sid) => ({ sid, content: contents[sid] || null, security: 'DA', tag_type: 'label' })) };
	};
	return r;
}

test('an unchanged pad costs one command and no scan', async () => {
	const reader = fakeReader([['e004010031269117'], ['e004010031269117']]);
	const changes = [];
	const w = watch({
		reader,
		initial: [{ sid: 'e004010031269117', content: '1302099999' }],
		intervalMs: 4,
		onChange: (c) => changes.push(c),
	});
	w.start();
	await nap(60);
	w.stop('done');

	assert.ok(reader.inventories > 3, `polled ${reader.inventories} times`);
	assert.equal(reader.scans, 0, 'the seed tags were already known, so nothing was re-read');
	assert.equal(changes.length, 0);
});

test('a tag put down is reported once, as added, with its barcode', async () => {
	const reader = fakeReader([['e004010031269117'], ['e004010031269117', 'e00401003126a0c8']], {
		e004010031269117: '1302099999',
		e00401003126a0c8: '1302079605',
	});
	const changes = [];
	const w = watch({
		reader,
		initial: [{ sid: 'e004010031269117', content: '1302099999' }],
		intervalMs: 4,
		onChange: (c) => changes.push(c),
	});
	w.start();
	await until(() => changes.length >= 1, 'the new tag');
	await nap(40);
	w.stop('done');

	assert.equal(changes.length, 1, 'one change, not one per poll');
	assert.deepEqual(
		changes[0].added.map((t) => t.content),
		['1302079605'],
	);
	assert.equal(changes[0].removed.length, 0);
	assert.equal(changes[0].tags.length, 2, 'the full pad is reported too');
});

test('a tag taken away is reported as removed, by the barcode it had', async () => {
	const reader = fakeReader(
		[
			['e004010031269117', 'e00401003126a0c8'],
			['e004010031269117'],
		],
		{ e004010031269117: '1302099999', e00401003126a0c8: '1302079605' },
	);
	const changes = [];
	const w = watch({
		reader,
		initial: [
			{ sid: 'e004010031269117', content: '1302099999' },
			{ sid: 'e00401003126a0c8', content: '1302079605' },
		],
		intervalMs: 4,
		onChange: (c) => changes.push(c),
	});
	w.start();
	await until(() => changes.length >= 1, 'the removal');
	w.stop('done');

	assert.deepEqual(
		changes[0].removed.map((t) => t.content),
		['1302079605'],
	);
	assert.equal(changes[0].added.length, 0);
});

test('one read failure is tolerated, a run of them stops the loop', async () => {
	const boom = new Error('no frame from reader (timeout)');
	const reader = fakeReader([boom, boom, boom]);
	const errors = [];
	let stopped = null;
	const w = watch({ reader, intervalMs: 4, maxErrors: 2, onError: (m, n) => errors.push([m, n]), onStop: (why) => (stopped = why) });
	w.start();
	await until(() => stopped, 'the loop to give up');
	const polls = reader.inventories;
	await nap(40);
	w.stop('done');

	assert.equal(errors.length, 2, 'stopped on the second failure, not later');
	assert.match(errors[0][0], /timeout/);
	assert.match(stopped, /2 read failures/);
	assert.equal(reader.inventories, polls, 'no polling after giving up');
	assert.equal(w.stats.on, false);
});

test('a failure between good polls does not count towards giving up', async () => {
	const boom = new Error('flaky tunnel');
	const reader = fakeReader([boom, ['e004010031269117'], boom, ['e004010031269117'], boom, ['e004010031269117']]);
	const w = watch({ reader, intervalMs: 4, maxErrors: 2, onError: () => {} });
	w.start();
	await nap(80);
	const polls = reader.inventories;
	w.stop('done');

	assert.ok(polls >= 5, `still polling after isolated failures (${polls} polls)`);
	assert.equal(w.stats.errors >= 3, true, 'the failures were still counted');
	assert.equal(w.stats.on, false, 'and stopped by the caller, not by itself');
});

test('stop() is final and says why', async () => {
	const reader = fakeReader([['e004010031269117']]);
	const w = watch({ reader, intervalMs: 4, onStop: () => {} });
	w.start();
	await until(() => w.stats.polls >= 1, 'a first poll');
	w.stop('tab hidden');
	const polls = reader.inventories;
	await nap(40);

	assert.equal(reader.inventories, polls, 'the port is free again');
	assert.equal(w.stats.stopReason, 'tab hidden');
	assert.ok(w.stats.startedAt <= w.stats.stoppedAt);
});
