# Support

## If you are in crisis, this is the wrong place

**Between Mirror is not a crisis service, a counselling service, or a therapist, and nobody is
monitoring this repository for people in distress.** Issues here may go unanswered for days.

If you are thinking about harming yourself, or you are not safe where you are, please talk to a
person now:

- **United States:** call or text **988** (Suicide & Crisis Lifeline), or chat at
  [988lifeline.org](https://988lifeline.org). For abuse: **1-800-799-7233** (National Domestic
  Violence Hotline), or text START to 88788.
- **United Kingdom & Ireland:** call **116 123** (Samaritans).
- **Elsewhere:** [findahelpline.com](https://findahelpline.com) lists free, confidential lines by
  country.
- **If it is urgent, contact your local emergency services.**

This tool can show you what was said. It cannot tell you what to do, and it should not be the thing
you are alone with on a hard night. That is not a limitation we plan to fix — it is what the tool is.

---

## Where to take everything else

| What | Where |
|---|---|
| **A bug** — something is broken, wrong, or crashes | [Open an issue](https://github.com/between-mirror/between/issues) |
| **A security or privacy vulnerability** | **Not an issue.** [Open a security advisory](https://github.com/between-mirror/between/security/advisories/new) — see [SECURITY.md](SECURITY.md) |
| **A question about what the tool does or doesn't do** | [Discussions](https://github.com/between-mirror/between/discussions) |
| **A feature idea** | Check [docs/ROADMAP.md](docs/ROADMAP.md) first — there is a permanent "not planned" list — then Discussions |
| **"Is my data safe?"** | [docs/PRIVACY-INVARIANTS.md](docs/PRIVACY-INVARIANTS.md) and [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md), which is honest about what local-first does *not* protect against |
| **"Does it do X yet?"** | [docs/STATUS.md](docs/STATUS.md) — the single authoritative answer. When the README and STATUS disagree, STATUS wins |

## Filing a good bug report

Please include:

- What you expected, and what happened instead.
- Your OS and `node --version` (Node 22+ required; on Windows Node 20 cannot install the native
  database module at all).
- The exact command or the screen you were on.
- Any error text — from the terminal, or the browser console.

**Please do not paste your own messages.** Not a line, not a screenshot with a name visible, not "just
for context". If a bug only reproduces with certain message content, describe the *shape* of it
("a message with an emoji-only body", "an MMS with no text part") and we will build a synthetic
fixture. Reproducing on the fictional demo (`npm run demo:serve`) is ideal.

There is no telemetry, so nothing is reported automatically — a bug nobody files is a bug nobody
knows about.

## What support is, honestly

This is a small project. There is no support team and no response-time guarantee. Triage runs roughly
weekly, in these lanes ([docs/OPERATIONS.md](docs/OPERATIONS.md) has the detail):

- **Security** — acknowledged within 48 hours, fixed and released as a patch.
- **Correctness** — anything producing a wrong reading, or touching the evidence chain, goes in the
  next patch release.
- **Everything else** — batched.

Paid setup support (30 days of it) comes with the Official Desktop edition when that ships. The
source, and everything the source can do, stays free either way.
