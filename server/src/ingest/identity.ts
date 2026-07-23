// Identity resolution (GAMEPLAN §2.3 stage 4). Cluster raw addresses into contacts by E.164
// equality (falling back to the raw string when e164 is null), assign a stable temp-id per
// contact, build the per-raw identifiers, and propose the owner empirically. Raw is always kept.
//
// Owner heuristic: the owner is a participant in *every* conversation, so — where the parser
// surfaces the owner's own address (MMS <addrs>: the 137 sender on outbound, a 151 recipient on
// inbound) — the owner's cluster appears across more distinct participant-sets than any single
// counterparty. If no cluster wins outright (e.g. an SMS-only archive, where the owner's number
// never appears as an address), ownerTempId stays null and onboarding asks the user (§5.1, Open Q1).
import type {
  NormalizedMessage,
  IdentityResult,
  ResolvedContact,
  ResolvedIdentifier,
  IdentifierKind,
} from '../types';

interface Cluster {
  tempId: number;
  key: string; // e164 when known, else the raw string
  e164: string | null; // primary e164 (null for raw-keyed clusters: shortcodes/aliases/email)
  firstSeenMs: number;
  lastSeenMs: number;
  nameHint: { name: string; ms: number } | null; // most-recent hint, from 1:1 messages only
  neighbors: Set<string>; // distinct OTHER addresses this one shares a message with (co-occurrence)
}

interface IdAcc {
  rawValue: string;
  normalizedE164: string | null;
  clusterKey: string;
  sourceContactName: string | null;
  firstSeenMs: number;
  lastSeenMs: number;
}

function inferKind(raw: string, e164: string | null): IdentifierKind {
  if (raw.includes('@')) return 'email';
  if (e164) return 'mobile';
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length >= 1 && digits.length <= 6) return 'shortcode';
  return 'alias';
}

