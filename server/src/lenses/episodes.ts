// Between — L7 conflict-episode layer (the keystone: every higher lens, surface, and export
// consumes these). Deterministic: clusters per-message L1 tension into episodes — no model calls.
// Additive module in the l1.ts mold: reuses emotionByMessage() and writes ONLY the episodes table
// (the app is the sole SQLite writer). Reactions never enter this lens.
//
// Definitions (thresholds calibrated against the 50-item hold-out, data/holdout-labels.json:
// tension≥2 ≈ 82% precision / 90% recall, and catches 100% of user-labeled harsh+cruel):
//   hostile  = avg tension ≥ HOSTILE_TENSION
//   severe   = avg tension ≥ SEVERE_TENSION
//   episode  = ≥ MIN_HOSTILE hostile msgs, ≤ GAP_MS between consecutive hostile msgs
//   repair   = first warmth ≥ WARM_WARMTH message (either side) within REPAIR_WINDOW_MS after the
//              last hostile message — the fast turn of the cycle (observed median ≈ 1 day)
//   kid_named = a configured kid name appears within the span ±KID_PROXIMITY_MS. Names are
//              personalization and live in app_meta ('kid_names', JSON array) — NEVER in code.
import type { BetweenDB } from '../store/db';
import { emotionByMessage } from './l1';
import { DEFAULT_CALIBRATION, calibrationFor, type Calibration } from './calibration';

// Shipped defaults, re-exported for back-compat. The LIVE values are per-owner (app_meta 'calibration',
// see calibration.ts): computeEpisodes reads the owner's calibration; clusterEpisodes takes it explicitly
// (defaulting to these) so the pure clustering stays unit-testable with fixed thresholds.
export const HOSTILE_TENSION = DEFAULT_CALIBRATION.hostileTension;
export const SEVERE_TENSION = DEFAULT_CALIBRATION.severeTension;
export const WARM_WARMTH = DEFAULT_CALIBRATION.warmWarmth;
export const GAP_MS = DEFAULT_CALIBRATION.gapMs;
export const MIN_HOSTILE = DEFAULT_CALIBRATION.minHostile;
export const REPAIR_WINDOW_MS = DEFAULT_CALIBRATION.repairWindowMs;
export const KID_PROXIMITY_MS = DEFAULT_CALIBRATION.kidProximityMs;

/** One substantive message, scored and flagged — the pure clustering input. */
export interface EpisodeMsg {
  id: number;
  ms: number;
  me: boolean;
  tension: number; // avg across the L1 windows that scored it (0 when unscored)
  warmth: number;
  kid: boolean;    // body mentions a configured kid name
}

export interface Episode {
  startMsgId: number;
  endMsgId: number;
  startMs: number;
  endMs: number;
  msgCount: number;      // ALL substantive messages inside [startMs, endMs]
  hostileMe: number;
  hostileThem: number;
  severeMe: number;
  severeThem: number;
  initiator: 'me' | 'them';
  lastHostile: 'me' | 'them';
  peakTension: number;
  kidNamed: boolean;
  repairedAtMs: number | null;
  repairedBy: 'me' | 'them' | null;
}

/** Episode row as stored (adds identity + any worthwhile-tier narration). */
export interface EpisodeRow extends Episode {
  id: number;
  threadId: number;
  narrative: unknown | null;
}

/**
 * Pure clustering over time-ordered messages. Hostile messages cluster while consecutive gaps stay
 * ≤ GAP_MS; clusters under MIN_HOSTILE are spats, not episodes. Span stats (msg_count, kid, repair)
 * come from the FULL message list so quiet messages inside a fight still count.
 */
export function clusterEpisodes(msgs: EpisodeMsg[], cal: Calibration = DEFAULT_CALIBRATION): Episode[] {
  const episodes: Episode[] = [];
  let cluster: number[] = []; // indexes into msgs of hostile members

  const flush = () => {
    if (cluster.length >= cal.minHostile) episodes.push(buildEpisode(msgs, cluster, cal));
    cluster = [];
  };

  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].tension < cal.hostileTension) continue;
    if (cluster.length && msgs[i].ms - msgs[cluster[cluster.length - 1]].ms > cal.gapMs) flush();
    cluster.push(i);
  }
  flush();
  return episodes;
}

