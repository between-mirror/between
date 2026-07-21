# Contributing to Between Mirror

Thank you for looking. Before anything else, the one thing that makes this project different from
most: **this software reads the most sensitive data a consumer application can hold.** Years of two
people's private messages. Every rule below exists because of that, and none of them is style
preference.

Please also read [TRADEMARK.md](TRADEMARK.md) (you may fork freely; the *name* is the one thing
reserved) and [docs/PRIVACY-INVARIANTS.md](docs/PRIVACY-INVARIANTS.md).

---

## Before you write code

**Open an issue first for anything non-trivial.** Not bureaucracy — this project has strong opinions
about what it will and won't do ([docs/ROADMAP.md](docs/ROADMAP.md) has a "not planned" list that is
genuinely permanent), and it would be a waste of your evening to build something that gets declined
on principle. Small fixes: just send them.

**One caveat, stated plainly:** the contributor-rights question (CLA vs AGPL-only) is not yet decided,
so **substantial external code cannot be merged yet**. Bug fixes, tests, and documentation are fine
now. If you are about to spend real time on a feature, ask first — this is disclosed up front rather
than after you have done the work.

## Development setup

```bash
# Node 22 or newer. Node 20 is NOT enough on Windows: better-sqlite3 publishes no prebuilt
# binary for it there, so installing would need a full MSVC toolchain. (Node 20 is also EOL.)
git clone https://github.com/between-mirror/between.git
cd between
npm ci
npm run typecheck
npm test

# Try it on the fictional couple — never on a real archive you don't own:
npm run demo && npm run demo:serve      # → http://localhost:5273
```

CI runs typecheck + the full suite on **ubuntu-latest and windows-latest, Node 22 and 24**. All four
are required. Windows is a first-class target, not a courtesy.

## The workflow: failing test first

Every behavioural change starts with a test that fails for the right reason, then the change that
makes it pass. This is not a preference; it is how this codebase distinguishes a claim from an
enforcement. A promise with no test behind it is a promise the next refactor will quietly break — and
several of the defects fixed in v0.2.x were exactly that.

Concretely:

1. Write the failing test. Run it. **Read the failure** and confirm it fails for the reason you think.
2. Make it pass.
3. `npm run typecheck && npm test` — both green, whole suite, before you commit.
4. Commit with a message that says what was wrong and why it mattered, not just what changed.

If a test is hard to write, that is usually information about the design, not about testing.

## The privacy invariants are PR-blocking

These are not guidelines. A pull request that weakens any of them will be declined regardless of how
good the rest of it is. From [docs/PRIVACY-INVARIANTS.md](docs/PRIVACY-INVARIANTS.md):

- **Loopback only.** The server refuses to boot on a non-loopback host. There is a build-blocking test.
- **No telemetry. Ever.** No analytics, no crash reporting, no "anonymous usage statistics", nothing
  reported about a person, their archive, or their use of the program. Not opt-in, not opt-out —
  absent. Adding a dependency that does any of this counts. The identifier-free update check the
  installer will carry (one static manifest, same file for everybody, switchable off) is the single
  sanctioned request the app may ever make on its own; anything that would attach an identity to it is
  this invariant breaking. It does not exist yet: today the app makes no request *of its own* at all —
  the three egress paths below are all owner-initiated.
- **Three disclosed egress paths, and no fourth.** Local model, Claude subscription, Anthropic API —
  each chosen explicitly by the owner, each visible before it runs.
- **No claim without receipts.** Every model-authored proposition carries evidence ids that must
  resolve to real messages, or the claim is dropped. Connective prose is app-authored from fixed
  templates precisely so that nothing unreceipted can be generated.
- **No hosting anyone's archive.** Not as a feature, not as a debugging convenience, not "just for the
  demo".

If you think an invariant is wrong, that is a conversation worth having in an issue — but it is a
conversation, not a patch.

## Never put personal data in fixtures. Ever.

**All test data is synthetic.** Every fixture, every example, every screenshot. No exceptions, and no
"I anonymised it" — anonymised message data is still someone's message data, and re-identification of
conversational text is easier than people think.

- Use `server/test/fixtures/gen.ts` or hand-build a `ResolvedGraph` (see any existing test).
- The demo couple, **Alex & Jordan**, is fictional and generated deterministically by
  `server/src/cli/gen-demo.ts`. They are the only people who appear in screenshots, docs, and
  marketing — permanently.
- Phone numbers: `+1555555xxxx`. Names: invented.
- The author's own archive is user zero and is **never** the demo, the screenshot, or the case study.

A PR containing real message content will be closed, not fixed up.

## Voice and design tokens

Human-facing copy is **data, not code**. [docs/VOICE.md](docs/VOICE.md) is the source of truth: the
register, the ban list, and verbatim microcopy. Do not paraphrase it, and do not invent voice — if
something you need is missing, say so in the issue and it gets authored there first.

The short version of the register: precise about observation, tentative about interpretation. Never
diagnose a person. Never predict. Never adjudicate. No exclamation marks in reflective prose.

Colour: **amber, slate, clay — never red or green.** A relationship is not a build status. Use the
tokens in `docs/SPECS/tokens.css`; don't hardcode hex.

## Sign your commits off (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/). Add a
sign-off line to each commit:

```
git commit -s -m "your message"
```

which appends `Signed-off-by: Your Name <your@email.com>`. That line means you wrote the patch, or
otherwise have the right to submit it under the project's licence. There is no CLA — see the caveat
at the top about what that currently means for large contributions.

## Pull request checklist

- [ ] A failing test came first, and it now passes.
- [ ] `npm run typecheck && npm test` are green on the whole suite.
- [ ] No real personal data anywhere — fixtures, examples, screenshots, commit messages.
- [ ] No new privacy invariant weakened; no telemetry-capable dependency added.
- [ ] Copy matches VOICE; colours come from the tokens.
- [ ] Commits are signed off (`-s`).
- [ ] The message explains *why*, not only *what*.

## Security issues

Please do **not** open a public issue. See [SECURITY.md](SECURITY.md) — use a GitHub security
advisory so a fix can ship before the details are public.

## A note on tone

Code review here is about the work. If a review comment reads as harsh, assume brevity rather than
contempt, and say so — that is a fair thing to push back on. See
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
