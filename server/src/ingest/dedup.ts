// Deterministic dedup key (GAMEPLAN §2.2). Users produce many overlapping backups; the
// key is the convergence anchor enforced by messages.dedup_key UNIQUE (upsert-ignore).
//   SMS: hash(normalized_address-or-raw, sentAtMs, rawType, bodyText)
//   MMS: prefer m_id  → hash("mms", m_id)
//        else          → hash(msg_box, sentAtMs, sortedParticipantE164s, bodyText, partCount)
// Stable ordering, stable serialization: identical logical messages → identical key across runs.
import { createHash } from 'node:crypto';
import type { NormalizedMessage } from '../types';

// JSON.stringify gives an unambiguous, order-fixed, null-distinct serialization; numbers and
// strings never collide, and no delimiter can be forged from body text.
function sha256(parts: Array<string | number | null>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function computeDedupKey(m: NormalizedMessage): string {
  if (m.kind === 'mms') {
    if (m.mmsMId) return sha256(['mms', m.mmsMId]);
    // No m_id: fall back to the structural signature. Participants normalized + sorted so a
    // reordered <addrs> block still dedups; raw kept when e164 is unresolvable (shortcodes).
    const participants = m.addresses
      .map((a) => a.e164 ?? a.raw)
      .filter((v): v is string => v != null && v !== '')
      .sort();
    return sha256([m.rawMsgBox, m.sentAtMs, participants.join(','), m.bodyText, m.partCount]);
  }
  // SMS: single counterparty address; prefer its e164, fall back to the raw string.
  const a = m.addresses[0];
  const addrKey = a ? (a.e164 ?? a.raw) : '';
  return sha256([addrKey, m.sentAtMs, m.rawType, m.bodyText]);
}
