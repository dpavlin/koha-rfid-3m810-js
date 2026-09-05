/*
 * The one pure function in tools/live/write-log.mjs.
 *
 * The tool exists because there is no server-side audit row (Koha 19.11, PLAN §6), so its
 * output is what a test run leaves behind. Escaping matters for exactly the field that makes
 * it interesting: a refusal reason is full of commas and quotes.
 *
 *   node --test tests/writelog.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { csv } from '../tools/live/write-log.mjs';

test('one row per write, with the columns a test run needs', () => {
	const out = csv([
		{
			at: 1760000000000,
			sid: 'e00401003123b218',
			from: '',
			to: '1305271134',
			afi: 'DA',
			verified: true,
			error: null,
		},
	]);
	const [head, row] = out.split('\n');
	assert.equal(head, 'iso,epoch_ms,sid,barcode_before,barcode_after,afi,verified,error');
	assert.match(row, /^2025-10-09T08:53:20.000Z,1760000000000,e00401003123b218,,1305271134,DA,yes,/);
});

test('a refusal reason survives being CSV, and an unverified write is loud', () => {
	const out = csv([
		{
			sid: 'x',
			from: '1300000001',
			to: '1300000002',
			afi: 'DA',
			verified: false,
			error: 'tag said "gone", then left the pad',
		},
	]);
	assert.match(out.split('\n')[1], /NO,"tag said ""gone"", then left the pad"$/);
});
