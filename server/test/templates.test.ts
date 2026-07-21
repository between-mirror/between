// Between Mirror — receipts absolutism (Era 1, v0.3.0).
//
// The evidence chain had one hole left, and it was in the connective tissue. Observations and
// interpretations have required receipts since v0.2.0 — but *bridges* and the *closing question* were
// still authored by the model and carried no evidence by design. So the one kind of sentence a reading
// could contain without a receipt was the kind nobody was watching: prose the model wrote freely.
//
// The fix is not to demand receipts for connective tissue (it asserts nothing, so there is nothing to
// receipt). It is to take the pen away: the model may now emit ONLY evidence-bearing kinds, and the app
// composes bridges and the closing question from a fixed, authored template set in docs/VOICE.md.
//
// The resulting claim — the one STATUS.md now makes — is:
//   every model-authored proposition carries receipts; connective prose is app-authored from fixed
//   templates.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderBlockSchema, blocksResultSchema, validateLensResult, MODEL_BLOCK_KINDS } from '../src/airlock/schemas';
import { BRIDGES, CLOSING_QUESTIONS, pickTemplate } from '../src/lenses/voiceTemplates';
import { composeBlocks } from '../src/lenses/render';
import { RENDER_BLOCKS_SCHEMA, BLOCKS_RETURN } from '../src/airlock/prompts';

const VOICE = readFileSync(resolve(__dirname, '../../docs/VOICE.md'), 'utf8');

describe('the model may not author unreceipted prose', () => {
  it('the emittable kinds are exactly the evidence-bearing ones', () => {
    expect([...MODEL_BLOCK_KINDS]).toEqual(['observation', 'tentative_interpretation']);
  });

  it('rejects a model-supplied bridge', () => {
    const r = renderBlockSchema.safeParse({ kind: 'bridge', text: 'And there is more here.', evidence_ids: [] });
    expect(r.success).toBe(false);
  });

  it('rejects a model-supplied question', () => {
    const r = renderBlockSchema.safeParse({ kind: 'question', text: 'What would you change?', evidence_ids: [] });
    expect(r.success).toBe(false);
  });

  it('rejects a whole payload if any block is a bridge — not just that block', () => {
    const payload = {
      title: 'A reading',
      blocks: [
        { kind: 'observation', text: 'You reached first, most weeks.', evidence_ids: ['m1'] },
        { kind: 'bridge', text: 'That is not the whole of it.', evidence_ids: [] },
      ],
    };
    expect(blocksResultSchema.safeParse(payload).success).toBe(false);
    // and at the lens boundary, where it actually matters
    for (const lens of ['episode_note', 'letter', 'ask_answer', 'first_reflection_render'] as const) {
      const v = validateLensResult(lens, payload);
      expect(v.ok, `${lens} should reject a model-authored bridge`).toBe(false);
    }
  });

  it('still requires a receipt on every emittable kind', () => {
    for (const kind of MODEL_BLOCK_KINDS) {
      expect(renderBlockSchema.safeParse({ kind, text: 'A claim.', evidence_ids: [] }).success).toBe(false);
      expect(renderBlockSchema.safeParse({ kind, text: 'A claim.', evidence_ids: ['m1'] }).success).toBe(true);
    }
  });

  it('no longer tells the model it may write bridges or questions', () => {
    // The prompt is the other half of the contract: leaving the old instructions in place would just
    // manufacture validation failures on every reading.
    const kinds = (RENDER_BLOCKS_SCHEMA as any).properties.blocks.items.properties.kind.enum;
    expect(kinds).toEqual(['observation', 'tentative_interpretation']);
    expect(BLOCKS_RETURN).not.toMatch(/"bridge"/);
    expect(BLOCKS_RETURN).not.toMatch(/"question"/);
  });
});

