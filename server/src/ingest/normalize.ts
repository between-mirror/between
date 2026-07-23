// Record-level normalization (GAMEPLAN §2.3 stage 3): RawRecord -> NormalizedMessage.
// Coerces the literal "null", computes a first-class `direction`, concatenates MMS
// text, maps <addr> roles, derives attachment metadata, and runs the ingest
// classifiers. Identity resolution, threading and dedup happen later (other agents);
// this stage stays purely record-local.
import type {
  RawRecord, NormalizedMessage, NormalizedAddress, NormalizedAttachment,
  IdentifierKind, Direction, AddrRole,
} from '../types';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import type { CountryCode } from 'libphonenumber-js';
import { classifyReaction, detectLanguage } from './classify';

export interface NormalizeCtx {
  region: string;
  sourceFileId: number;
}

// Everything-absent is the literal 4-char string "null" (not empty, not missing).
// Coerce "null" and "" to a real null for EVERY field before typing anything.
function coerce(v: string | undefined): string | null {
  if (v == null) return null;
  if (v === 'null' || v === '') return null;
  return v;
}

function toInt(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// @date is epoch milliseconds UTC (reliable primary sort key). Some exports store
// seconds — a bare 10-digit value is scaled to ms. readable_date is never parsed.
function toMs(v: string | null): number {
  if (v == null) return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (/^\d{10}$/.test(v.trim())) return n * 1000;
  return n;
}

// @read is "1" when read; anything absent/"null" is unknown (null).
function readFlag(v: string | null): boolean | null {
  if (v == null) return null;
  return v === '1';
}

// SMS @type -> direction. 1=received, 2=sent, 3=draft; 4/5/6 (outbox/failed/queued)
// and anything unexpected collapse to 'other'.
function smsDirection(type: number | null): Direction {
  switch (type) {
    case 1: return 'incoming';
    case 2: return 'outgoing';
    case 3: return 'draft';
    default: return 'other';
  }
}

// MMS @msg_box -> direction, cross-checked with @m_type when msg_box is ambiguous.
function mmsDirection(msgBox: number | null, mType: number | null): Direction {
  switch (msgBox) {
    case 1:
    case 3: return 'incoming';
    case 2:
    case 4: return 'outgoing';
    default:
      if (mType === 128) return 'outgoing';
      if (mType === 132) return 'incoming';
      return 'other';
  }
}

// MMS <addr @type> -> role. 137=From, 151=To, 130=Cc, 129=Bcc. Unknown types are
// treated as recipients ('to') so the participant is not silently dropped.
function mmsAddrRole(type: number | null): AddrRole {
  switch (type) {
    case 137: return 'from';
    case 151: return 'to';
    case 130: return 'cc';
    case 129: return 'bcc';
    default: return 'to';
  }
}

// Normalize a raw address into E.164 + a kind tag. Uses libphonenumber's
// possibility check (not full validity) so fictional/uncommon-but-well-formed
// numbers still resolve, while true garbage stays null.
export function normalizeNumber(
  raw: string,
  region: string,
): { e164: string | null; kind: IdentifierKind } {
  const value = (raw ?? '').trim();
  if (value === '') return { e164: null, kind: 'alias' };
  if (value.includes('@')) return { e164: null, kind: 'email' };

  const digits = value.replace(/\D/g, '');
  // Non-numeric handle (letters present, or no digits at all) -> alias.
  if (digits.length === 0 || /[A-Za-z]/.test(value)) {
    return { e164: null, kind: 'alias' };
  }
  // Shortcodes (<= 6 digits) have no E.164 form.
  if (digits.length <= 6) return { e164: null, kind: 'shortcode' };

  const parsed = parsePhoneNumberFromString(value, region as CountryCode);
  if (parsed && parsed.isPossible()) {
    return { e164: parsed.number, kind: 'mobile' };
  }
  return { e164: null, kind: 'mobile' };
}

export function normalizeRecord(rec: RawRecord, ctx: NormalizeCtx): NormalizedMessage {
  const { region, sourceFileId } = ctx;

  if (rec.kind === 'sms') {
    const a = rec.attrs;
    const rawType = toInt(coerce(a.type));
    const direction = smsDirection(rawType);
    const bodyText = coerce(a.body);
    const address = coerce(a.address);

    const addresses: NormalizedAddress[] = [];
    if (address != null) {
      const { e164 } = normalizeNumber(address, region);
      addresses.push({ raw: address, e164, role: direction === 'incoming' ? 'from' : 'to' });
    }

    const reaction = classifyReaction(bodyText);
    return {
      kind: 'sms',
      direction,
      sentAtMs: toMs(coerce(a.date)),
      bodyText,
      isRead: readFlag(coerce(a.read)),
      isReaction: reaction.isReaction,
      reactionKind: reaction.kind,
      lang: detectLanguage(bodyText),
      rawType,
      rawMsgBox: null,
      addresses,
      contactNameHint: coerce(a.contact_name),
      attachments: [],
      // An SMS row from a phone backup has no id of its own, but an importer that emits this shape
      // from a source that DOES — the chat.db reader, whose every message carries a guid — can pass
      // one here. Without it, two messages that share an instant and a body are indistinguishable
      // to the occurrence ranking and collapse into one row. That is the ordinary case for a
      // pre-High-Sierra chat.db, whose dates have whole-second granularity.
      mmsMId: coerce(a.native_id),
      partCount: 0,
      sourceFileId,
    };
  }

  // ── MMS ──
  const a = rec.attrs;
  const rawMsgBox = toInt(coerce(a.msg_box));
  const mType = toInt(coerce(a.m_type));
  const direction = mmsDirection(rawMsgBox, mType);

  const textParts: string[] = [];
  const attachments: NormalizedAttachment[] = [];
  for (const part of rec.parts) {
    const pa = part.attrs;
    const ct = coerce(pa.ct);
    const seq = coerce(pa.seq);

    // Body = ordered concat of text/plain parts, skipping the seq="-1" SMIL layout.
    if (ct === 'text/plain' && seq !== '-1') {
      const text = coerce(pa.text);
      if (text != null) textParts.push(text);
      continue;
    }

    // Everything else is an attachment (metadata only). The SMIL part is recorded
    // too, flagged isSmil so downstream counts can exclude it.
    const dataLen = toInt(coerce(pa._dataLen));
    const sizeBytes = dataLen != null && dataLen > 0 ? Math.floor((dataLen * 3) / 4) : null;
    attachments.push({
      mimeType: ct ?? 'application/octet-stream',
      filename: coerce(pa.name) ?? coerce(pa.cl) ?? coerce(pa.fn),
      sizeBytes,
      sha256: null,
      isSmil: ct === 'application/smil',
    });
  }
  const bodyText = textParts.length > 0 ? textParts.join('') : null;

  const addresses: NormalizedAddress[] = [];
  if (rec.addrs.length > 0) {
    for (const addr of rec.addrs) {
      const raw = coerce(addr.attrs.address);
      if (raw == null) continue;
      const { e164 } = normalizeNumber(raw, region);
      addresses.push({ raw, e164, role: mmsAddrRole(toInt(coerce(addr.attrs.type))) });
    }
  } else {
    // 1:1 MMS frequently omit <addrs>; fall back to the envelope address.
    // A group envelope joins participants with "~".
    const envelope = coerce(a.address);
    if (envelope != null) {
      const role: AddrRole = direction === 'incoming' ? 'from' : 'to';
      for (const piece of envelope.split('~')) {
        const raw = piece.trim();
        if (raw === '') continue;
        const { e164 } = normalizeNumber(raw, region);
        addresses.push({ raw, e164, role });
      }
    }
  }

  const reaction = classifyReaction(bodyText);
  return {
    kind: 'mms',
    direction,
    sentAtMs: toMs(coerce(a.date)),
    bodyText,
    isRead: readFlag(coerce(a.read)),
    isReaction: reaction.isReaction,
    reactionKind: reaction.kind,
    lang: detectLanguage(bodyText),
    rawType: null,
    rawMsgBox,
    addresses,
    contactNameHint: coerce(a.contact_name),
    attachments,
    mmsMId: coerce(a.m_id),
    partCount: rec.parts.length,
    sourceFileId,
  };
}
