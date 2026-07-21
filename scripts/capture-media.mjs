// Between Mirror — capture the docs/media visuals from the fictional demo.
//
// The images in the README and on the landing page are screenshots of the real application reading a
// real database. They are never mockups, and they are never anyone's real archive: the only people who
// appear in them are **Alex & Jordan**, the fictional couple generated deterministically by
// `server/src/cli/gen-demo.ts`. That is a permanent rule, not a convention for now — the author's own
// thread is user zero and is never the demo, the screenshot, or the case study.
//
// This exists as a script rather than a manual ritual so the visuals can be regenerated the moment the
// UI changes, instead of slowly drifting into a picture of software that no longer exists.
//
//   npm run demo:serve         # in one terminal — serves examples/demo.db, never your own
//   npm run capture:media      # in another
//
// Playwright's browser binary is NOT installed by `npm install`; run `npx playwright install chromium`
// once. CI does not run this — it is a docs tool.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs', 'media');
const URL_BASE = process.env.BETWEEN_URL ?? 'http://localhost:5273';

// A desktop shape that suits a README: wide enough for the river to breathe, short enough that the
// image is not mostly empty. deviceScaleFactor 2 so the type is crisp on a retina screen.
const VIEWPORT = { width: 1440, height: 900 };

/**
 * Screenshots hang while a CSS animation or a backdrop-filter is in flight — the capture waits for a
 * frame that never settles. Every browser-driving tool hits this, so it is disabled here rather than
 * worked around per-tool. It changes nothing about what the UI *is*: no motion, and a flat bar instead
 * of a blurred one, which is what a still image would show anyway.
 */