describe('the templates are VOICE data, not code', () => {
  it('every bridge appears verbatim in docs/VOICE.md', () => {
    expect(BRIDGES.length).toBeGreaterThanOrEqual(5);
    for (const t of BRIDGES) expect(VOICE, `missing from VOICE.md: ${t}`).toContain(t);
  });

  it('every closing question appears verbatim in docs/VOICE.md', () => {
    expect(CLOSING_QUESTIONS.length).toBeGreaterThanOrEqual(4);
    for (const t of CLOSING_QUESTIONS) expect(VOICE, `missing from VOICE.md: ${t}`).toContain(t);
  });

  it('bridges are within the 30-word cap and assert nothing countable', () => {
    for (const t of BRIDGES) {
      expect(t.trim().split(/\s+/).length, t).toBeLessThanOrEqual(30);
      // A template can never carry a fact, so it must never carry a number, a date, or a name slot.
      expect(t, t).not.toMatch(/\d/);
      expect(t, t).not.toMatch(/\{/);
    }
  });

  it('closing questions are questions, and carry no facts', () => {
    for (const t of CLOSING_QUESTIONS) {
      expect(t.trim().endsWith('?'), t).toBe(true);
      expect(t, t).not.toMatch(/\d/);
      expect(t, t).not.toMatch(/\{/);
    }
  });

  it('holds the VOICE ban on exclamation marks in reflective prose', () => {
    for (const t of [...BRIDGES, ...CLOSING_QUESTIONS]) expect(t, t).not.toContain('!');
  });
});

describe('selection is deterministic — same reading, same words, no RNG', () => {
  it('the same content hash always picks the same template', () => {
    const a = pickTemplate(BRIDGES, 'the same body text', 0);
    const b = pickTemplate(BRIDGES, 'the same body text', 0);
    expect(a).toBe(b);
  });

  it('different content generally picks differently', () => {
    const picks = new Set(
      ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta']
        .map((s) => pickTemplate(BRIDGES, s, 0)),
    );
    expect(picks.size).toBeGreaterThan(1);
  });

  it('the two bridge slots in one reading never repeat the same line', () => {
    for (const seed of ['one', 'two', 'three', 'four', 'five', 'six', 'seven']) {
      expect(pickTemplate(BRIDGES, seed, 0)).not.toBe(pickTemplate(BRIDGES, seed, 1));
    }
  });
});

describe('composition — the app writes the connective tissue', () => {
  const valid = new Set(['m1', 'm2', 'm3', 'm4', 'm5']);
  const obs = (text: string, id: string) => ({ text, kind: 'observation' as const, evidence_ids: [id] });

  it('closes a non-empty reading with exactly one template question', () => {
    const out = composeBlocks([obs('You reached first.', 'm1'), obs('The replies slowed.', 'm2')], valid);
    const questions = out.blocks.filter((b) => b.kind === 'question');
    expect(questions).toHaveLength(1);
    expect(CLOSING_QUESTIONS).toContain(questions[0].text);
    expect(out.body.trim().endsWith(questions[0].text)).toBe(true);
  });

  it('every bridge in the output comes from the template set, and never more than two', () => {
    const out = composeBlocks(
      [obs('a', 'm1'), obs('b', 'm2'), obs('c', 'm3'), obs('d', 'm4'), obs('e', 'm5')],
      valid,
    );
    const bridges = out.blocks.filter((b) => b.kind === 'bridge');
    expect(bridges.length).toBeGreaterThan(0);
    expect(bridges.length).toBeLessThanOrEqual(2);
    for (const b of bridges) expect(BRIDGES).toContain(b.text);
  });

  it('drops a bridge or question that arrives from the model anyway', () => {
    // Belt to the schema's braces: a stale cached result, or an engine that ignores the contract,
    // must not get connective prose into a reading through the composer's back door.
    const out = composeBlocks(
      [
        obs('You reached first.', 'm1'),
        { text: 'A model-written bridge that asserts something sneaky.', kind: 'bridge' as const, evidence_ids: [] },
        { text: 'A model-written question?', kind: 'question' as const, evidence_ids: [] },
      ],
      valid,
    );
    expect(out.body).not.toContain('sneaky');
    expect(out.body).not.toContain('A model-written question?');
    expect(out.dropped).toBe(2);
  });

  it('adds nothing at all to a reading with no surviving evidence', () => {
    // No claims survived, so there is nothing to bridge and nothing to ask about. A template question
    // floating over an empty reading would be prose with no reading underneath it.
    const out = composeBlocks([obs('A claim citing a ghost.', 'm999')], valid);
    expect(out.body).toBe('');
    expect(out.blocks).toHaveLength(0);
  });

  it('a single observation gets a question but no bridge — nothing to bridge between', () => {
    const out = composeBlocks([obs('You reached first.', 'm1')], valid);
    expect(out.blocks.filter((b) => b.kind === 'bridge')).toHaveLength(0);
    expect(out.blocks.filter((b) => b.kind === 'question')).toHaveLength(1);
  });

  it('keeps the receipts of the surviving evidence blocks untouched', () => {
    const out = composeBlocks([obs('You reached first.', 'm1'), obs('The replies slowed.', 'm2')], valid);
    expect(out.evidence).toEqual({ 'You reached first.': ['m1'], 'The replies slowed.': ['m2'] });
  });
});
