/*
 * Live check of M1's page logic: on each enrolled page, where does a tag on the pad go?
 *
 * Read-only — it never submits anything. Per page it reports what `rfidM0.target()`
 * believes the scan box is and what every `input[name=barcode]` on the page actually
 * holds, so a wrong-box fill shows up as a value in a field we did not choose. The
 * header boxes on these pages are named `barcode` too, which is the whole hazard.
 *
 *   run via browser_execute; see tools/live/README.md
 */
const PROBE = `(new Promise((res) => {
  const m0 = window.rfidM0 || {};
  const t0 = Date.now();
  const tick = () => {
    if (m0.gate === 'ready' || m0.gate === 'error' || Date.now() - t0 > 12000) {
      // give the fill a moment: gate flips to ready a beat before the tag is written in
      const settle = (fn) => setTimeout(fn, 700);
      const boxes = [...document.querySelectorAll('input[name=barcode]')].map((f) => {
        const form = f.closest('form');
        return {
          id: f.id,
          value: f.value,
          disabled: f.disabled,
          hidden: !f.offsetParent,
          posts: form ? (form.getAttribute('action') || '').split('/').pop() : null,
        };
      });
      const report = () => res(JSON.stringify({
        path: location.pathname.split('/koha/').pop() + location.search.slice(0, 20),
        gate: m0.gate || 'never',
        target: m0.target ? m0.target() : 'no target()',
        hasMainform: !!document.getElementById('mainform'),
        filled: m0.filled || null,
        tags: (m0.tags || []).map((x) => x.content || x.sid),
        boxes,
        log: (m0.log || []).filter((s) => /filled|left alone|disabled/.test(s)).slice(-2),
        confirmDialog: /Please confirm/i.test(document.body.innerText),
      }));
      settle(report);
      return;
    }
    setTimeout(tick, 300);
    // (the loop is a poll for gate=ready; report() adds the settle delay)
  };
  tick();
}))`;

export async function run(session, k) {
	const out = {};
	// circulation.pl takes borrowernumber, not cardnumber: with the wrong parameter it
	// renders an empty shell (no #mainform, no #barcode) and the plugin correctly finds
	// no target — which looks identical to a plugin bug from the outside.
	const PATRON = { borrowernumber: 606 };
	for (const [name, page, params] of [
		['circulation', 'circ/circulation.pl', PATRON],
		['renew', 'circ/renew.pl', PATRON],
	]) {
		// login() attaches to whatever is already open, so attach first; and it navigates to
		// mainpage.pl, so the page under test is opened after it (probing before that is how
		// this script once reported gate 'idle' on mainpage).
		if (!out.login) {
			await k.open(session, k.url('mainpage.pl', {}));
			out.login = await k.login(session);
		}
		k.trace('page-logic: open', name, out.login);
		await k.open(session, k.url(page, params));
		out[name] = JSON.parse(await k.evaluate(session, PROBE));
		k.step(name, out[name].gate + ' / ' + JSON.stringify(out[name].target));
	}
	return out;
}
