// Between Mirror — finish assembling the browser demo after Vite has built it.
//
// Two jobs, both small and both the kind of thing that is silently wrong if left to a shell one-liner
// that behaves differently on Windows:
//
//   1. Vite names its output after the input file, so the bundle lands at site/demo/demo.html. The
//      site links to /demo/, which a static host resolves to /demo/index.html. Without this rename
//      the link 404s — on the deployed site only, which is the worst place to find out.
//   2. Verify the captured data the page depends on is actually there and reachable at the relative
//      path the bundle asks for. A demo that builds cleanly and then renders "could not load its
//      data" is a broken demo that passed its build.
import { existsSync, renameSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(repoRoot, 'site', 'demo');
const data = join(repoRoot, 'site', 'demo-data');

const fail = (msg) => { console.error(`\nDemo assembly FAILED: ${msg}\n`); process.exit(1); };

if (!existsSync(out)) fail(`no build output at site/demo. Run: npm run demo:build`);

const built = join(out, 'demo.html');
const index = join(out, 'index.html');
if (existsSync(built)) renameSync(built, index);
if (!existsSync(index)) fail('site/demo/index.html is missing — the demo page would 404.');

if (!existsSync(data)) fail('no captured data at site/demo-data. Run: npm run demo:export');
const manifestPath = join(data, 'manifest.json');
if (!existsSync(manifestPath)) fail('site/demo-data/manifest.json is missing.');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const present = new Set(readdirSync(data));
const missing = Object.values(manifest).filter((f) => !present.has(f));
if (missing.length) fail(`the manifest names files that do not exist: ${missing.join(', ')}`);

// The page asks for ../demo-data relative to site/demo/, which is site/demo-data. Assert the
// relationship the bundle actually depends on rather than trusting that it still holds.
if (resolve(out, '..', 'demo-data') !== data) fail('site/demo-data is not where the demo page expects it.');

console.log(`Demo assembled: site/demo/index.html + ${Object.keys(manifest).length} captured surfaces.`);
