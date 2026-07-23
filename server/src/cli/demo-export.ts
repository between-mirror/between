// Between Mirror — freeze the demo archive's every read surface into static JSON.
//
// This exists so the browser-only demo can be the REAL application, not a mock of it. The pages are
// the same React views, the data is the same data, and the only difference is where the bytes come
// from. Nothing is hand-written here: each file is captured by calling the actual route through
// Fastify's inject(), so what the demo serves is byte-for-byte what the API would have answered. A
// hand-maintained fixture would drift from the app the first time a DTO changed, and the drift would
// be invisible — the demo would simply be quietly wrong about the product it is demonstrating.
//
// Writes are not exported, because the demo has none. See site/demo-shim.js.
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildServer } from '../server';
import { openDb } from '../store/db';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEMO_DB = process.env.BETWEEN_DEMO_DB ?? join(REPO, 'examples', 'demo.db');
const OUT = join(REPO, 'site', 'demo-data');

/**
 * Strip machine-identifying absolute paths out of an exported body.
 *
 * The "Your data" panel truthfully reports where the database, sources, exports and backups live —
 * which on the maintainer's machine means the repository checkout path. Exporting that
 * verbatim would publish the drive layout and directory structure of the machine the release was cut
 * on, to a public website, under a heading about privacy. Caught on the first export.
 *
 * The replacement is not a blank: the panel is a real part of the product and the demo should show it
 * working, so the paths become a plausible, obviously-generic home directory.
 */
