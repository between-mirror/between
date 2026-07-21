// Between Mirror — the site must not phone anyone (Era 2).
//
// The landing pages argue that this software does not talk to third parties. A page making that
// argument while pulling a font from a CDN, a script from an analytics host, or an image from an
// image service is not making an argument — it is a joke at the reader's expense, and the reader has
// no way to check without opening devtools.
//
// So the check is mechanical and runs in CI on every push: every URL referenced by the site must be
// same-origin, and the page must contain no mechanism capable of fetching from elsewhere. This is the
// static half of the assurance — it inspects what actually ships, which is what a visitor executes.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';

const SITE = resolve(__dirname, '../../site');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = existsSync(SITE) ? walk(SITE) : [];
const allTextFiles = files.filter((f) => ['.html', '.css', '.js', '.json', '.svg'].includes(extname(f)));
const rel = (f: string) => f.slice(SITE.length + 1).replace(/\\/g, '/');

// The site is two different things with two different guarantees, and one rule cannot cover both.
//
// The MARKETING pages are hand-written HTML and CSS that ship no JavaScript at all. That is the
// strongest available form of "no trackers": there is nothing to audit.
//
// The BROWSER DEMO (site/demo, built by `npm run demo:build`) is the real React application, so it is
// necessarily a script bundle, and its captured data (site/demo-data) is necessarily JSON. Applying
// the no-scripts rule there would only ever produce one of two outcomes: no demo, or a weakened rule
// for the whole site. So the demo keeps a different promise, asserted separately below — every URL it
// contains has been read and approved one at a time.
//
// site/demo is a build artifact and is not committed, so on a clean checkout these lists are empty
// and the demo assertions skip. The Pages workflow builds it before deploying, which is where they
// bite. Checked here so a developer who HAS built it locally does not get a red suite for it.
const isDemo = (f: string) => rel(f).startsWith('demo/') || rel(f).startsWith('demo-data/');
const textFiles = allTextFiles.filter((f) => !isDemo(f));
const demoFiles = allTextFiles.filter(isDemo);

describe('the site exists and is plain static files', () => {
  it('has the eight pages the launch kit promises', () => {
    for (const page of ['index.html', 'demo.html', 'download.html', 'privacy.html',
      'security.html', 'method.html', 'pricing.html', 'faq.html']) {
      expect(files.map(rel), `site/${page} is missing`).toContain(page);
    }
  });
});