const CAPTURE_CSS = `
  *, *::before, *::after { animation: none !important; transition: none !important; }
  .app-header, .panel-tabs { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
  /* the caret in the Ask box blinks forever and lands mid-blink */
  input, textarea { caret-color: transparent !important; }
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openThread(page) {
  // 'networkidle' never settles against a dev server (Vite's HMR socket stays open), and the proxy
  // occasionally drops the first API call after the API process restarts under it — leaving the app
  // sitting on its boot screen forever. So: load, wait for the app to actually render something
  // interactive, and reload once if it did not.
  for (let attempt = 1; ; attempt++) {
    await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForSelector('button.thread-card, button', { timeout: 40000 });
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
      console.log(`  (the app did not come up; reloading — attempt ${attempt + 1})`);
    }
  }
  await page.addStyleTag({ content: CAPTURE_CSS });
  // The onboarding threshold appears only on a first run; skip it when present.
  const cont = page.getByRole('button', { name: /^Continue$/ });
  if (await cont.count()) { await cont.first().click(); await sleep(400); }
  await page.locator('button.thread-card').first().click();
  await page.waitForSelector('[role="tab"]');
  await sleep(900);          // let the river and the heatmaps finish drawing
}

/** Move to a surface, and to a view inside it when that surface has a subnav. */
async function go(page, surface, view) {
  await page.getByRole('tab', { name: surface, exact: true }).click();
  await sleep(400);
  if (view) {
    await page.getByRole('tab', { name: view, exact: true }).click();
    await sleep(700);
  }
}

/** Fail the run rather than ship a screenshot of the wrong screen. */
async function expectVisible(page, locator, why) {
  const selected = await locator.getAttribute('aria-selected').catch(() => null);
  const visible = await locator.isVisible().catch(() => false);
  if (!visible || selected === 'false') throw new Error(why);
}

/**
 * Wait for the content the caption is going to claim is in the picture, and fail loudly if it never
 * arrives.
 *
 * Four of the six shipped images were screenshots of loading spinners and empty states — a hero
 * captioned "a warmth-and-tension river across two years" that was in fact the words "Reading the
 * shape of these years…" over an empty panel, and a receipt image captioned as a claim opened to its
 * evidence that was actually "No reading yet". They shipped because `shot()` is unconditional and the
 * script waited a fixed number of milliseconds instead of waiting for anything in particular. The
 * pictures were of the real application, which is the detail that made them feel safe; they were
 * pictures of it doing nothing.
 *
 * `episode` was the one correct capture, and the only one that already asserted its content. So the
 * rule is now general: no screenshot is taken of a surface that has not proven it has something on it.
 */
async function awaitContent(page, { selector, minCount = 1, absent = [], timeout = 45000, what }) {
  try {
    await page.waitForFunction(
      ({ selector, minCount }) => document.querySelectorAll(selector).length >= minCount,
      { selector, minCount },
      { timeout },
    );
  } catch {
    throw new Error(
      `${what}: "${selector}" never reached ${minCount} element(s) within ${timeout}ms — `
      + 'refusing to photograph an empty or still-loading panel',
    );
  }
  // Some surfaces render a placeholder *and* real content in sequence; make sure the placeholder is
  // gone rather than merely outnumbered.
  for (const sel of absent) {
    if (await page.locator(sel).count()) {
      throw new Error(`${what}: the placeholder "${sel}" is still on screen — refusing to ship it`);
    }
  }
}

async function shot(page, name, locator) {
  const target = locator ?? page;
  await target.screenshot({ path: resolve(OUT, `${name}.png`), animations: 'disabled', scale: 'css' });
  console.log(`  ${name}.png`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });

  try {
    console.log(`Capturing from ${URL_BASE} → docs/media/`);

    // 1 — the hero: the whole thread at a glance, river first.
    //
    // Scrolled so the river leads. A demo database has one un-drained reading in it, so the top of the
    // Overview is an "ask for a reading" progress card — honest, and exactly the wrong thing to make
    // the first image a stranger sees. This frames what the tool IS, not what it is waiting to do.
    await openThread(page);
    // The river only exists in the DOM once the metrics have landed; until then the whole panel is
    // the words "Reading the shape of these years…". The shipped hero was a picture of exactly that.
    await awaitContent(page, { selector: '.ov-section--river', what: 'hero-river' });
    await page.evaluate(() => {
      const s = document.querySelector('.overview-scroll');
      const river = document.querySelector('.ov-section--river');
      if (s && river) s.scrollTop = river.getBoundingClientRect().top - s.getBoundingClientRect().top - 16;
    });
    await sleep(500);
    await shot(page, 'hero-river');

    // 2 — the eras: the years, named and bounded.
    await go(page, 'Explore', 'Eras');
    // Named seasons are .era-card. Without this the capture is "Tracing the arc of these years…".
    await awaitContent(page, { selector: '.era-card', what: 'eras' });
    await shot(page, 'eras');

    // 3 — an episode, opened. A hard stretch with its own note, always linking back to the words.
    //
    // The first version of this picked the target with `.filter({ hasText: /·/ })`, which matched a
    // control that navigates to Messages — so the shipped "episode" image was a screenshot of the
    // transcript, captioned in the README as an episode with its note. `shot()` is unconditional, so
    // a re-run reproduced it in silence. Hence the assertion below: a wrong capture now fails the
    // run instead of shipping.
    await go(page, 'Explore', 'Episodes');
    // Generous timeout, deliberately: /episodes takes ~20 seconds on the 787-message demo because it
    // queues behind the other Overview requests on Node's single thread. That is a real performance
    // problem with its own fix — but a capture script that fails on it is measuring the server, not
    // the screenshot.
    await awaitContent(page, { selector: '.ep-list .ep-item', what: 'episode' });
    // No click. An episode row IS the drill-through to the transcript — there is no separate
    // "episode opened" state to photograph, and clicking navigates to Messages. That is what produced
    // the original wrong capture, captioned in the README as something the app does not have.
    await expectVisible(page, page.getByRole('tab', { name: 'Episodes', exact: true }),
      'the Episodes subnav tab should be selected');
    // And that the list is actually THERE. Asserting only "we did not navigate" still permits a
    // screenshot of an empty panel, which is how the first wrong capture got through.
    const items = await page.locator('.ep-item').count();
    if (items === 0) throw new Error('the Episodes list rendered nothing — refusing to ship an empty panel as "an episode"');
    await shot(page, 'episode');

    // 4 — THE picture of the whole discipline: an observation with its receipt open underneath it.
    // gen-demo freezes a First Reflection into the demo database citing two real receipts, so the
    // claim button does exist — but the old `if (await claim.count())` checked for it before the
    // surface had finished loading, found nothing, silently skipped the click, and photographed the
    // "No reading yet" empty state. That shipped, captioned as a claim opened to reveal the message
    // underneath it. Degrading quietly is the failure mode; the guard now refuses instead.
    await go(page, 'Readings', 'A first reading');
    await awaitContent(page, { selector: 'button.receipt-claim', what: 'receipt', timeout: 15000 });
    await page.locator('button.receipt-claim').first().click();
    await sleep(500);
    await shot(page, 'receipt');

    // 5 — an Ask answer, with the messages it drew on.
    // Target the Ask field by its own placeholder: a bare input selector picks up the conversation
    // filter in the sidebar, which silently produces a screenshot of the wrong box entirely.
    await go(page, 'Ask');
    const box = page.getByPlaceholder(/Ask about the years/i);
    await box.fill('kids');
    await page.getByRole('button', { name: /^Ask$/ }).click();
    // Either real answer is worth photographing: receipts, or the honest "doesn't hold enough to
    // answer that honestly" refusal. What is not worth photographing is the spinner in between, which
    // is what shipped — under a caption describing the refusal it had not reached yet.
    await awaitContent(page, {
      selector: 'section[aria-label="Not enough held"], .ask-receipt',
      what: 'ask',
    });
    await sleep(300);
    await shot(page, 'ask');

    // 5b — an Ask answer that ANSWERS, with the receipts under it.
    //
    // Both images are true and the project needs both. The refusal above earned its place and keeps
    // it on the method page, because a tool that declines when the words run out is the whole
    // argument. But it was for a long time the ONLY Ask image, which undersold the instrument: a
    // reader could reasonably conclude Ask never answers anything. It answers plenty — "sorry"
    // returns 29 receipts against the demo archive.
    await box.fill('sorry');
    await page.getByRole('button', { name: /^Ask$/ }).click();
    await awaitContent(page, { selector: '.ask-receipt', what: 'ask-answered' });
    await sleep(300);
    await shot(page, 'ask-answered');

    // 6 — the engine chooser: the honest cost/privacy screen, before any money moves.
    await page.locator('button[aria-label="Settings"]').click();
    await sleep(600);
    await shot(page, 'settings-engine', page.locator('[role="dialog"]'));

    console.log('\nDone. Alex & Jordan only — never a real archive.');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(`\nCapture failed: ${e.message}`);
  console.error(`Is the demo running?  npm run demo:serve   (expected at ${URL_BASE})`);
  process.exit(1);
});
