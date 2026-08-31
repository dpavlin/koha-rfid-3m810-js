/*
 * Enough of returns.pl to run src/core/checkin.js in plain node.
 *
 * The rows come from tests/fixtures/checkedin-*.html, captured from the live server,
 * so the shape the code reads is the shape Koha writes — not the shape I remembered.
 * The parser is deliberately stupid (cells by class, tags stripped); if Koha's markup
 * ever stops fitting it, these tests fail loudly instead of the plugin guessing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const textOf = (html) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function rowsOf(fixture) {
	const html = readFileSync(join(FIX, fixture), 'utf8');
	return [...html.matchAll(/<tr[^>]*role="row"[^>]*>([\s\S]*?)<\/tr>/g)]
		.map(([, body]) => [...body.matchAll(/<td[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/td>/g)])
		.filter((cells) => cells.length)
		.map((cells) => {
			// Cells speak `textContent`, like the real thing: that is what the code under
			// test reads, and a helper that invents a friendlier property hides the bug.
			const parsed = cells.map(([, cls, html]) => ({ classes: cls.split(/\s+/), textContent: textOf(html) }));
			return {
				querySelector: (sel) =>
					sel.startsWith('td.') ? parsed.find((c) => c.classes.includes(sel.slice(3))) || null : null,
				textContent: parsed.map((c) => c.textContent).join(' '),
			};
		});
}

/** A page like returns.pl answered with `fixtures` rendered into its checked-in table. */
export function returnsPage(...fixtures) {
	const rows = fixtures.flatMap(rowsOf);
	return {
		querySelector: (sel) => (sel === 'table#checkedintable' ? {} : null),
		querySelectorAll: (sel) => (sel === 'table#checkedintable tbody tr' ? rows : []),
	};
}

/** A page whose template has none of the ci-* hooks: rows of plain cells. */
export function plainRowsPage(...rows) {
	return {
		querySelector: (sel) => (sel === 'table#checkedintable' ? {} : null),
		querySelectorAll: (sel) =>
			sel === 'table#checkedintable tbody tr'
				? rows.map((cells) => ({ textContent: cells.join(' ').replace(/\s+/g, ' ').trim(), querySelector: () => null }))
				: [],
	};
}

export const noTablePage = { querySelector: () => null, querySelectorAll: () => [] };