function buildEpisode(msgs: EpisodeMsg[], cluster: number[], cal: Calibration): Episode {
  const firstIdx = cluster[0];
  const lastIdx = cluster[cluster.length - 1];
  const first = msgs[firstIdx];
  const last = msgs[lastIdx];

  let hostileMe = 0, hostileThem = 0, severeMe = 0, severeThem = 0, peak = 0;
  for (const i of cluster) {
    const m = msgs[i];
    if (m.me) hostileMe++; else hostileThem++;
    if (m.tension >= cal.severeTension) { if (m.me) severeMe++; else severeThem++; }
    if (m.tension > peak) peak = m.tension;
  }

  // Kid proximity: any kid-naming message inside the span ±KID_PROXIMITY_MS (local scans out from
  // the span edges; the array is time-ordered).
  let kidNamed = false;
  for (let i = firstIdx; i <= lastIdx && !kidNamed; i++) kidNamed = msgs[i].kid;
  for (let i = firstIdx - 1; i >= 0 && msgs[i].ms >= first.ms - cal.kidProximityMs && !kidNamed; i--) {
    kidNamed = msgs[i].kid;
  }
  for (let i = lastIdx + 1; i < msgs.length && msgs[i].ms <= last.ms + cal.kidProximityMs && !kidNamed; i++) {
    kidNamed = msgs[i].kid;
  }

  // Repair: first warm message (either side) inside the window after the last hostile one.
  let repairedAtMs: number | null = null;
  let repairedBy: 'me' | 'them' | null = null;
  for (let i = lastIdx + 1; i < msgs.length && msgs[i].ms <= last.ms + cal.repairWindowMs; i++) {
    if (msgs[i].warmth >= cal.warmWarmth) {
      repairedAtMs = msgs[i].ms;
      repairedBy = msgs[i].me ? 'me' : 'them';
      break;
    }
  }

  return {
    startMsgId: first.id,
    endMsgId: last.id,
    startMs: first.ms,
    endMs: last.ms,
    msgCount: lastIdx - firstIdx + 1,
    hostileMe, hostileThem, severeMe, severeThem,
    initiator: first.me ? 'me' : 'them',
    lastHostile: last.me ? 'me' : 'them',
    peakTension: peak,
    kidNamed,
    repairedAtMs, repairedBy,
  };
}

/** Compile the kid-name matcher from app_meta 'kid_names' (JSON array). Null when unconfigured —
 *  kid_named then stays 0 everywhere and the kids lens reports itself unconfigured. */
export function kidNameMatcher(db: BetweenDB): RegExp | null {
  const raw = db.getMeta('kid_names');
  if (!raw) return null;
  let names: unknown;
  try { names = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(names)) return null;
  const parts = names
    .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
    .map((n) => n.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!parts.length) return null;
  return new RegExp(`\\b(${parts.join('|')})\\b`, 'i');
}

/** Load a thread's substantive messages joined to their averaged L1 scores (pure read). */
export function loadEpisodeMsgs(db: BetweenDB, threadId: number): EpisodeMsg[] {
  const scores = emotionByMessage(db, threadId);
  const kidRe = kidNameMatcher(db);
  const rows = db.raw
    .prepare(
      `SELECT id, sent_at_ms AS ms, direction AS dir, body_text AS body
         FROM messages
        WHERE thread_id = ? AND is_reaction = 0 AND trim(coalesce(body_text,'')) != ''
        ORDER BY sent_at_ms ASC, id ASC`,
    )
    .all(threadId) as { id: number; ms: number; dir: string; body: string }[];
  return rows.map((r) => {
    const s = scores.get(r.id);
    return {
      id: r.id,
      ms: r.ms,
      me: r.dir === 'outgoing' || r.dir === 'draft',
      tension: s?.tension ?? 0,
      warmth: s?.warmth ?? 0,
      kid: kidRe ? kidRe.test(r.body) : false,
    };
  });
}

/** Compute a thread's episodes (pure; no writes). */
export function computeEpisodes(db: BetweenDB, threadId: number): Episode[] {
  return clusterEpisodes(loadEpisodeMsgs(db, threadId), calibrationFor(db));
}

export interface RefreshEpisodesSummary { total: number; inserted: number; updated: number; removed: number }

/**
 * Compute + upsert a thread's episodes. Keyed by (thread_id, start_msg_id) so identity survives
 * recomputation; narrative_json is deliberately NOT touched by updates (worthwhile-tier work is
 * never clobbered by a deterministic refresh). Episodes that no longer exist are removed.
 */