describe('the site makes zero external requests', () => {
  // Anything that could name another origin. Protocol-relative (//host) counts: it is the classic way
  // an external asset hides from a naive grep for "https://".
  const ABSOLUTE_URL = /(?:https?:)?\/\/[^\s"'()<>]+/gi;

  // Links a visitor CLICKS are fine — they are navigation, not a request the page makes on its own.
  // These attributes are where a URL becomes an automatic fetch.
  const FETCHING_ATTR = /\b(?:src|srcset|poster|data|action|formaction)\s*=\s*["']([^"']+)["']/gi;
  const CSS_URL = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
  const IMPORT_AT = /@import\s+(?:url\()?\s*['"]([^'"]+)['"]/gi;
  // <link rel=stylesheet|preload|prefetch|preconnect|dns-prefetch ...> all cause a request.
  const LINK_TAG = /<link\b[^>]*>/gi;

  it('no element fetches from another origin', () => {
    const bad: string[] = [];
    for (const f of textFiles) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(FETCHING_ATTR)) {
        if (ABSOLUTE_URL.test(m[1])) bad.push(`${rel(f)}: ${m[0]}`);
        ABSOLUTE_URL.lastIndex = 0;
      }
      for (const re of [CSS_URL, IMPORT_AT]) {
        for (const m of src.matchAll(re)) {
          if (/^(?:https?:)?\/\//i.test(m[1])) bad.push(`${rel(f)}: ${m[0]}`);
        }
      }
      for (const m of src.matchAll(LINK_TAG)) {
        const tag = m[0];
        // A <link> that is not a plain navigational rel and points off-origin is a request.
        const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? '';
        if (/^(?:https?:)?\/\//i.test(href) && !/rel\s*=\s*["'](?:canonical|alternate|me)["']/i.test(tag)) {
          bad.push(`${rel(f)}: ${tag}`);
        }
      }
    }
    expect(bad, `the site would fetch from another origin:\n  ${bad.join('\n  ')}`).toEqual([]);
  });

  it('ships no scripts at all on the marketing pages', () => {
    // The pages that make the argument need no JavaScript. Having none is stronger than auditing what
    // it does, and it means the "no trackers" claim cannot rot the next time someone adds a
    // convenience. The demo under site/demo is the application itself and is necessarily a bundle —
    // it keeps a different, separately-asserted promise, and is excluded here rather than being
    // allowed to soften this rule for the pages that do not need it.
    const withScripts = textFiles.filter((f) => /<script\b/i.test(readFileSync(f, 'utf8')));
    expect(withScripts.map(rel)).toEqual([]);
    expect(files.filter((f) => extname(f) === '.js' && !isDemo(f)).map(rel)).toEqual([]);
  });

  it('has no analytics, tag manager, or font-service host anywhere in its text', () => {
    // Written as HOSTNAMES, with their TLDs, and matched as such. The first version matched bare
    // substrings, which is fine for hand-written HTML and wrong the moment it meets a minified
    // bundle: React registers an `onDoubleClick` event, "doubleclick" is a substring of it, and the
    // demo build failed this test for containing standard DOM event names. A rule that cries wolf on
    // React is a rule someone will eventually delete.
    const HOSTS = [
      'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'facebook.net',
      'connect.facebook.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net',
      'unpkg.com', 'cdnjs.cloudflare.com', 'plausible.io', 'segment.com', 'sentry.io',
      'hotjar.com', 'mixpanel.com', 'posthog.com', 'matomo.cloud', 'clarity.ms', 'bugsnag.com',
      'intercom.io', 'hs-scripts.com',
    ];
    const bad: string[] = [];
    for (const f of allTextFiles) {                       // marketing AND demo — this one applies to both
      const low = readFileSync(f, 'utf8').toLowerCase();
      for (const h of HOSTS) if (low.includes(h)) bad.push(`${rel(f)}: ${h}`);
    }
    expect(bad).toEqual([]);
  });

  it('every URL in a meta tag points at our own origin', () => {
    // og:image and twitter:image are fetched by every link-preview crawler that sees the page, and
    // nothing checked them: this test looks at src/srcset/poster/data/action, and the workflow grep
    // looks at (src|href). `content=` was covered by neither — and social cards are the one URL class
    // this release introduced. An off-origin card image would have shipped unnoticed.
    const SELF = /^https:\/\/between-mirror\.github\.io\/between\//i;
    const bad: string[] = [];
    for (const f of textFiles.filter((x) => extname(x) === '.html')) {
      for (const tag of readFileSync(f, 'utf8').match(/<meta\b[^>]*>/gi) ?? []) {
        // Read the attributes independently: content= may appear before or after property=/name=.
        const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? '(unnamed)';
        const val = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? '';
        if (!/^(?:https?:)?\/\//i.test(val)) continue;      // relative or not a URL at all
        if (!SELF.test(val)) bad.push(`${rel(f)}: ${key} → ${val}`);
      }
    }
    expect(bad, `a meta tag names an off-origin URL:\n  ${bad.join('\n  ')}`).toEqual([]);
  });

  it('uses only system fonts', () => {
    const css = readFileSync(join(SITE, 'style.css'), 'utf8');
    expect(css).not.toMatch(/@font-face/i);
  });

  it('every outbound link a visitor can click goes somewhere we would stand behind', () => {
    // Clicking is the visitor's choice, so these are allowed — but not to arbitrary hosts, because a
    // link is still an endorsement and a typo'd domain is somebody else's site.
    // Kept in step with the same allow-list in .github/workflows/pages.yml. They disagreed once:
    // the workflow granted between-mirror.github.io and this did not, so a link to the site's own
    // FAQ passed the deploy guard and failed the suite with a misleading message.
    const ALLOWED = /^https:\/\/(between-mirror\.github\.io\/between\/|github\.com\/between-mirror\/|nodejs\.org|www\.contributor-covenant\.org|988lifeline\.org|findahelpline\.com)/i;
    const bad: string[] = [];
    for (const f of textFiles.filter((x) => extname(x) === '.html')) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
        const href = m[1];
        if (!/^(?:https?:)?\/\//i.test(href)) continue;   // relative → same origin
        if (!ALLOWED.test(href)) bad.push(`${rel(f)}: ${href}`);
      }
    }
    expect(bad, `unexpected outbound link:\n  ${bad.join('\n  ')}`).toEqual([]);
  });
});

// Gated on the BUILT BUNDLE, not on the captured data. site/demo-data is tracked and therefore always
// present, so keying the skip off it left these tests running on a clean checkout and failing for the
// absence of a build artifact that is not supposed to be committed. The data has its own tests in
// demoExport.test.ts, which always run.
const demoBuilt = files.some((f) => rel(f) === 'demo/index.html');

describe.skipIf(!demoBuilt)('the browser demo talks only to its own origin', () => {
  // The demo's whole argument is that a tool which reads your most private material can be inspected
  // rather than trusted. A demo of that tool which quietly loaded a font, a bundle, or a beacon from
  // somewhere else would be a rebuttal of the product, published on the product's own website.
  //
  // Verified empirically as well as statically: loaded from a plain static server, the built demo
  // issues exactly six requests — the page, its JS, its CSS, the manifest, and the captured JSON it
  // needs — all same-origin, with writes refused locally by the shim and never reaching the network.
  // This test is the part that keeps being true after the next change.

  // Every absolute URL the bundle contains, read and approved individually. Both entries are strings
  // that are never fetched: XML namespace URIs are identifiers the DOM spec requires verbatim, and
  // React's error-decoder link appears inside a message a developer would click, not a request.
  const APPROVED_URLS = [
    'http://www.w3.org/',            // XML/SVG/MathML namespace identifiers — not network addresses
    'https://reactjs.org/docs/error-decoder.html',  // text inside a production error message
  ];

  it('contains no absolute URL that has not been read and approved', () => {
    const bad: string[] = [];
    for (const f of demoFiles) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/(?:https?:)?\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s"'`,;)\]}]*/g)) {
        const url = m[0];
        if (APPROVED_URLS.some((a) => url.startsWith(a))) continue;
        bad.push(`${rel(f)}: ${url}`);
      }
    }
    expect(
      bad,
      'the demo references an origin nobody approved. If it is genuinely never fetched, add it to '
      + 'APPROVED_URLS with the reason:\n  ' + bad.join('\n  '),
    ).toEqual([]);
  });

  it('serves its data from a relative path, so it works wherever it is hosted', () => {
    // An absolute data path would tie the bundle to one host and give anyone who forks this a blank
    // page with no explanation.
    const js = demoFiles.filter((f) => extname(f) === '.js').map((f) => readFileSync(f, 'utf8')).join('');
    if (!js) return;
    expect(js, 'the demo should resolve its data relative to the page').toContain('../demo-data');
  });

  it('ships the captured data the page depends on', () => {
    const names = demoFiles.map(rel);
    expect(names, 'the demo manifest must ship').toContain('demo-data/manifest.json');
    expect(names.some((n) => n === 'demo/index.html'), 'site/demo/index.html must exist or /demo/ 404s').toBe(true);
  });
});

