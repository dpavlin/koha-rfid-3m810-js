/*
 * What "focus the right field" would mean on this install, measured.
 *
 * Read-only. For each circulation page: every field a scan could go into (id, name,
 * whether it is a hidden/decoy field, whether it is in the header search, which form it
 * posts to), which field the page focuses by itself, and whether the IDs Koha's own
 * Alt-shortcuts aim at (staff-global.js: Alt+r → #ret_barcode, Alt+w → #ren_barcode,
 * Alt+u → #findborrower) exist here at all.
 *
 * This is the input to the "focus is the consent gesture" design: the shortcut has to land
 * in a field the plugin can also see, and the field it lands in must be the one that
 * actually performs the transaction.
 *
 *   run via browser_execute; see tools/live/README.md
 */
const PROBE = `(new Promise((res) => setTimeout(() => {
  const show = (el) => {
    const f = el.closest('form');
    return {
      id: el.id || null,
      name: el.name || null,
      type: el.type,
      disabled: el.disabled,
      inHeader: !!el.closest('#header_search'),
      formId: f ? f.id || null : null,
      posts: f ? (f.getAttribute('action') || '(none)').split('/').pop().split('?')[0] : null,
    };
  };
  const fields = [...document.querySelectorAll('input[name=barcode], input#findborrower, input#ret_barcode, input#ren_barcode, #header_search input[type=text]')]
    .map(show);
  const shortcuts = ['ret_barcode', 'ren_barcode', 'findborrower', 'barcode', 'search-form']
    .reduce((acc, id) => (acc[id] = !!document.getElementById(id), acc), {});
  res(JSON.stringify({
    path: location.pathname.split('/koha/').pop() + location.search.slice(0, 24),
    activeElement: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
    shortcuts,
    fields,
  }, null, 1));
}, 500)))`;

export async function run(session, k) {
	await k.open(session, k.url('mainpage.pl', {}));
	const login = await k.login(session);
	const out = { login, pages: [] };
	for (const [page, params] of [
		['circ/returns.pl', {}],
		['circ/circulation.pl', { borrowernumber: 606 }],
		['circ/renew.pl', { borrowernumber: 606 }],
	]) {
		await k.open(session, k.url(page, params));
		out.pages.push(JSON.parse(await k.evaluate(session, PROBE)));
	}
	return out;
}
