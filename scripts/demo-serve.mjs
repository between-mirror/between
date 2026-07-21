// Between Mirror — serve the fictional demo (Alex & Jordan) without touching your own between.db.
// Points the API at examples/demo.db via BETWEEN_DB, then runs the dev servers. Cross-platform.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ABSOLUTE, deliberately. `npm run dev` starts the API through `npm --workspace server`, whose cwd is
// server/ — so a relative BETWEEN_DB resolved to server/examples/demo.db and the API died on boot
// with SQLITE_CANTOPEN while the web server came up fine. The failure looked like a broken app.
const given = process.env.BETWEEN_DB;
process.env.BETWEEN_DB = given
  ? (isAbsolute(given) ? given : resolve(process.cwd(), given))
  : resolve(repoRoot, 'examples', 'demo.db');

if (!existsSync(process.env.BETWEEN_DB)) {
  console.error(`\nNo demo database at ${process.env.BETWEEN_DB}.`);
  console.error('Build it first:  npm run demo\n');
  process.exit(1);
}

console.log(`\nServing the demo from ${process.env.BETWEEN_DB} — your own between.db is untouched.`);
console.log('Open http://localhost:5273 and meet Alex & Jordan (a fictional couple).\n');

const child = spawn('npm', ['run', 'dev'], {
  stdio: 'inherit', shell: true, env: process.env, cwd: repoRoot,
});
child.on('exit', (code) => process.exit(code ?? 0));
