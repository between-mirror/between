// The canonical dedup key (SPEC-imports §1). Enforced by messages.dedup_key UNIQUE (upsert-ignore),
// so this function alone decides what counts as "the same message".
//
//   sha256(counterpart · direction · floor(sent_at, 60s) · sha256(normalized body) · occurrence)
//
// It has to do two opposite things at once, and the tension between them is the whole design.
//
// CONVERGE. The same message seen twice must produce one key — across two overlapping backups of the
// same phone, and across two formats that recorded it differently. The old key could not do the
// second: it hashed `raw_type` (an Android SMS type code) and an exact millisecond. A WhatsApp
// export carries neither — its timestamps are minute-precision, because that is all the export
// prints — so the same conversation imported from both sources shared no key component and silently
// doubled. Hence: a 60-second bucket, and no source-native field anywhere in the key.
//
// DO NOT CONVERGE. Saying "ok" twice inside one minute is two messages. Counterpart + minute + body
// cannot tell those apart, and a key that merged them would be eating real messages — the failure
// mode nothing else in the suite would catch, because the archive would simply be slightly smaller
// than the life it came from.
//
// The occurrence index resolves it. Within one (counterpart, direction, minute, body) group, the
// messages are numbered — and what they are numbered by is the part that took two attempts to get
// right. Numbering by arrival order splits a file that contains the same archive twice into two
// archives, because the second copy of every record is "the second one". Numbering by DISTINCT
// EXACT timestamp does both jobs at once:
//
//   - Two records with the same exact millisecond and the same words are one message counted twice.
//     They share an occurrence, so they collapse. That is a file holding overlapping backups.
//   - Two records a few seconds apart are two messages. Different exact timestamps, different
//     occurrences, both kept. That is someone saying "ok" twice.
//   - A message seen by two sources is #0 in each of their groups whatever their precision, so an
//     SMS at 10:00:01 and a WhatsApp line at 10:00 converge on one key.
//
// Where it is honestly ambiguous, it stays ambiguous rather than guessing. If one source captured
// both "ok"s and another captured only the second, that second one is #0 in its own file and merges
// with the first. If an export records whole minutes only — the dashed WhatsApp variant does, the
// bracketed one carries seconds — then the same words twice inside one minute are one row, because
// nothing in that file distinguishes them. Clock skew beyond the bucket is the same story from the
// other end: it yields two rows rather than a silent merge, which is the direction to fail in, and
// archive health counts what was collapsed so the number is visible rather than assumed.
import { createHash } from 'node:crypto';

/**
 * Body text as compared across sources. Unicode-normalized (the same accented character has more
 * than one encoding, and exporters disagree), whitespace collapsed (line endings and trailing space
 * differ per format), but NEVER case-folded: "ok" and "OK" are different messages and no source
 * changes the case of what was typed.
 */
