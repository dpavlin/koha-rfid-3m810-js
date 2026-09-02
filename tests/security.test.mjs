/*
 * The rule these tests exist to keep: the tag is told after Koha confirms, never before.
 *
 * Everything browser-shaped is injected, so the interesting failures are assertable
 * without a reader — including the one that a live test can only reach by carrying a book
 * away mid-transaction: the alert that opens when a confirmed check-in cannot finish.
 *
 *   node --test tests/security.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { owed, AFI } from '../src/core/security.js';

const clock = (start = 1000) => {
	let t = start;
	return { now: () => t, advance: (ms) => (t += ms) };
};

const store = (initial = {}) => {
	const data = { ...initial };
	return {
		data,
		getItem: (k) => (k in data ? data[k] : null),
		setItem: (k, v) => (data[k] = String(v)),
		removeItem: (k) => delete data[k],
	};
};

/** A returns.pl answer: the tag, as the pad reports it. */
const tag = ({ sid = 'E004010031269117', content = '1302079605', security = 'D7' } = {}) => ({ sid, content, security });

function harness({ graceMs = 8000, write, store: s = store(), beep } = {}) {
	const c = clock();
	const log = [];
	const alerts = [];
	const writes = [];
	const schedules = [];
	const machine = owed({
		store: s,
		now: c.now,
		graceMs,
		write:
			write ||
			(async (w) => {
				writes.push(w);
			}),
		alert: { show: (list) => alerts.push(list.map((e) => e.barcode)) },
		log: (...a) => log.push(a.join(': ')),
		schedule: (fn, ms) => schedules.push({ fn, ms }),
	});
	return { machine, c, log, alerts, writes, schedules, clock: c };
}

const oweAndConfirm = (h, over = {}) => {
	h.machine.owe({ barcode: '1302079605', sid: 'E004010031269117', from: 'D7', to: AFI.secure, ...over });
	h.machine.verdict({ barcode: '1302079605', ok: true });
};

test('nothing is written to a tag before Koha has answered', async () => {
	const h = harness();
	h.machine.owe({ barcode: '1302079605', sid: 'E004010031269117', from: 'D7', to: AFI.secure });

	await h.machine.pad({ tags: [tag()] });

	assert.equal(h.writes.length, 0, 'the transaction is still in flight');
	assert.equal(h.alerts.length, 0, 'and an in-flight transaction is not an emergency');
	assert.equal(h.machine.list().length, 1, 'the write is owed, that is all');
});

test('a confirmed check-in writes DA to the tag that is still on the pad', async () => {
	const h = harness();
	oweAndConfirm(h);

	const pending = await h.machine.pad({ tags: [tag()] });

	assert.deepEqual(h.writes, [{ barcode: '1302079605', sid: 'E004010031269117', from: 'D7', to: AFI.secure }]);
	assert.deepEqual(pending, [], 'nothing is owed any more');
	assert.equal(h.alerts.length, 0, 'nothing to shout about');
	assert.ok(h.log.some((l) => l.includes('tag updated')), 'and it is in the log: ' + h.log.join(' | '));
});

test('Koha did not confirm, so nothing was owed and the tag keeps its bits', async () => {
	const h = harness();
	h.machine.owe({ barcode: '1302079605', sid: 'E004010031269117', from: 'D7', to: AFI.secure });
	h.machine.verdict({ barcode: '1302079605', ok: false });

	await h.machine.pad({ tags: [tag()] });

	assert.equal(h.writes.length, 0);
	assert.equal(h.machine.list().length, 0);
	assert.ok(h.log.some((l) => l.includes('did not confirm')), h.log.join(' | '));
});

test('the write survives the page reload that the check-in caused', async () => {
	const s = store();
	const first = harness({ store: s });
	first.machine.owe({ barcode: '1302079605', sid: 'E004010031269117', from: 'D7', to: AFI.secure });
	first.machine.verdict({ barcode: '1302079605', ok: true });

	// The page navigates: a new machine, the same storage, the tag still under the head.
	const second = harness({ store: s });
	await second.machine.pad({ tags: [tag()] });

	assert.equal(second.writes.length, 1);
	assert.equal(second.writes[0].to, AFI.secure);
});

