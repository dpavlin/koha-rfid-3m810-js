/*
 * Build the single file the Koha plugin inlines.
 *
 * Koha 18.11-ffzg does not serve files out of the plugin directory
 * (curl /plugin/Koha/Plugin/Rot13/RFID/… -> 404), so there is no way to
 * <script src> a module: everything ships inline, hence one bundled file.
 *
 *   node build/bundle.mjs          minified
 *   DEBUG=1 node build/bundle.mjs  readable, for reading it in devtools
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const out = 'plugin/Koha/Plugin/Rot13/RFID/koha-rfid.js';

const minify = process.env.DEBUG !== '1';

await build({
	entryPoints: ['src/core/boot.js'],
	bundle: true,
	format: 'iife',
	platform: 'browser',
	target: ['es2020'],
	outfile: out,
	minify,
	charset: 'utf8',
	legalComments: 'none',
	banner: { js: `/* koha-rfid-3m810-js v${pkg.version} ${minify ? '' : '(debug) '}built ${new Date().toISOString()} */` },
});

const js = readFileSync(out, 'utf8');

// The bundle is injected inside <script> tags by the Perl hook. A literal
// "</script" anywhere in it would end the tag and serve the rest as markup.
const hole = js.indexOf('</script');
if (hole >= 0) {
	writeFileSync(out + '.rejected', js);
	console.error(`FAIL: bundle contains "</script" at byte ${hole} (kept as ${out}.rejected)`);
	process.exit(1);
}
if (/\bimport\s/.test(js) || /\bexport\s/.test(js)) {
	console.error('FAIL: bundle still has ESM import/export — it must be self-contained');
	process.exit(1);
}

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log(`${out}: ${kb(js.length)} js, ${kb(gzipSync(js).length)} gzip, ${minify ? 'minified' : 'debug'}`);
