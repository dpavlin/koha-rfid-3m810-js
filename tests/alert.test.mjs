/*
 * A takeover that cannot be dismissed by waiting.
 *
 * The DOM here is as small as the toast tests' — the overlay uses createElement,
 * appendChild, style, textContent and a click handler, and that list being short is the
 * point. What is asserted is the part that matters on a shift: it covers, it says the
 * barcode, it beeps, it keeps the title bar moving, and the only ways out are the button
 * and Esc. Not a timer, and not an error somewhere else taking the screen away either.
 *
 * `setInterval`, `clearInterval` and `AudioContext` are on the window, not globals: the
 * overlay reaches for the window it was given, so this file can stop the beeping instead
 * of scheduling it for real. (A suite that hangs after printing its results is this
 * contract being broken, which is why it is written down here.)
 *
 *   node --test tests/alert.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { takeover } from '../src/core/alert.js';

function fakeWindow({ audio = 'ok' } = {}) {
	const el = (name) => {
		const node = {
			name,
			children: [],
			style: { cssText: '', display: 'none' },
			attrs: {},
			handlers: {},
			text: '',
			focusCalls: 0,
			setAttribute(k, v) {
				this.attrs[k] = v;
			},
			addEventListener(type, fn) {
				(this.handlers[type] ||= []).push(fn);
			},
			appendChild(n) {
				this.children.push(n);
				return n;
			},
			focus() {
				this.focusCalls++;
			},
			querySelector(sel) {
				if (sel !== 'button') return null;
				const walk = (n) => {
					for (const c of n.children) {
						if (c.name === 'button') return c;
						const found = walk(c);
						if (found) return found;
					}
					return null;
				};
				return walk(this);
			},
			dispatch(type, ev = {}) {
				for (const fn of this.handlers[type] || []) fn({ preventDefault() {}, ...ev });
			},
		};
		Object.defineProperty(node, 'textContent', {
			get() {
				return this.children.length ? '' : this.text;
			},
			set(v) {
				this.text = v;
				if (v === '') this.children.length = 0;
			},
		});
		return node;
	};

	const created = [];
	const intervals = [];
	const body = el('body');
	const docHandlers = {};
	const doc = {
		title: 'Check out › Koha',
		body,
		activeElement: null,
		createElement: (name) => (created.push(el(name)), created.at(-1)),
		getElementById: (id) => [body, ...created].find((n) => n.id === id) || null,
		addEventListener: (type, fn) => (docHandlers[type] ||= []).push(fn),
		dispatch(type, ev = {}) {
			for (const fn of docHandlers[type] || []) fn({ preventDefault() {}, ...ev });
		},
	};

	class FakeAudioContext {
		constructor() {
			if (audio === 'refused') throw new Error('The context could not be created');
			this.state = audio === 'suspended' ? 'suspended' : 'running';
			this.currentTime = 0;
			this.tones = [];
			this.resumeCalls = 0;
			this.destination = {};
		}
		createOscillator() {
			const self = this;
			return {
				frequency: { value: 0 },
				connect() {},
				start(at) {
					self.tones.push({ freq: this.frequency.value, at });
				},
				stop() {},
			};
		}
		createGain() {
			return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
		}
		resume() {
			this.resumeCalls++;
			this.state = 'running';
		}
	}

	const win = {
		document: doc,
		AudioContext: FakeAudioContext,
		setInterval: (fn, ms) => (intervals.push({ fn, ms, on: true }), intervals.length),
		clearInterval: (h) => (intervals[h - 1].on = false),
	};
	const keydown = (key) => doc.dispatch('keydown', { key });
	return { win, doc, body, created, intervals, keydown, audioClass: FakeAudioContext };
}

const entry = (over = {}) => ({ barcode: '1302079605', from: 'D7', to: 0xda, ageMs: 45000, ...over });

/** Every node of a name, wherever it is — the overlay nests one row per book. */
const collect = (node, name, found = []) => {
	if (node.name === name) found.push(node);
	for (const c of node.children || []) collect(c, name, found);
	return found;
};

const allText = (node) => [node.text, ...(node.children || []).flatMap(allText)].filter(Boolean).join('\n');

