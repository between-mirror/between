// Between Mirror — one version number, in four places, that must never disagree.
//
// The release checklist says "version bumped in all three package.json files", and nothing checked
// it. package-lock.json sat at 0.2.4 through both v0.3.0 and v0.3.1 without anyone noticing, which
// means a fresh clone of either tag reported a version its own tag denied. For a project whose
// central claim is that a version identifies one tree forever, the version being wrong inside the
// tree is not a cosmetic problem.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));

describe('the version is the same number everywhere', () => {
  const root = read('package.json');
  const lock = read('package-lock.json');

  it('agrees across the three package.json files', () => {
    expect({
      root: root.version,
      server: read('server/package.json').version,
      web: read('web/package.json').version,
    }).toEqual({ root: root.version, server: root.version, web: root.version });
  });

  it('agrees with package-lock.json, in both places it records it', () => {
    // npm writes the root version twice: the lockfile header and the "" entry of `packages`.
    // A hand-edited package.json updates neither.
    expect(lock.version, 'package-lock.json header').toBe(root.version);
    expect(lock.packages[''].version, 'package-lock.json packages[""]').toBe(root.version);
  });

  it('is a plain three-part version', () => {
    expect(root.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