export function redactPaths(body: string, repoRoot: string): string {
  const home = '/home/you/Between';

  // One separator, everywhere, first — otherwise a JSON-escaped Windows path (backslashes doubled)
  // and a POSIX one need different patterns, and the greedy version of that mistake ate the tail of
  // every path so the Settings panel showed the same value five times.
  let out = body.replace(/\\\\/g, '/');
  const root = repoRoot.replace(/\\/g, '/');

  // The repo root becomes the fake home, and everything BELOW it is kept: the panel is a real part of
  // the product, so it should read like a real install — demo.db, data/exports, backups.
  if (root) out = out.split(root).join(home);

  // Anything still absolute came from somewhere else (another drive, a temp dir, a different user).
  // Bounded at the quote so it cannot run past the end of its own JSON string.
  out = out.replace(/[A-Za-z]:\/[^"]*/g, home);
  out = out.replace(/\/(?:Users|home)\/(?!you\/Between)[^"]*/g, home);
  return out;
}

/** The URL key the browser shim will look up: path plus sorted query, so ?a=1&b=2 == ?b=2&a=1. */
export function urlKey(url: string): string {
  const [path, qs] = url.split('?');
  if (!qs) return path;
  const sorted = [...new URLSearchParams(qs).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return sorted ? `${path}?${sorted}` : path;
}

/** A filesystem-safe filename for a URL key. Collision-free because the key is embedded verbatim. */
export function slugFor(key: string): string {
  return key.replace(/^\/api\//, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '') + '.json';
}

async function main(): Promise<void> {
  if (!existsSync(DEMO_DB)) {
    console.error(`\nNo demo database at ${DEMO_DB}.\nBuild it first:  npm run demo\n`);
    process.exit(1);
  }

  // Read the shape of the archive first, so the parameterised routes are driven by what is actually
  // in the database rather than by numbers written down here and left to rot.
  const db = openDb(DEMO_DB);
  const threads = db.listThreads();
  const threadIds = threads.map((t) => t.id);
  const episodeIds = (db.raw.prepare('SELECT id FROM episodes ORDER BY id').all() as { id: number }[]).map((r) => r.id);
  const reflectionIds = (db.raw.prepare('SELECT id FROM reflections ORDER BY id').all() as { id: number }[]).map((r) => r.id);
  db.close();

  const urls: string[] = [
    '/api/health', '/api/contacts', '/api/threads', '/api/meta/onboarding',
    '/api/engine-mode', '/api/experimental-lenses', '/api/timezone', '/api/at-rest',
    '/api/data/overview',
  ];
  for (const id of threadIds) {
    urls.push(
      `/api/threads/${id}`,
      `/api/threads/${id}/messages?limit=5000&order=asc`,
      `/api/threads/${id}/moments`,
      `/api/threads/${id}/metrics`,
      `/api/threads/${id}/analysis`,
      `/api/threads/${id}/analysis/status`,
      `/api/threads/${id}/findings`,
      `/api/threads/${id}/calibration`,
      `/api/threads/${id}/reflections`,
      `/api/threads/${id}/emotion`,
      `/api/threads/${id}/trajectory`,
      `/api/threads/${id}/ambient`,
      `/api/threads/${id}/episodes`,
      // Archive health is the last Explore tab and the most important one — it is what says
      // whether to believe the others. Without it frozen here, the one view about missing data is
      // itself missing from the demo.
      `/api/threads/${id}/archive-health`,
    );
  }
  for (const id of episodeIds) urls.push(`/api/episodes/${id}`);
  for (const id of reflectionIds) urls.push(`/api/reflections/${id}`);

  // The three questions the demo can answer.
  //
  // Hand-chosen, but NOT hand-answered: each is put through the real /ask/plan route below, so the
  // reply is the planner's own, receipts and all — including its refusal when the archive does not
  // reach far enough. Writing the answers here instead would make the demo a mock of the one claim
  // the product most needs to be believed about, which is that answers come from the words.
  //
  // The third is deliberately a question the archive cannot support. A demo that only ever shows the
  // tool succeeding teaches the wrong thing about it; the honest decline is the feature.
  // Phrased as what they are. Ask is a receipts-first SEARCH over the words, not a model answering a
  // sentence, so a chip reading "when did we argue about money?" would send that whole string to
  // full-text search, match nothing, and teach the visitor the tool is worse than it is. The chip
  // shows exactly the query it runs, and the box shows it too.
  //
  // Chosen against the real archive: "sorry" returns 29 receipts, "miss you" 17, "money" none.
  const askQuestions = ['sorry', 'miss you', 'kids'];

  const app = buildServer(DEMO_DB);
  await app.ready();

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const manifest: Record<string, string> = {};
  let bytes = 0;
  const failures: string[] = [];

  for (const url of urls) {
    const res = await app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:5274' } });
    if (res.statusCode !== 200) {
      // A 404 on a route that genuinely has nothing (no eras yet, say) is legitimate and is captured
      // as-is, so the demo shows what the app really does. Anything else is a broken export.
      if (res.statusCode !== 404) { failures.push(`${res.statusCode} ${url}`); continue; }
    }
    const key = urlKey(url);
    const slug = slugFor(key);
    const body = redactPaths(res.body, REPO);
    writeFileSync(join(OUT, slug), body, 'utf8');
    manifest[key] = slug;
    bytes += Buffer.byteLength(body);
  }

  // POST surfaces, keyed by path AND body, so the shim can answer exactly these and refuse the rest.
  const posts: Record<string, string> = {};
  for (const id of threadIds) {
    for (const question of askQuestions) {
      const body = { query: question, filters: {} };
      const res = await app.inject({
        method: 'POST', url: `/api/threads/${id}/ask/plan`,
        headers: { host: '127.0.0.1:5274', 'content-type': 'application/json' },
        payload: body,
      });
      if (res.statusCode !== 200) { failures.push(`${res.statusCode} POST ask/plan "${question}"`); continue; }
      const key = `POST /api/threads/${id}/ask/plan ${JSON.stringify(body)}`;
      const slug = `ask_${id}_${question.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')}.json`;
      writeFileSync(join(OUT, slug), redactPaths(res.body, REPO), 'utf8');
      posts[key] = slug;
      bytes += Buffer.byteLength(res.body);
    }
  }
  writeFileSync(join(OUT, 'questions.json'), JSON.stringify(askQuestions, null, 2) + '\n', 'utf8');
  writeFileSync(join(OUT, 'posts.json'), JSON.stringify(posts, null, 2) + '\n', 'utf8');

  await app.close();

  if (failures.length) {
    console.error(`\nExport FAILED — these routes did not answer:\n  ${failures.join('\n  ')}\n`);
    process.exit(1);
  }

  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`Exported ${Object.keys(manifest).length} read surfaces to site/demo-data (${(bytes / 1024).toFixed(0)} KB).`);
}

// Only when run as a command. Importing this module for its helpers must not export anything, and
// must certainly not call process.exit: the test that imports `redactPaths` would otherwise re-run
// the whole export on load, and on a machine without examples/demo.db (every CI runner — the demo
// database is a build artifact, not a tracked file) it would exit(1) and take the entire test process
// down with it. Caught by the exporter's own test printing an export it never asked for.
const isEntryPoint = !!process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
