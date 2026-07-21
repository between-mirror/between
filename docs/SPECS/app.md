# SPEC — App skeleton, API, budgets

## Directory layout

```
between/
  package.json                 workspaces: server, web
  .claude/commands/drain-jobs.md
  prompts/                     versioned prompt templates (data, not code)
  docs/                        this planning corpus
  server/
    src/ingest/                sax parser, normalizers, classifiers, identity, dedup
    src/store/                 schema.sql migrations, better-sqlite3 access layer
    src/metrics/               T1 SQL + moments
    src/airlock/               planner, hashing, ingest-results, ollama adapter, execa spawn
    src/api/                   fastify routes + SSE
    test/fixtures/gen.ts       synthetic archive generator (TESTING §1)
  web/
    src/tokens.css             copied from docs/SPECS/tokens.css — single source
    src/views/                 threshold, overview, river, transcript, evidence, session, drain
    src/components/
  scripts/check-clean.mjs      T-CLEAN privacy linter (pre-commit)
  airlock/                     runtime transport (git-ignored)
  data/                        user drops XML here   (git-ignored)
```

## Config vs personalization

`between.config.json` (tracked): ports, paths, batch sizes, gap thresholds, feature flags. **All personalization** (owner, region, contact types, merges) lives in the DB via onboarding (Addendum B.1/B.3). No personal value may appear in config.

## API sketch (Fastify, localhost only)

```
GET  /api/contacts                      resolved people + coverage + stats
GET  /api/threads/:id/messages          ?from&to&cursor — virtualized transcript
GET  /api/threads/:id/metrics           ?keys&period — T1 series for charts
GET  /api/threads/:id/moments           the Moments shelf
GET  /api/search?q=                     FTS5 across scope
POST /api/contacts/:id                  relationship_type, deceased, merges (re-propagates)
POST /api/analyze                       {thread_id, range, lens} → plan → {estimate, job_count}  (dry-run first)
POST /api/analyze/confirm               materialize jobs after the estimate is shown
POST /api/drain                         spawn engine via execa (claude | ollama); awaited
GET  /api/drain/stream                  SSE: job states, ETA, capacity note  (persistent surface, §5.1)
GET  /api/results/:thread_id            scored series + claims for rendering
GET  /api/evidence/:claim_ref           messages + spans + rationale for the Evidence Panel
POST /api/overrides                     "I disagree" → suppress/correct + re-propagate
GET/POST /api/events                    life-event markers
GET  /api/reflections/:thread_id        frozen prose, newest first
```

## Performance budgets (asserted in tests where feasible)

| Surface | Budget |
|---|---|
| Ingest a large real archive (200 MB+) | ≤ 5 min, peak RSS < 600 MB |
| App cold start → Threshold | < 2 s |
| Open a 100k-message thread | < 150 ms to first bubbles (virtualized) |
| River first paint (8.5 y) | < 2 s; pan/zoom ≥ 45 fps (viewport-driven data) |
| FTS query | < 200 ms |
| Full T1 recompute | < 30 s, non-blocking (UI stays live) |

## Windows notes (day-one, GAMEPLAN §7.1/§4.6)

`execa` for every spawn (`claude` is a `.cmd` shim; args arrays, never string concat) · `path.join` everywhere (the project path contains a space) · airlock + DB on local non-synced disk · offer the Defender exclusion during onboarding · pin prebuilt `better-sqlite3` · long-path awareness.

## Definition of done, per feature

Typed end-to-end · tests in the phase matrix green · voice strings from VOICE.md verbatim (T-VOICE) · both themes · keyboard path + reduced-motion · coverage/capacity honesty surfaces present where applicable · zero personal data (T-CLEAN).