describe('the prose pages declare a policy the browser will enforce', () => {
  // The egress tests inspect what ships. A Content-Security-Policy is the other half: it makes the
  // browser refuse anything that was added later and slipped past them. The site needs no scripts and
  // no connections, so it can declare the strictest form of that and mean it.
  //
  // The policy was written to fit the pages, not the other way round: all eight were checked for
  // inline style attributes and <style> blocks first, and had none, so 'self' needs no 'unsafe-inline'
  // escape hatch. If a page ever needs one, the page gets refactored — not the policy loosened.
  const CSP = "default-src 'self'; script-src 'none'; connect-src 'none'; img-src 'self'; "
    + "style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

  const proseHtml = textFiles.filter((f) => extname(f) === '.html');

  it('every prose page carries the exact policy', () => {
    expect(proseHtml.length, 'no prose pages found').toBeGreaterThan(5);
    const bad: string[] = [];
    for (const f of proseHtml) {
      const src = readFileSync(f, 'utf8');
      // content="…" only, because the policy itself is full of single quotes ('self', 'none'). A
      // character class excluding both quote kinds stops dead at the first one and reports every page
      // as having no CSP at all.
      const m = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?>/i.exec(src);
      if (!m) { bad.push(`${rel(f)}: no CSP meta`); continue; }
      if (m[1].trim() !== CSP) bad.push(`${rel(f)}: policy differs — ${m[1]}`);
    }
    expect(bad, `CSP problem:\n  ${bad.join('\n  ')}`).toEqual([]);
  });

  it('declares it after the charset, so the charset is still the first thing parsed', () => {
    for (const f of proseHtml) {
      const src = readFileSync(f, 'utf8');
      expect(src.indexOf('charset'), `${rel(f)}`).toBeLessThan(src.indexOf('Content-Security-Policy'));
    }
  });

  it('has no inline style or script for the policy to have to permit', () => {
    // The check that keeps the policy honest. A page that grows a style="" attribute would be
    // silently broken by its own CSP, and the tempting fix is 'unsafe-inline' for everybody.
    const bad: string[] = [];
    for (const f of proseHtml) {
      const src = readFileSync(f, 'utf8');
      if (/\sstyle\s*=\s*["']/i.test(src)) bad.push(`${rel(f)}: inline style attribute`);
      if (/<style\b/i.test(src)) bad.push(`${rel(f)}: <style> block`);
      if (/<script\b/i.test(src)) bad.push(`${rel(f)}: <script>`);
    }
    expect(bad, `inline content the policy forbids:\n  ${bad.join('\n  ')}`).toEqual([]);
  });

  it('does not apply the scriptless policy to the demo, which is an application', () => {
    // The demo is the real app and necessarily runs script. It must NOT carry script-src 'none' —
    // that would ship a page guaranteed to be blank. The prose policy stays strict for the pages that
    // can afford it; the demo's own egress guarantee is asserted separately above.
    const demoIndex = demoFiles.find((f) => rel(f) === 'demo/index.html');
    if (!demoIndex) return;                       // not built in this checkout
    const src = readFileSync(demoIndex, 'utf8');
    expect(src, 'the demo must not inherit the prose page policy').not.toContain("script-src 'none'");
  });
});

describe('the site does not overclaim', () => {
  const html = textFiles
    .filter((f) => extname(f) === '.html')
    .map((f) => ({ f: rel(f), text: readFileSync(f, 'utf8').replace(/\s+/g, ' '), raw: readFileSync(f, 'utf8') }));

  // ── the evidence vocabulary ──────────────────────────────────────────────────────────────────
  //
  // These words are BANNED from this site, except inside sentences that have been read and approved
  // one at a time, quoted below.
  //
  // Three versions of this check tried to decide mechanically whether a sentence asserted a claim or
  // refused it, and all three shipped green while being defeated. The first let a 1123-character
  // pseudo-sentence absolve anything inside it. The second made every tag a hard break, which broke
  // honest copy that emphasised the refused term, and still split on the source file's own line
  // wrapping — so the site's one real use of these words passed by luck, and any reflow would have
  // flipped it. The third required a negation within a few words before the term; an adversarial pass
  // produced 25 bypasses and 16 false positives against it. "Nothing is more court-ready." and "There
  // is no doubt that every export is court-ready." both passed. "We don't produce court-ready
  // exports." and a question-and-answer split across two blocks both failed.
  //
  // That is not a bug to fix. Deciding whether English asserts or denies is not something a regular
  // expression can do, and every refinement traded a bypass for a false positive. So this no longer
  // tries: ANY occurrence of the vocabulary anywhere in a page — body text, attribute, comment,
  // however spelled or encoded — fails, unless it sits inside an approved sentence for that page.
  //
  // The remaining false positives are the feature. Writing a new sentence containing one of these
  // words fails the build until a person adds it to this list, having read it and decided it refuses
  // rather than asserts. The list IS the review. It is short because the site barely uses these words.
  const APPROVED: Record<string, string[]> = {
    'privacy.html': ['no evidence-grade or court-ready claims'],
    'index.html': ['not a way to build a case against someone'],
    'faq.html': ['there is no "build a case" mode and there will not be one'],
  };

  // Generous on purpose: a false positive costs one reviewed line above; a miss ships an overclaim.
  const CLAIM_SOURCE = [
    'court[\\s-]*ready', 'court[\\s-]*admissible', 'evidence[\\s-]*grade', 'evidence[\\s-]*quality',
    'legal(?:ly)?[\\s-]*admissible', 'admissible', 'forensically sound', 'build a case',
    'legal proof', 'stand up in court', 'ready for a (?:judge|court|lawyer)',
  ].join('|');

  /**
   * Everything a reader could encounter, flattened and normalised so no encoding trick hides a word.
   * Deliberately includes comments and scripts: a commented-out overclaim is still something a person
   * should have to look at before it ships.
   */
  function searchableText(raw: string): string {
    // Numeric entities, guarded. String.fromCodePoint throws on out-of-range values, and an extractor
    // that crashes on malformed input reports nothing at all rather than reporting a problem.
    const safe = (n: number) => (Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ');
    let s = raw
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => safe(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => safe(parseInt(d, 10)))
      .replace(/&nbsp;/gi, ' ').replace(/&shy;/gi, '').replace(/&zerowidthspace;/gi, '')
      .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&amp;/gi, '&');
    // Invisible characters, and characters that render as an ordinary hyphen, so that
    // "evi<zero-width-space>dence-grade" and "court<non-breaking-hyphen>ready" cannot hide.
    s = s.replace(/[­​-‏﻿⁠]/g, '')
      .replace(/[‐‑‒–—−]/g, '-')
      .replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
    // A comment renders as NOTHING, so it is removed rather than spaced — otherwise
    // "evi<!-- -->dence-grade" reads as two words here and one word to every visitor.
    s = s.replace(/<!--[\s\S]*?-->/g, '');

    // A tag becomes its own ATTRIBUTE VALUES, not nothing. Deleting tags outright threw away alt,
    // title and meta content — copy a reader genuinely encounters, through screen readers, tooltips,
    // broken images and link previews — and an overclaim parked in alt text sailed through.
    //
    // Only '<' followed by a letter or '/' starts a tag. "if your hearing is < 30 days away" is
    // literal text to an HTML tokenizer, and treating it as a tag deleted the rest of the sentence
    // while browsers went on rendering it.
    s = s.replace(/<\/?[a-zA-Z][^>]*>/g, (tag) => {
      const values: string[] = [];
      for (const a of tag.matchAll(/[a-zA-Z_:][-a-zA-Z0-9_:.]*\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
        values.push(a[1] ?? a[2] ?? a[3] ?? '');
      }
      return ` ${values.join(' ')} `;
    });
    return s.replace(/\s+/g, ' ').toLowerCase();
  }

  /** Claim words still present once every approved sentence for this page has been removed. */
  function unapprovedClaims(file: string, raw: string): string[] {
    let text = searchableText(raw);
    for (const snippet of APPROVED[file] ?? []) {
      // Remove EVERY occurrence, so one approved sentence cannot absolve a second, unapproved use of
      // the same words elsewhere on the same page.
      text = text.split(searchableText(snippet)).join(' ');
    }
    return [...text.matchAll(new RegExp(CLAIM_SOURCE, 'gi'))].map((m) => m[0]);
  }

  it('uses the evidence vocabulary only in sentences that were approved one at a time', () => {
    const bad: string[] = [];
    for (const { f, raw } of html) {
      for (const hit of unapprovedClaims(f, raw)) {
        bad.push(`${f}: "${hit}" is not inside an approved sentence`);
      }
    }
    expect(
      bad,
      'an evidence claim appears outside the approved list. If the new sentence genuinely refuses '
      + 'the claim, add it to APPROVED in this file — that addition is the review:\n  ' + bad.join('\n  '),
    ).toEqual([]);
  });

  it('every approved sentence is still actually on the page it was approved for', () => {
    // Otherwise the list rots into a set of permissions for text nobody can find, and a future
    // overclaim could match a stale entry.
    const stale: string[] = [];
    for (const [file, snippets] of Object.entries(APPROVED)) {
      const page = html.find((h) => h.f === file);
      if (!page) { stale.push(`${file} (page missing)`); continue; }
      for (const s of snippets) {
        if (!searchableText(page.raw).includes(searchableText(s))) stale.push(`${file}: "${s}"`);
      }
    }
    expect(stale, `APPROVED lists text that is no longer on the page:\n  ${stale.join('\n  ')}`).toEqual([]);
  });

  it('catches the claims that defeated all three previous versions of this check', () => {
    // Every one of these was demonstrated passing against an earlier design. They are kept as tests
    // because the failure mode here is silence: a broken checker and a clean site look identical.
    const DEFEATED_EARLIER = [
      '<p>The export is court-ready.</p>',
      '<p>Nothing is more court-ready.</p>',                                  // negation, not a refusal
      '<p>There is no doubt that every export is court-ready.</p>',
      '<p>No other tool gives you court-ready exports this fast.</p>',
      '<p>Your archive is not uploaded anywhere, and every export is court-ready.</p>',
      '<p>Every export is legally-admissible.</p>',                           // hyphen the old regex missed
      '<p>Every export is evidence-quality.</p>',
      '<p>Every export is court-admissible.</p>',
      '<p>Every export is forensically sound.</p>',
      '<p>If your hearing is < 30 days away, the export is already evidence-grade.</p>',
      '<p>The export is &#101;vidence-grade.</p>',                            // entity
      '<p>The export is evi&#8203;dence-grade.</p>',                          // zero-width space
      '<p>The export is evi<!-- -->dence-grade.</p>',                         // comment inside the word
      '<p>The export is court‑ready.</p>',                               // non-breaking hyphen
      '<img alt="a court-ready, evidence-grade export">',
      '<img src="x.png" alt=court-ready>',                                    // unquoted attribute
      '<meta name="description" content=court-ready>',
      '<p><?x never ?>The export is court-ready.</p>',                        // bogus comment smuggling
      '<p><!never>The export is court-ready.</p>',
      '<p>The export is &#x110000;court-ready.</p>',                          // used to throw RangeError
      '<noscript><p>The export is court-ready.</p></noscript>',
    ];
    const missed = DEFEATED_EARLIER.filter((h) => unapprovedClaims('nowhere.html', h).length === 0);
    expect(missed, `these overclaims were not caught:\n  ${missed.join('\n  ')}`).toEqual([]);
  });

  it('accepts an approved sentence however the source happens to wrap or encode it', () => {
    // The approved text is matched after the same normalisation, so reformatting the page — a reflow,
    // an added <em>, a curly apostrophe — cannot turn an approved sentence back into a failure.
    const variants = [
      '<p>no evidence-grade or court-ready claims</p>',
      '<p>no\n  evidence-grade or court-ready\n  claims</p>',
      '<p>no <em>evidence-grade</em> or <em>court-ready</em> claims</p>',
      '<p>no evidence&#45;grade or court-ready claims</p>',
    ];
    for (const v of variants) expect(unapprovedClaims('privacy.html', v), v).toEqual([]);
  });

  it('does not let one approved sentence absolve a second, unapproved use', () => {
    const page = '<p>no evidence-grade or court-ready claims</p><p>But every export is court-ready.</p>';
    expect(unapprovedClaims('privacy.html', page)).toEqual(['court-ready']);
  });

  // ── the rest of the honest-statement checks ──────────────────────────────────────────────────
  // These look for REQUIRED sentences rather than trying to catch dishonest ones by pattern. An
  // earlier version did the latter and flagged the site's own denials — "Does it detect abuse? No."
  // read as marketing abuse detection. A regex cannot tell a claim from its refusal, which is the
  // same lesson the block above is built on.

  it('wherever abuse is raised, the page states the layer is not validated and not a detector', () => {
    for (const { f, text } of html) {
      if (!/\babuse\b/i.test(text)) continue;
      expect(text, `${f} raises abuse without the standing caveat`)
        .toMatch(/not externally validated|will not be marketed as abuse detection|not an abuse detector/i);
    }
  });

  it('says on the front page what it is not', () => {
    const home = html.find((h) => h.f === 'index.html')!.text;
    expect(home).toMatch(/Not a therapist/i);
    expect(home).toMatch(/Not a judge/i);
    expect(home).toMatch(/build a case/i);   // named in order to refuse it
  });

  it('states the input scope precisely rather than saying "your messages"', () => {
    const home = html.find((h) => h.f === 'index.html')!.text;
    expect(home).toMatch(/Android/);
    expect(home).toMatch(/iPhone is not supported/i);
  });

  it('says plainly that the installer is not for sale yet', () => {
    const pricing = html.find((h) => h.f === 'pricing.html')!.text;
    expect(pricing).toMatch(/(?:is|are) not for sale yet|Nothing is for sale yet/i);
    expect(pricing).toMatch(/\$29/);
    expect(pricing).toMatch(/\$49/);
  });

  it('describes the browser demo that now exists, and its limits', () => {
    // This assertion used to require the OPPOSITE — that the page said the browser demo was "not live
    // yet" — because for three releases it wasn't, and the page refusing to imply otherwise was the
    // honest position. The demo now ships, so the test flips with it: what has to stay true is that
    // the page and the product agree, in whichever direction that is.
    const demo = html.find((h) => h.f === 'demo.html')!.text;
    expect(demo, 'the demo page should link to the demo').toMatch(/href="demo\/"/i);
    expect(demo, 'and say plainly that writes are off').toMatch(/turned off|switched off|cannot be changed/i);
    expect(demo, 'and that Ask offers prepared questions rather than free typing')
      .toMatch(/prepared question|suggestion|rather than a text box/i);
  });

  it('does not promise the demo can do things it cannot', () => {
    const demo = html.find((h) => h.f === 'demo.html')!.text;
    // The demo is read-only. A page inviting someone to "import your archive" there would be sending
    // them to a button that refuses.
    expect(demo).not.toMatch(/import your (own )?archive here|upload your/i);
  });

  // ── the v0.3.2 truth pass ────────────────────────────────────────────────────────────────────
  // Each of these replaced a sentence that was too absolute to be true. Absolutes are what copy
  // drifts back towards, because they read better — so the removals are asserted, not just made.

  it('scopes the privacy claim to the project rather than to the web host', () => {
    const privacy = html.find((h) => h.f === 'privacy.html')!.text;
    expect(privacy, 'the privacy page must name its own host').toMatch(/GitHub Pages/i);
    expect(privacy).toMatch(/request metadata|IP address/i);
    expect(privacy, 'and still state what the project itself collects').toMatch(/project collects nothing/i);
  });

  it('keeps the update check in the future tense, because it does not exist yet', () => {
    const privacy = html.find((h) => h.f === 'privacy.html')!.text;
    expect(privacy).toMatch(/Today it makes none/i);
    expect(privacy).toMatch(/does not exist yet/i);
    expect(privacy, 'telemetry stays permanently absent regardless').toMatch(/Telemetry remains permanently absent/i);
  });

  it('describes the paid edition as packaging, never as better software or better privacy', () => {
    const pricing = html.find((h) => h.f === 'pricing.html')!.text;
    expect(pricing).toMatch(/not exclusive insights or stronger privacy/i);
  });

  it('states the containment ceiling without claiming protection it does not have', () => {
    const security = html.find((h) => h.f === 'security.html')!.text;
    expect(security).toMatch(/enforced invariant with a regression test/i);
    expect(security).toMatch(/not OS-level isolation/i);
    expect(security, 'the honest half: it does not claim the layer cannot fail')
      .toMatch(/does not claim protection against a failure in that containment layer/i);
  });

  it('does not resurrect the absolutes the truth pass removed', () => {
    // Every one of these shipped on this site and every one was false or unprovable. If a future
    // edit reaches for the tidier sentence again, this fails and names it.
    const BANNED: Array<[RegExp, string]> = [
      [/no network request of any kind/i, 'the update-check policy makes this false'],
      [/no phone-home of any kind/i, 'too absolute: the updater is a request, just not a report'],
      [/no version ping\b/i, 'contradicts the adopted update policy'],
      [/nothing is uploaded/i, 'unqualified; readings you choose do send text'],
      [/byte-for-byte the free one/i, 'a signed build is not byte-identical to an unsigned one'],
      // The same absolute in different words. Banning one phrasing and leaving its synonyms is how
      // "byte-for-byte" survived as "The software is identical" on the very next page.
      [/the software is identical/i, 'the packaged build adds signing and OS-level containment'],
      [/everything the paid (?:installer|edition) will do, the source already does/i, 'the installer is not built yet'],
      [/every protection on this site applies identically/i, 'OS-level containment lands only in the packaged app'],
    ];
    const bad: string[] = [];
    for (const { f, text } of html) {
      for (const [re, why] of BANNED) if (re.test(text)) bad.push(`${f}: /${re.source}/ — ${why}`);
    }
    expect(bad, `an absolute the truth pass removed is back:\n  ${bad.join('\n  ')}`).toEqual([]);
  });
});
