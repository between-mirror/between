-- Between — canonical SQLite schema (WAL). The app is the SOLE writer.
-- Personalization lives HERE, never in code (Addendum B.1).
-- Raw values are kept alongside normalized ones so identity/threading can be re-derived.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── People ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contacts (
  id                INTEGER PRIMARY KEY,
  display_name      TEXT,
  primary_e164      TEXT,
  is_owner          INTEGER NOT NULL DEFAULT 0,          -- exactly one row = 1
  relationship_type TEXT NOT NULL DEFAULT 'unknown'
                    CHECK (relationship_type IN ('partner','family','parent_child','friend','coworker','unknown')),
  is_deceased       INTEGER NOT NULL DEFAULT 0,          -- grief mode (GAMEPLAN §6)
  deceased_since    TEXT,                                 -- ISO date, nullable
  notes             TEXT
);

CREATE TABLE IF NOT EXISTS identifiers (                                -- many numbers → one person
  id                 INTEGER PRIMARY KEY,
  contact_id         INTEGER NOT NULL REFERENCES contacts(id),
  raw_value          TEXT NOT NULL,
  normalized_e164    TEXT,                                -- NULL for shortcodes/email
  kind               TEXT NOT NULL DEFAULT 'mobile' CHECK (kind IN ('mobile','shortcode','email','alias')),
  source_contact_name TEXT,                               -- backup-time label, display hint only
  first_seen_ms      INTEGER,
  last_seen_ms       INTEGER,
  UNIQUE (raw_value)
);
CREATE INDEX IF NOT EXISTS idx_identifiers_e164 ON identifiers(normalized_e164);

-- ── Conversations ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS threads (
  id                    INTEGER PRIMARY KEY,
  participant_signature TEXT NOT NULL UNIQUE,             -- sorted hash of non-owner contact ids
  is_group              INTEGER NOT NULL DEFAULT 0,
  title                 TEXT,
  coverage_confidence   REAL NOT NULL DEFAULT 1.0,        -- 0..1 (GAMEPLAN §2.1a)
  coverage_note         TEXT,
  primary_lang          TEXT,
  first_ms              INTEGER, last_ms INTEGER, message_count INTEGER
);

CREATE TABLE IF NOT EXISTS thread_participants (
  thread_id  INTEGER NOT NULL REFERENCES threads(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  PRIMARY KEY (thread_id, contact_id)
);

-- ── Messages (unified SMS + MMS) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id                INTEGER PRIMARY KEY,
  thread_id         INTEGER NOT NULL REFERENCES threads(id),
  sender_contact_id INTEGER REFERENCES contacts(id),
  direction         TEXT NOT NULL CHECK (direction IN ('incoming','outgoing','draft','other')),
  kind              TEXT NOT NULL CHECK (kind IN ('sms','mms')),
  sent_at_ms        INTEGER NOT NULL,                     -- epoch ms UTC; primary sort key
  body_text         TEXT,                                 -- MMS: ordered concat of text/plain parts
  is_read           INTEGER,
  is_reaction       INTEGER NOT NULL DEFAULT 0,           -- tapback; excluded from metrics
  reaction_kind     TEXT,                                 -- liked|loved|emphasized|laughed|disliked|questioned
  lang              TEXT,                                 -- per-message detected language
  raw_type          INTEGER,                              -- sms @type as-is
  raw_msg_box       INTEGER,                              -- mms @msg_box as-is
  source_file_id    INTEGER NOT NULL REFERENCES source_files(id),
  source_kind       TEXT NOT NULL                         -- denormalized from source_files.kind
                    CHECK (source_kind IN ('android_smsbackup','whatsapp_txt','imessage_chatdb',
                                           'imessage_backup','generic_jsonl','unknown')),
  dedup_key         TEXT NOT NULL UNIQUE                  -- ingest/dedup.ts; upsert-ignore on conflict
);
CREATE INDEX IF NOT EXISTS idx_messages_thread_time ON messages(thread_id, sent_at_ms);
CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(sent_at_ms);

CREATE TABLE IF NOT EXISTS message_recipients (                          -- group MMS addr roles
  message_id INTEGER NOT NULL REFERENCES messages(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  addr_role  TEXT NOT NULL CHECK (addr_role IN ('from','to','cc','bcc')),
  PRIMARY KEY (message_id, contact_id, addr_role)
);

CREATE TABLE IF NOT EXISTS attachments (                                 -- METADATA ONLY; bytes discarded at parse
  id          INTEGER PRIMARY KEY,
  message_id  INTEGER NOT NULL REFERENCES messages(id),
  mime_type   TEXT NOT NULL,
  filename    TEXT,
  size_bytes  INTEGER,
  sha256      TEXT,                                        -- dedup without storing bytes
  is_smil     INTEGER NOT NULL DEFAULT 0,
  blob_ref    TEXT                                         -- NULL unless user explicitly opted this item in
);

CREATE TABLE IF NOT EXISTS source_files (
  id             INTEGER PRIMARY KEY,
  path           TEXT NOT NULL,
  content_sha256 TEXT NOT NULL UNIQUE,                     -- re-import skip (T0.9)
  imported_at    TEXT NOT NULL,
  record_count   INTEGER,
  -- No DEFAULT on purpose: an import that cannot name its own format is a bug, and this column is
  -- what the archive-health surface reports. 'unknown' is reachable only by migration.
  kind           TEXT NOT NULL
                 CHECK (kind IN ('android_smsbackup','whatsapp_txt','imessage_chatdb',
                                 'imessage_backup','generic_jsonl','unknown'))
);

-- ── Full-text search ──────────────────────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  body_text, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);

