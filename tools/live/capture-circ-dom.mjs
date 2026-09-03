// Capture the DOM that M1's checkout/renew page logic has to work against.
//
// CHANGES DATA: issues ITEM to BORROWER (the sacrificial tag's item, so it is the
// item a librarian would be testing with) and leaves it OUT — returns.pl needs an
// item on loan, and this is the state the next verification starts from.
//
// Writes fixtures into tests/fixtures/ so the shapes below stop being memory:
//   circulation-pl-patron.html     patron page, checkout box as the page renders it
//   circulation-pl-checkedout.html the page after an issue: what "success" looks like
//   renew-pl-patron.html           circ/renew.pl for the same patron
//
// The fixtures are live captures, not synthetic: they contain a real patron record
// (mine, on a dev box). Scrub them before this repo or a .kpz goes anywhere public.
// renew-pl-patron.html was expected to carry one loan and does not — the issue it was
// captured after stopped at "Please confirm checkout" and was never confirmed, which is
// itself the shape of that state and why the file is named for the patron, not the loan.
//
// Run: see tools/live/README.md

import { writeFileSync } from 'node:fs';

const ITEM = '1302079605';
const BORROWER = 606;
const FIXTURES = '/home/dpavlin/koha-rfid-3m810-js/tests/fixtures/';

export const SHAPE = `JSON.stringify({
  page: location.pathname.split('/').pop() + location.search.slice(0, 24),
  box: (function () { const i = document.getElementById('barcode'); return i ? { disabled: i.disabled, inForm: (i.getAttribute('form') || (i.form ? i.form.action.split('/').pop() : null)), value: i.value } : null; })(),
  dialogs: [...document.querySelectorAll('div.dialog')].map(function (d) { return { id: d.id, cls: d.className, text: (d.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) }; }),
  forms: [...document.forms].map(function (f) { return { action: (f.getAttribute('action') || '').split('/').pop().split('?')[0], id: f.id, text: [...f.elements].filter(function (e) { return (e.type || '') === 'text'; }).map(function (e) { return e.name || e.id; }) }; }).filter(function (f) { return f.text.length; }),
  tables: [...document.querySelectorAll('table[id]')].map(function (t) { return t.id; }),
  rfid: (window.rfidM0 || {}).gate || null
})`;

export async function run(session, k) {
	const targets = await session.getTargets();
	const tab = targets.find((t) => t.type === 'page' && t.url.includes('koha-dev'));
	await session.use(tab.targetId);

	const how = await k.login(session);
	k.trace('login:', how);
	const out = { login: how };

	const shape = async () => JSON.parse(await k.evaluate(session, SHAPE));
	const save = async (name) => {
		const html = await k.evaluate(session, 'document.documentElement.outerHTML');
		writeFileSync(FIXTURES + name, html);
		return html.length;
	};

	// 1. patron page, before anything is issued
	await session._call('Page.navigate', { url: k.url('circ/circulation.pl', { borrowernumber: BORROWER }) });
	await k.waitForLoad(session);
	await new Promise((r) => setTimeout(r, 1200));
	out.before = await shape();
	out.saved = { 'circulation-pl-patron.html': await save('circulation-pl-patron.html') };

	// 2. issue through the page's own form — the path a librarian's scanner takes
	await k.evaluate(
		session,
		`(function () { const i = document.getElementById('barcode'); i.value = ${JSON.stringify(ITEM)}; HTMLFormElement.prototype.submit.call(i.form); return 1; })()`,
	);
	await new Promise((r) => setTimeout(r, 3500));
	out.afterIssue = await shape();
	out.saved['circulation-pl-checkedout.html'] = await save('circulation-pl-checkedout.html');

	// 3. renew page for the same patron (with a loan on it, if step 2 actually issued one)
	await session._call('Page.navigate', { url: k.url('circ/renew.pl', { borrowernumber: BORROWER }) });
	await k.waitForLoad(session);
	await new Promise((r) => setTimeout(r, 1200));
	out.renew = await shape();
	out.saved['renew-pl-patron.html'] = await save('renew-pl-patron.html');

	k.trace('captured:', Object.keys(out.saved));
	return out;
}