export function refreshEpisodes(db: BetweenDB, threadId: number): RefreshEpisodesSummary {
  const episodes = computeEpisodes(db, threadId);
  const now = new Date().toISOString();

  const upsert = db.raw.prepare(
    `INSERT INTO episodes (thread_id, start_msg_id, end_msg_id, start_ms, end_ms, msg_count,
       hostile_me, hostile_them, severe_me, severe_them, initiator, last_hostile, peak_tension,
       kid_named, repaired_at_ms, repaired_by, computed_at)
     VALUES (@threadId, @startMsgId, @endMsgId, @startMs, @endMs, @msgCount,
       @hostileMe, @hostileThem, @severeMe, @severeThem, @initiator, @lastHostile, @peakTension,
       @kidNamed, @repairedAtMs, @repairedBy, @now)
     ON CONFLICT (thread_id, start_msg_id) DO UPDATE SET
       end_msg_id = excluded.end_msg_id, start_ms = excluded.start_ms, end_ms = excluded.end_ms,
       msg_count = excluded.msg_count, hostile_me = excluded.hostile_me,
       hostile_them = excluded.hostile_them, severe_me = excluded.severe_me,
       severe_them = excluded.severe_them, initiator = excluded.initiator,
       last_hostile = excluded.last_hostile, peak_tension = excluded.peak_tension,
       kid_named = excluded.kid_named, repaired_at_ms = excluded.repaired_at_ms,
       repaired_by = excluded.repaired_by, computed_at = excluded.computed_at`,
  );
  const delStmt = db.raw.prepare('DELETE FROM episodes WHERE thread_id = ? AND start_msg_id = ?');

  const summary = db.raw.transaction((): RefreshEpisodesSummary => {
    const existing = new Set(
      (db.raw.prepare('SELECT start_msg_id AS s FROM episodes WHERE thread_id = ?').all(threadId) as
        { s: number }[]).map((r) => r.s),
    );
    let inserted = 0, updated = 0;
    const kept = new Set<number>();
    for (const e of episodes) {
      kept.add(e.startMsgId);
      if (existing.has(e.startMsgId)) updated++; else inserted++;
      upsert.run({
        threadId,
        startMsgId: e.startMsgId, endMsgId: e.endMsgId, startMs: e.startMs, endMs: e.endMs,
        msgCount: e.msgCount, hostileMe: e.hostileMe, hostileThem: e.hostileThem,
        severeMe: e.severeMe, severeThem: e.severeThem, initiator: e.initiator,
        lastHostile: e.lastHostile, peakTension: e.peakTension, kidNamed: e.kidNamed ? 1 : 0,
        repairedAtMs: e.repairedAtMs, repairedBy: e.repairedBy, now,
      });
    }
    let removed = 0;
    for (const s of existing) {
      if (!kept.has(s)) { delStmt.run(threadId, s); removed++; }
    }
    return { total: episodes.length, inserted, updated, removed };
  })();
  return summary;
}

function rowToEpisode(r: Record<string, unknown>): EpisodeRow {
  let narrative: unknown | null = null;
  if (typeof r.narrative_json === 'string') {
    try { narrative = JSON.parse(r.narrative_json); } catch { narrative = null; }
  }
  return {
    id: r.id as number,
    threadId: r.thread_id as number,
    startMsgId: r.start_msg_id as number,
    endMsgId: r.end_msg_id as number,
    startMs: r.start_ms as number,
    endMs: r.end_ms as number,
    msgCount: r.msg_count as number,
    hostileMe: r.hostile_me as number,
    hostileThem: r.hostile_them as number,
    severeMe: r.severe_me as number,
    severeThem: r.severe_them as number,
    initiator: r.initiator as 'me' | 'them',
    lastHostile: r.last_hostile as 'me' | 'them',
    peakTension: r.peak_tension as number,
    kidNamed: !!r.kid_named,
    repairedAtMs: (r.repaired_at_ms as number | null) ?? null,
    repairedBy: (r.repaired_by as 'me' | 'them' | null) ?? null,
    narrative,
  };
}

/** Read a thread's stored episodes, time-ascending. */
export function getEpisodes(db: BetweenDB, threadId: number): EpisodeRow[] {
  const rows = db.raw
    .prepare('SELECT * FROM episodes WHERE thread_id = ? ORDER BY start_ms ASC, start_msg_id ASC')
    .all(threadId) as Record<string, unknown>[];
  return rows.map(rowToEpisode);
}

/** Read one episode by its row id (null when absent). */
export function getEpisodeById(db: BetweenDB, episodeId: number): EpisodeRow | null {
  const r = db.raw.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId) as Record<string, unknown> | undefined;
  return r ? rowToEpisode(r) : null;
}

/** Persist a validated narration for one episode (worthwhile-tier; survives deterministic refreshes). */
export function setEpisodeNarrative(db: BetweenDB, episodeId: number, narrative: unknown): void {
  db.raw.prepare('UPDATE episodes SET narrative_json = ? WHERE id = ?').run(JSON.stringify(narrative), episodeId);
}
