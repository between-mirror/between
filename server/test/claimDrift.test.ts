// Between — the public copy may not lag the code about what it can read.
//
// The standing doctrine is that a claim may only be as strong as its enforcement. Nothing enforced
// it on the surfaces that actually sell the thing, and it failed in the quieter direction: two
// importers shipped with their tests, STATUS was updated, and the README, the site and the FAQ kept
// saying "Android is the only input the parser understands" for a release afterwards. Understating
// is the friendlier bug and still a false statement about what the software is.
//
// The truth here is taken from the CODE — the importer dispatch — and never from reading prose.
// This project has a postmortem about trying to parse English to check its own honesty, and the
// lesson was to check something mechanical instead. So: every format the dispatcher can actually
// produce must be named on every surface that tells a reader what can be read. Nothing in this file
// tries to judge tone, hedging, or whether a mention was a promise or a denial.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatOf, BETA_FORMATS } from '../src/ingest/index';

const root = resolve(__dirname, '../..');
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8');

/**
 * What the dispatcher does with each extension it accepts. The literal list is the point: adding an
 * importer changes this test, and changing this test is the moment someone has to decide what every
 * public surface says about it. That decision is what got skipped.
 */
const DISPATCH = [
  { path: 'archive.xml', kind: 'android_smsbackup', label: 'Android SMS Backup & Restore' },
  { path: 'chat.txt', kind: 'whatsapp_txt', label: 'WhatsApp' },
  { path: 'chat.zip', kind: 'whatsapp_txt', label: 'WhatsApp' },
  { path: 'export.jsonl', kind: 'generic_jsonl', label: 'generic CSV/JSON/JSONL' },
  { path: 'export.csv', kind: 'generic_jsonl', label: 'generic CSV/JSON/JSONL' },
  { path: 'chat-copy.db', kind: 'imessage_chatdb', label: 'iMessage chat.db' },
] as const;

/** How a reader would recognise each format in copy. */
const NAMED_BY: Record<string, RegExp> = {
  android_smsbackup: /SMS Backup\s*&(?:amp;)?\s*Restore/i,
  whatsapp_txt: /WhatsApp/i,
  generic_jsonl: /\bCSV\b|\bJSONL\b/i,
  imessage_chatdb: /\biMessage\b/i,
};

/** The section of a document that tells a reader what can be read. */
function section(doc: string, start: string, end: string): string {
  const a = doc.indexOf(start);
  if (a < 0) return '';
  const b = doc.indexOf(end, a + start.length);
  return doc.slice(a, b < 0 ? doc.length : b);
}

/**
 * STATUS states its claim as a delimited list rather than as prose.
 *
 * The surrounding paragraphs necessarily NAME iMessage — to say it is not claimed — and no regex can
 * tell a claim from its denial. Rather than try, the authority marks the claim itself.
 */
const CLAIMED_INPUTS = section(read('docs/STATUS.md'), '<!-- claimed-inputs:begin -->', '<!-- claimed-inputs:end -->');

const SURFACES: { name: string; text: string }[] = [
  { name: 'docs/STATUS.md', text: CLAIMED_INPUTS },
  { name: 'README.md', text: section(read('README.md'), 'Today it reads', '---') },
  { name: 'site/index.html', text: section(read('site/index.html'), '<h2>What it reads today</h2>', '</div>') },
  { name: 'site/faq.html', text: section(read('site/faq.html'), '<h3>What formats does it read?</h3>', '</section>') },
  { name: 'site/download.html', text: section(read('site/download.html'), '<h3>Getting your messages off the phone</h3>', '<h2>') },
];

describe('what the code can read, and what the copy says it can', () => {
  it('the dispatcher still routes exactly the extensions this test knows about', () => {
    for (const d of DISPATCH) {
      expect(formatOf(d.path), `${d.path} no longer dispatches where this test expects`).toBe(d.kind);
    }
  });

  it('finds a supported-inputs section on every surface', () => {
    // A heading rename would otherwise leave every assertion below running against an empty string
    // and passing. An extraction test that silently matches nothing is worse than no test.
    for (const s of SURFACES) {
      expect(s.text.length, `${s.name}: no supported-inputs section found`).toBeGreaterThan(40);
    }
  });

  it('every format that is claimable is named on every surface that says what can be read', () => {
    // Claimable = the dispatcher routes it AND it is not behind the beta flag. This is the direction
    // that actually failed: two importers shipped with their tests and the public copy went on
    // saying Android was the only input the parser understood.
    const claimable = [...new Set(DISPATCH.map((d) => d.kind))].filter((k) => !BETA_FORMATS.has(k));
    const missing: string[] = [];
    for (const s of SURFACES) {
      for (const kind of claimable) {
        if (!NAMED_BY[kind].test(s.text)) missing.push(`${s.name} never names ${kind}`);
      }
    }
    expect(missing, 'public copy is behind the importers that shipped').toEqual([]);
  });

  it('a beta importer is NOT in the supported-inputs claim until it has met real files', () => {
    // The other direction, and the one with teeth right now. iMessage is built, tested and behind a
    // flag — but every fixture behind it is synthetic, because the only real chat.db files in
    // existence are somebody's own messages. It joins the claim when two volunteers have read real
    // archives with it cleanly, not when the code lands. Removing it from BETA_FORMATS without
    // updating the copy fails the test above; adding it to the copy early fails this one.
    expect(BETA_FORMATS.has('imessage_chatdb'), 'iMessage left beta — was it verified?').toBe(true);
    expect(
      NAMED_BY.imessage_chatdb.test(CLAIMED_INPUTS),
      'STATUS claims iMessage as a supported input while it is still unverified',
    ).toBe(false);
    // The site's own "what it reads today" must not get ahead of STATUS either.
    expect(NAMED_BY.imessage_chatdb.test(
      section(read('site/faq.html'), '<h3>What formats does it read?</h3>', '</section>'),
    )).toBe(false);
  });

  it('keeps STATUS named as the authority in the README', () => {
    expect(read('README.md')).toMatch(/authority on what is implemented/);
  });
});