test('it covers the page, says the barcode, and starts beeping', () => {
	const { win, body, intervals } = fakeWindow();
	const alarm = takeover(win, { beep: true });

	alarm.show([entry()]);

	const root = body.children[0];
	assert.equal(root.style.display, 'flex', 'the whole viewport');
	assert.equal(root.attrs.role, 'alertdialog');
	assert.equal(root.attrs['aria-live'], 'assertive', 'a screen reader is told straight away');
	assert.match(allText(root), /1302079605/);
	assert.match(allText(root), /left at D7/);
	assert.match(allText(root), /should say DA/);
	assert.match(allText(root), /45s/, 'how long it has been waiting');
	assert.equal(intervals.length, 2, 'one for the beep, one for the title bar');
	assert.equal(intervals[0].ms, 1500, 'the beep repeats on the second-ish');
	assert.equal(alarm.isShowing(), true);
	const buttons = collect(root, 'button');
	assert.equal(buttons.length, 1, 'one way out per book');
	assert.match(buttons[0].textContent, /record that the tag stays as it is/);
});

test('the title bar moves too, and comes back exactly as it was', () => {
	const { win, doc } = fakeWindow();
	const alarm = takeover(win, { beep: false });
	const before = doc.title;

	alarm.show([entry()]);
	assert.match(doc.title, /put the book back on the reader/);

	alarm.show([]);
	assert.equal(doc.title, before, 'not a title left behind on a clean desk');
});

test('Esc is the same as the button, because a screen nobody can leave is a worse screen', () => {
	const acked = [];
	const { win } = fakeWindow();
	const alarm = takeover(win, { beep: false, onAcknowledge: (bc) => acked.push(bc) });

	alarm.show([entry()]);
	win.document.dispatch('keydown', { key: 'Escape' });

	assert.deepEqual(acked, ['1302079605'], 'and it goes to the machine, which decides what that means');
});

test('the button belongs to its own book when there are two', () => {
	const acked = [];
	const { win, body } = fakeWindow();
	const alarm = takeover(win, { beep: false, onAcknowledge: (bc) => acked.push(bc) });

	alarm.show([entry(), entry({ barcode: '1302099999' })]);

	const buttons = collect(body.children[0], 'button');
	assert.equal(buttons.length, 2);
	buttons[1].dispatch('click');

	assert.deepEqual(acked, ['1302099999'], 'the second book, not the first');
});

test('an empty list is the way it comes down', () => {
	const { win, body, intervals } = fakeWindow();
	const alarm = takeover(win, { beep: true });

	alarm.show([entry()]);
	alarm.show([]);

	assert.equal(body.children[0].style.display, 'none');
	assert.equal(intervals[0].on, false, 'the beeping stopped');
	assert.equal(alarm.isShowing(), false);
});

test('a machine that refuses audio still gets the screen', () => {
	const { win, body } = fakeWindow({ audio: 'refused' });
	const alarm = takeover(win, { beep: true });

	assert.doesNotThrow(() => alarm.show([entry()]));
	assert.equal(body.children[0].style.display, 'flex');
	assert.equal(alarm.state().sound, 'not tried', 'and it does not pretend sound is playing');
});

test('sound waiting on a gesture says so, and the next click on the screen starts it', () => {
	const { win, body } = fakeWindow({ audio: 'suspended' });
	const alarm = takeover(win, { beep: true });

	alarm.show([entry()]);
	assert.match(allText(body.children[0]), /sound needs a click/);
	assert.equal(alarm.state().sound, 'needs click');

	body.children[0].dispatch('click');
	assert.equal(alarm.state().sound, 'on', 'clicked, resumed, beeping');
});

test('a page it cannot cover is a page it does not break', () => {
	const alarm = takeover({}, { beep: true });
	assert.doesNotThrow(() => alarm.show([entry()]));
	assert.doesNotThrow(() => alarm.show([]));
});

test('an acknowledge that throws does not trap anybody', () => {
	const { win, body } = fakeWindow();
	const alarm = takeover(win, {
		beep: false,
		onAcknowledge: () => {
			throw new Error('storage is full');
		},
	});
	alarm.show([entry()]);
	const button = collect(body.children[0], 'button')[0];
	assert.doesNotThrow(() => button.dispatch('click'));
});