export function normalizeBody(body: string | null): string {
  if (body == null) return '';
  return body.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** The 60-second bucket both sides of a cross-source comparison land in. */
export function timeBucket(sentAtMs: number): number {
  return Math.floor(sentAtMs / 60_000);
}

export interface CanonicalKeyParts {
  /** The counterpart's natural key; for a group, the sorted set of them joined. Never a temp-id. */
  counterpart: string;
  direction: string;
  sentAtMs: number;
  bodyText: string | null;
  /**
   * Rank of this message among the ones it is indistinguishable from, inside its
   * (counterpart, direction, bucket, body) group. See `keyBatch` for how the rank is assigned.
   */
  occurrence: number;
}

/**
 * A record's identity according to the source that produced it — MMS `m_id`, an iMessage guid, a
 * generic file's own `id`. Never part of the key, only of the ordering within one import.
 *
 * `contentDigest` is NOT an identity and must never be used as one. It is a fingerprint of what a
 * record carries (its attachment manifest), used only to separate rows that share an EXACT instant
 * and would otherwise be indistinguishable. Two sends of the same photo have the same content and
 * are two different messages; treating content as identity collapses them, which is the mistake
 * this field exists to keep separate from `nativeId`.
 */
export interface NativeId { nativeId?: string | null; contentDigest?: string | null }

export function computeDedupKey(p: CanonicalKeyParts): string {
  const body = normalizeBody(p.bodyText);
  // JSON.stringify gives an unambiguous, order-fixed, null-distinct serialization; no delimiter can
  // be forged from body text, which is why the body arrives here as its own hash.
  return createHash('sha256')
    .update(JSON.stringify([
      p.counterpart,
      p.direction,
      timeBucket(p.sentAtMs),
      createHash('sha256').update(body).digest('hex'),
      p.occurrence,
    ]))
    .digest('hex');
}

/**
 * Assign occurrence indices across a batch, then key it.
 *
 * Order within a group is by timestamp, then by the caller's arrival order — stable for a given
 * file, and stable for a given database when the caller passes rows in id order.
 */
export function keyBatch<T>(
  rows: T[],
  parts: (row: T, index: number) => Omit<CanonicalKeyParts, 'occurrence'> & NativeId,
): string[] {
  const indexed = rows.map((row, arrival) => ({ row, arrival, p: parts(row, arrival) }));
  const groups = new Map<string, typeof indexed>();
  for (const entry of indexed) {
    const g = JSON.stringify([
      entry.p.counterpart,
      entry.p.direction,
      timeBucket(entry.p.sentAtMs),
      normalizeBody(entry.p.bodyText),
    ]);
    const bucket = groups.get(g);
    if (bucket) bucket.push(entry); else groups.set(g, [entry]);
  }

  const keys = new Array<string>(rows.length);
  for (const bucket of groups.values()) {
    // Rank by the record's own identity where the source gives it one, and fall back to the exact
    // timestamp where it does not.
    //
    // Timestamp alone was wrong, and wrong in the direction that eats messages. Android MMS dates
    // arrive at second precision, so three photos sent in one second share an exact timestamp and an
    // empty body — and ranking by timestamp gave all three the same occurrence, one key, and one
    // surviving row. Two of the three photos were gone, counted as "duplicates collapsed at import".
    // v0.4.1 kept them, because its MMS key was the m_id. The spec named this tiebreak and this
    // file had dropped it.
    //
    // The native id stays OUT of the key itself — two sources describing one message do not agree on
    // ids, and a key containing one could never converge across formats. It only decides the order
    // and the grouping within a single import, which is exactly where it is knowable.
    // A row's identity, decided per ROW rather than per bucket.
    //
    // Records the source calls distinct ARE distinct; records it cannot distinguish fall back to the
    // instant, so one file holding the same backup twice still collapses. Without a source id the
    // instant is the identity — two records a few seconds apart are two messages, and the same
    // record listed twice at one instant is one. The content fingerprint refines that and nothing
    // more: rows sharing an exact timestamp are separated when what they carry differs, which is how
    // three photos sent in one second stay three without making two sends of the SAME photo collapse
    // into one. Content decides nothing across timestamps.
    //
    // It was decided per BUCKET, which had two faults. One m_id-bearing row made every id-less row
    // in the same bucket fall back to its arrival index — a value no other row can ever equal, so
    // those rows could never converge with their own duplicates. And a row with no id in a bucket
    // that had one was keyed on arrival rather than on what it carried.
    const identityOf = (e: typeof bucket[number]): string => (
      e.p.nativeId != null && e.p.nativeId !== ''
        ? `id:${e.p.nativeId}`
        : `ms:${e.p.sentAtMs}:${e.p.contentDigest ?? ''}`);

    // The sort must group equal identities TOGETHER, because the scan below compares each row only
    // with the one before it. The content fingerprint was in the identity but not in this
    // comparator, so two copies of a three-photo burst interleaved as a,b,c,a,b,c — no two equal
    // rows adjacent, six occurrences, six keys, and a file holding the same backup twice stored it
    // twice. Sorting on the identity itself makes adjacency a property of the sort rather than of
    // the order the file happened to list things in.
    bucket.sort((a, b) => a.p.sentAtMs - b.p.sentAtMs
      || identityOf(a).localeCompare(identityOf(b))
      || a.arrival - b.arrival);

    let occurrence = -1;
    let previous: string | null = null;
    for (const entry of bucket) {
      const identity = identityOf(entry);
      if (previous === null || identity !== previous) occurrence += 1;
      previous = identity;
      keys[entry.arrival] = computeDedupKey({ ...entry.p, occurrence });
    }
  }
  return keys;
}
