/*
 * What lives in the bottom-right corner, and what the pill would overlap.
 *
 * The plugin's status element is anchored there; this reports its geometry and what
 * document.elementFromPoint finds at three spots along the bottom edge, so a collision
 * with something Koha puts there (or a pill that has grown over the page) is measured
 * rather than imagined.
 *
 *   run via browser_execute; see tools/live/README.md
 */
export function probe() {
	const box = (el) => {
		const r = el.getBoundingClientRect();
		return {
			right: Math.round(innerWidth - r.right),
			bottom: Math.round(innerHeight - r.bottom),
			w: Math.round(r.width),
			h: Math.round(r.height),
		};
	};
	const el = document.getElementById('rfid-boot-hint');
	const at = (x, y) => {
		const n = document.elementFromPoint(x, y);
		if (!n) return null;
		const who = n.id || n.tagName.toLowerCase();
		return n.closest('#rfid-boot-hint') ? who + ' <pill>' : who;
	};
	return JSON.stringify(
		{
			pill: el
				? {
						tag: el.tagName,
						id: el.id,
						text: el.textContent,
						css: getComputedStyle(el).position,
						rect: box(el),
						parent: el.parentElement.id || el.parentElement.tagName,
					}
				: null,
			corner: [
				at(innerWidth - 8, innerHeight - 8),
				at(innerWidth - 80, innerHeight - 10),
				at(innerWidth - 240, innerHeight - 10),
			],
			viewport: [innerWidth, innerHeight],
		},
		null,
		1,
	);
}

export async function run(session, k) {
	await k.open(session, k.url('mainpage.pl', {}));
	const login = await k.login(session);
	await k.open(session, k.url('circ/returns.pl', {}));
	const returns = JSON.parse(await k.evaluate(session, `(${probe.toString()})()`));
	await k.open(session, k.url('circ/circulation.pl', { borrowernumber: 606 }));
	const circulation = JSON.parse(await k.evaluate(session, `(${probe.toString()})()`));
	return { login, returns, circulation };
}