export function resolveIdentities(messages: NormalizedMessage[], _region: string): IdentityResult {
  const clusters = new Map<string, Cluster>(); // clusterKey -> Cluster
  const ids = new Map<string, IdAcc>(); // rawValue -> identifier accumulator
  let nextTempId = 1;

  for (const m of messages) {
    // Distinct addresses on THIS message — the co-occurrence group used for owner detection.
    const uniqMembers = [...new Set(m.addresses.map((a) => a.e164 ?? a.raw).filter((k) => k !== ''))];
    const singleAddr = m.addresses.length === 1;

    for (const a of m.addresses) {
      const key = a.e164 ?? a.raw;
      if (key === '') continue;

      let c = clusters.get(key);
      if (!c) {
        c = {
          tempId: nextTempId++,
          key,
          e164: a.e164,
          firstSeenMs: m.sentAtMs,
          lastSeenMs: m.sentAtMs,
          nameHint: null,
          neighbors: new Set(),
        };
        clusters.set(key, c);
      }
      if (a.e164 && !c.e164) c.e164 = a.e164; // upgrade if a later occurrence resolved e164
      if (m.sentAtMs < c.firstSeenMs) c.firstSeenMs = m.sentAtMs;
      if (m.sentAtMs > c.lastSeenMs) c.lastSeenMs = m.sentAtMs;
      for (const other of uniqMembers) if (other !== key) c.neighbors.add(other);

      // Name hints are only trustworthy in 1:1 messages — in a group, contactNameHint may be a
      // joined label that belongs to no single participant. Keep the most-recent one.
      if (singleAddr && m.contactNameHint) {
        if (!c.nameHint || m.sentAtMs >= c.nameHint.ms) c.nameHint = { name: m.contactNameHint, ms: m.sentAtMs };
      }

      // Per-raw identifier row (schema: identifiers UNIQUE(raw_value)).
      let id = ids.get(a.raw);
      if (!id) {
        id = {
          rawValue: a.raw,
          normalizedE164: a.e164,
          clusterKey: key,
          sourceContactName: null,
          firstSeenMs: m.sentAtMs,
          lastSeenMs: m.sentAtMs,
        };
        ids.set(a.raw, id);
      }
      if (a.e164 && !id.normalizedE164) id.normalizedE164 = a.e164;
      if (m.sentAtMs < id.firstSeenMs) id.firstSeenMs = m.sentAtMs;
      if (m.sentAtMs > id.lastSeenMs) id.lastSeenMs = m.sentAtMs;
      if (singleAddr && m.contactNameHint) id.sourceContactName = m.contactNameHint;
    }
  }

  // ── Owner detection ────────────────────────────────────────────────────────
  //
  // First, the answer the file states outright. On an OUTGOING message the address in the `from`
  // role is the sender, and the sender of an outgoing message is the archive's owner — that is what
  // outgoing means. Android MMS writes it as the type-137 address. This is not a heuristic and does
  // not need a second conversation to work.
  //
  // It matters most for the smallest files, which is exactly where the heuristic below cannot help:
  // a single-conversation export has one counterparty, so nobody has two neighbours and no unique
  // maximum exists. The owner then fell in among the counterparties — and because the owner's
  // number appears in MMS <addrs> but never in an <sms> row, ONE file produced two different
  // participant sets for one conversation and filed it as two threads, the second looking like a
  // group chat. Reading the direction the file already recorded costs nothing and settles it.
  let owner: Cluster | null = null;
  const list = [...clusters.values()];
  const directOwnerKeys = new Set<string>();
  for (const m of messages) {
    if (m.direction === 'outgoing') {
      for (const a of m.addresses) {
        if (a.role !== 'from') continue;
        const key = a.e164 ?? a.raw;
        if (key !== '') directOwnerKeys.add(key);
      }
      continue;
    }

    // The mirror image is equally direct for an incoming one-to-one MMS: when the record names
    // exactly one recipient, that recipient is the archive owner. A group names several recipients
    // and deliberately contributes no evidence here.
    if (m.direction === 'incoming') {
      const recipients = [...new Set(m.addresses
        .filter((a) => a.role === 'to')
        .map((a) => a.e164 ?? a.raw)
        .filter((key) => key !== ''))];
      if (recipients.length === 1) directOwnerKeys.add(recipients[0]);
    }
  }
  if (directOwnerKeys.size === 1) {
    // Exactly one address ever occupies an owner role: unambiguous.
    owner = clusters.get([...directOwnerKeys][0]) ?? null;
  } else if (directOwnerKeys.size > 1) {
    // More than one is a contradiction in the file rather than a fact about a person — a relay, a
    // merged export, a rewritten backup. Say nothing and let the co-occurrence rule decide.
    owner = null;
  }

  if (owner == null && list.length >= 2) {
    const ranked = [...list].sort(
      (a, b) => b.neighbors.size - a.neighbors.size || a.tempId - b.tempId,
    );
    const top = ranked[0];
    const runnerUp = ranked[1];
    if (top.neighbors.size >= 2 && top.neighbors.size > runnerUp.neighbors.size) {
      owner = top;
    }
  }

  const contacts: ResolvedContact[] = list.map((c) => ({
    tempId: c.tempId,
    key: c.key,
    displayName: c.nameHint?.name ?? null,
    primaryE164: c.e164,
    isOwner: owner != null && c.tempId === owner.tempId,
  }));

  const identifiers: ResolvedIdentifier[] = [...ids.values()].map((id) => {
    const c = clusters.get(id.clusterKey)!;
    return {
      contactTempId: c.tempId,
      rawValue: id.rawValue,
      normalizedE164: id.normalizedE164,
      kind: inferKind(id.rawValue, id.normalizedE164),
      sourceContactName: id.sourceContactName,
      firstSeenMs: id.firstSeenMs,
      lastSeenMs: id.lastSeenMs,
    };
  });

  const contactIdByAddress = new Map<string, number>();
  for (const id of ids.values()) {
    contactIdByAddress.set(id.rawValue, clusters.get(id.clusterKey)!.tempId);
  }

  return {
    contactIdByAddress,
    contacts,
    identifiers,
    ownerTempId: owner?.tempId ?? null,
  };
}
