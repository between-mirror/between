// Between — the airlock idempotency key (docs/SPECS/airlock.md §"The idempotency key", TEST T2.1).
//
//   canonical(x) = JSON with lexicographically sorted keys, no insignificant whitespace, UTF-8
//   SEP          = one U+0020 SPACE
//   preimage     = canonical({prompt_id,prompt_version,params})
//                  + SEP + chunk_text + SEP + canonical(output_schema)
//   digest       = sha256(utf8 bytes of preimage)        // raw 32 bytes
//   input_hash   = "sha256:" + lowercase hex of digest
//   job id       = "job_" + base32lower(digest)[0:16]    // the RAW digest, not the hex string
//
// SEP is named, not shown, because the spec once wrote it as a literal NUL byte that rendered as
// nothing and this function was written from that rendering. It is a persisted primary key: changing
// SEP strands every cached analysis_results row and forces a paid re-drain. See the spec's note.
//
// Deterministic across runs/platforms: any single byte change in prompt id/version/params,
// chunk text, or output schema yields a new hash (and therefore a new job id).
import { createHash } from 'node:crypto';

/** Recursively stringify with lexicographically-sorted object keys and no whitespace. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'; // RFC 4648, lower-cased, no padding

/** RFC 4648 base32 (lower-case, unpadded) of a byte buffer. */
export function base32lower(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export interface HashInput {
  promptId: string;
  promptVersion: number;
  params: Record<string, unknown>;
  chunkText: string;
  outputSchema: unknown;
}

export interface HashResult {
  /** Idempotency key, "sha256:<hex>" (the analysis_results primary key). */
  inputHash: string;
  /** "job_" + base32lower(raw digest)[0:16]. */
  jobId: string;
}

/** Compute the input_hash + job id for a chunk under a prompt (§4.2). */
export function computeHash(input: HashInput): HashResult {
  const meta = canonical({
    prompt_id: input.promptId,
    prompt_version: input.promptVersion,
    params: input.params,
  });
  const schema = canonical(input.outputSchema);
  const digest = createHash('sha256')
    .update(`${meta} ${input.chunkText} ${schema}`, 'utf8')
    .digest();
  return {
    inputHash: `sha256:${digest.toString('hex')}`,
    jobId: `job_${base32lower(digest).slice(0, 16)}`,
  };
}
