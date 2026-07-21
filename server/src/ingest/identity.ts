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

  // ── Owner detection: strict, unique maximum co-occurrence degree. The owner shares messages
  // with the most distinct people; a counterparty typically co-occurs only with the owner. ──
  let owner: Cluster | null = null;
  const list = [...clusters.values()];
  if (list.length >= 2) {
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