-- ── User layer: events, overrides, reflections ────────────────────────────
CREATE TABLE IF NOT EXISTS events (                                      -- life-event markers (T3 overlay)
  id          INTEGER PRIMARY KEY,
  contact_id  INTEGER REFERENCES contacts(id),             -- NULL = global
  label       TEXT NOT NULL,
  happened_on TEXT NOT NULL,                               -- ISO date
  note        TEXT,
  source      TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','auto')),
  accepted    INTEGER NOT NULL DEFAULT 1                   -- auto-detected await accept
);

CREATE TABLE IF NOT EXISTS overrides (                                   -- "I disagree" — feeds reduce/render (§5.3)
  id          INTEGER PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('claim','message','merge')),
  target_ref  TEXT NOT NULL,                               -- claim hash / message id / merge pair
  action      TEXT NOT NULL CHECK (action IN ('suppress','correct')),
  note        TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reflections (                                 -- frozen, versioned prose (§5.4, A.1)
  id             INTEGER PRIMARY KEY,
  thread_id      INTEGER NOT NULL REFERENCES threads(id),
  lens           TEXT NOT NULL,                            -- first_reflection | letter | era_summary ...
  range_start_ms INTEGER NOT NULL,
  range_end_ms   INTEGER NOT NULL,
  content_md     TEXT NOT NULL,
  evidence_json  TEXT NOT NULL,                            -- claim → evidence_ids map
  prompt_version INTEGER NOT NULL,
  model_note     TEXT,
  generated_at   TEXT NOT NULL                             -- immutable; regeneration inserts a new row
);

-- ── Analysis pipeline (GAMEPLAN §4) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS analysis_jobs (
  id             TEXT PRIMARY KEY,                         -- 'job_' + base32(input_hash)[:16]
  input_hash     TEXT NOT NULL,
  lens           TEXT NOT NULL,                            -- l1_emotion | first_reflection_reduce | ...
  kind           TEXT NOT NULL CHECK (kind IN ('map','reduce','single','render')),
  engine_hint    TEXT NOT NULL DEFAULT 'claude' CHECK (engine_hint IN ('local','claude','render')),
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','claimed','running','done','error','skipped','refused')),
  priority       INTEGER NOT NULL DEFAULT 0,
  chunk_ref      TEXT NOT NULL,                            -- JSON {thread_id,start_msg_id,end_msg_id,overlap_prefix_ids}
  prompt_id      TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  created_at     TEXT NOT NULL, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON analysis_jobs(status, priority DESC);

CREATE TABLE IF NOT EXISTS analysis_results (
  input_hash   TEXT PRIMARY KEY,                           -- the idempotency key (§4.2)
  job_id       TEXT NOT NULL,
  lens         TEXT NOT NULL,
  result_json  TEXT NOT NULL,                              -- schema-validated payload
  validation_json TEXT,                                    -- {schema_ok, retries}
  refusal_json TEXT,                                       -- {detected, reason}
  model_note   TEXT,
  sample_count INTEGER NOT NULL DEFAULT 1,                 -- sample-and-agree draws
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prefilter (                                   -- cheap routing scores (§4.4)
  chunk_hash  TEXT PRIMARY KEY,
  thread_id   INTEGER NOT NULL,
  scores_json TEXT NOT NULL,                               -- lexicon/caps/hostility/etc
  worth_llm   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS metrics (                                     -- precomputed T1 (§2.3 stage 8)
  thread_id       INTEGER NOT NULL,
  metric_key      TEXT NOT NULL,
  period          TEXT NOT NULL CHECK (period IN ('day','week','month','all')),
  period_start_ms INTEGER NOT NULL DEFAULT 0,
  value_json      TEXT NOT NULL,
  PRIMARY KEY (thread_id, metric_key, period, period_start_ms)
);

-- ── Conflict episodes (L7 — the derived keystone every higher lens consumes) ─
-- Deterministic clustering of per-message L1 tension (lenses/episodes.ts); no model output lands
-- here except narrative_json, which the worthwhile tier fills lazily and refresh must PRESERVE.
-- Natural key (thread_id, start_msg_id) keeps episode identity stable across recomputes.
CREATE TABLE IF NOT EXISTS episodes (
  id             INTEGER PRIMARY KEY,
  thread_id      INTEGER NOT NULL REFERENCES threads(id),
  start_msg_id   INTEGER NOT NULL,                        -- first hostile message
  end_msg_id     INTEGER NOT NULL,                        -- last hostile message
  start_ms       INTEGER NOT NULL,
  end_ms         INTEGER NOT NULL,
  msg_count      INTEGER NOT NULL,                        -- ALL substantive msgs inside the span
  hostile_me     INTEGER NOT NULL,
  hostile_them   INTEGER NOT NULL,
  severe_me      INTEGER NOT NULL,
  severe_them    INTEGER NOT NULL,
  initiator      TEXT NOT NULL CHECK (initiator IN ('me','them')),
  last_hostile   TEXT NOT NULL CHECK (last_hostile IN ('me','them')),
  peak_tension   REAL NOT NULL,
  kid_named      INTEGER NOT NULL DEFAULT 0,              -- kid named in span ±1h (names live in app_meta, never code)
  repaired_at_ms INTEGER,                                 -- first warmth≥2 within 24h after end; NULL = no repair seen
  repaired_by    TEXT CHECK (repaired_by IN ('me','them')),
  narrative_json TEXT,                                    -- worthwhile-tier narration (title/arc/receipts); preserved on refresh
  computed_at    TEXT NOT NULL,
  UNIQUE (thread_id, start_msg_id)
);
CREATE INDEX IF NOT EXISTS idx_episodes_thread_time ON episodes(thread_id, start_ms);

CREATE TABLE IF NOT EXISTS app_meta ( key TEXT PRIMARY KEY, value TEXT ); -- schema_version, region, onboarding state
