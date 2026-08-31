/*
 * Toasts, against a DOM small enough to read.
 *
 * What matters: it appears when told and disappears by itself (a notification that
 * has to be dismissed is a notification that gets dismissed unread), it does not pile
 * up, and a page it cannot paint on is not a page it breaks.
 *
 *   node --test tests/toast.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toasts } from '../src/core/toast.js';

function fakeWindow({ paintable = true } = {}) {
	const el = (name) => ({
		name,
		children: [],
		style: { cssText: '' },
		attrs: {},
		setAttribute(k, v) {
			this.attrs[k] = v;
		},
		get firstChild() {
			return this.children[0] || null;
		},
		get lastChild() {
			return this.children[this.children.length - 1] || null;
		},
		insertBefore(node) {
			this.children.unshift(node);
			node.parentNode = this;
		},
		appendChild(node) {
			this.children.push(node);
			node.parentNode = this;
			return node;
		},
		removeChild(node) {
			this.children = this.children.filter((c) => c !== node);
			node.parentNode = null;
		},
	});

	const body = el('body');
	const doc = {
		body,
		createElement: () => {
			if (!paintable) throw new Error('this page is not ours to paint on');
			return el('div');
		},
		getElementById: (id) => body.children.find((c) => c.id === id) || null,
	};
	return { win: { document: doc }, body };
}

test('the box is created once, and says what it is for', () => {
	const { win, body } = fakeWindow();
	const timers = [];
	const show = toasts(win, { setTimeout: (fn) => timers.push(fn) });

	show('checked in 1302079605');
	show('checked in 1302099999');

	const box = body.children[0];
	assert.equal(body.children.length, 1, 'one container for the whole page');
	assert.equal(box.attrs.role, 'status');
	assert.equal(box.attrs['aria-live'], 'polite');
	assert.equal(box.children.length, 2);
	assert.equal(box.children[0].textContent, 'checked in 1302099999', 'newest first');
	assert.equal(timers.length, 2, 'each line scheduled to vanish');
});

test('lines disappear on their own, and never pile up', () => {
	const { win, body } = fakeWindow();
	const timers = [];
	const show = toasts(win, { setTimeout: (fn) => timers.push(fn), holdMs: 1000, max: 2 });

	for (const bc of ['1302079605', '1302099999', '1302000001']) show(bc);
	const box = body.children[0];
	assert.equal(box.children.length, 2, 'max 2 on screen');

	timers.forEach((fn) => fn());
	assert.equal(box.children.length, 0, 'and gone');
});

test('a page it cannot paint on is not a page it breaks', () => {
	const { win } = fakeWindow({ paintable: false });
	const show = toasts(win, { setTimeout: () => {} });
	assert.doesNotThrow(() => show('checked in 1302079605'));
});

test('no document, no toast, no exception', () => {
	const show = toasts({}, { setTimeout: () => {} });
	assert.doesNotThrow(() => show('anything'));
});