test('a book that left the pad is shouted about after the grace, not before', async () => {
	const h = harness({ graceMs: 8000 });
	oweAndConfirm(h);

	await h.machine.pad({ tags: [] }); // carried away while the page was reloading
	assert.equal(h.alerts.length, 0, 'lifted off the pad two seconds ago is not an alarm');
	assert.equal(h.schedules.length, 1, 'a timer looks again, because a still pad never will');
	assert.ok(h.schedules[0].ms > 8000 && h.schedules[0].ms <= 8100, `grace + a moment, got ${h.schedules[0].ms}ms`);

	h.c.advance(8001);
	await h.machine.pad({ tags: [] });
	assert.deepEqual(h.alerts[0], ['1302079605']);
});

test('putting the book back on the reader is the way out', async () => {
	const h = harness();
	oweAndConfirm(h);
	h.c.advance(9000);
	await h.machine.pad({ tags: [] });
	assert.deepEqual(h.alerts.at(-1), ['1302079605'], 'shouting');

	await h.machine.pad({ tags: [tag()] });

	assert.equal(h.writes.length, 1, 'written at once');
	assert.deepEqual(h.alerts.at(-1), [], 'and the screen is off again');
	assert.equal(h.machine.list().length, 0);
});

test('a write that does not stick stays on the screen', async () => {
	const h = harness({
		write: async () => {
			throw new Error('AFI write did not stick: wanted da, read d7');
		},
	});
	oweAndConfirm(h);

	await h.machine.pad({ tags: [tag()] });

	assert.deepEqual(h.alerts.at(-1), ['1302079605'], 'the tag is in front of us and still wrong');
	assert.equal(h.machine.list().length, 1, 'still owed');
	assert.ok(h.log.some((l) => l.includes('tag write failed')), h.log.join(' | '));
});

test('acknowledging is a decision, so it is recorded', async () => {
	const h = harness();
	oweAndConfirm(h);
	h.c.advance(60000);
	await h.machine.pad({ tags: [] });

	assert.equal(h.machine.acknowledge('1302079605'), true);

	assert.deepEqual(h.machine.list(), []);
	assert.deepEqual(h.alerts.at(-1), [], 'the screen comes down');
	assert.deepEqual(h.machine.skipped(), [
		{ barcode: '1302079605', sid: 'E004010031269117', leftAt: 'D7', wanted: 'DA', waitedMs: 60000, at: 61000 },
	]);
	assert.ok(h.log.some((l) => l.includes('security bit left alone') && l.includes('D7')), h.log.join(' | '));
});

test('a tag that already says DA needed nothing', async () => {
	const h = harness();
	oweAndConfirm(h);

	await h.machine.pad({ tags: [tag({ security: 'DA' })] });

	assert.equal(h.writes.length, 0, 'no command sent');
	assert.equal(h.machine.list().length, 0, 'and the write is not owed for ever');
	assert.ok(h.log.some((l) => l.includes('already said DA')), h.log.join(' | '));
});

test('an unconfirmed write is never loud, however long it waits', async () => {
	const h = harness();
	h.machine.owe({ barcode: '1302079605', sid: 'E004010031269117', from: 'D7', to: AFI.secure });

	h.c.advance(600000); // ten minutes, and the page never came back with an answer
	await h.machine.pad({ tags: [] });

	assert.equal(h.alerts.at(-1), undefined, 'Koha has not answered: no alarm');
});

test('two books, one returned: the other keeps waiting quietly', async () => {
	const h = harness();
	h.machine.owe({ barcode: '1302079605', sid: 'E004010031269117', from: 'D7', to: AFI.secure });
	h.machine.owe({ barcode: '1302099999', sid: 'E00401001F77FB98', from: 'D7', to: AFI.secure });
	h.machine.verdict({ barcode: '1302079605', ok: true });

	h.c.advance(9000);
	await h.machine.pad({ tags: [tag({ security: 'D7' })] });

	assert.equal(h.writes.length, 1, 'only the confirmed one was written');
	assert.equal(h.writes[0].barcode, '1302079605');
	assert.equal(h.alerts.at(-1), undefined, 'and the other is still in flight, not a failure');

	h.machine.verdict({ barcode: '1302099999', ok: true });
	await h.machine.pad({ tags: [] });
	assert.equal(h.machine.list().length, 1, 'it stays owed until it is written or let go');
});
