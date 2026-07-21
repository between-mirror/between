# Between — Method & Handoff

*For the next person who runs this on their own archive — and for anyone (a therapist, most likely)
who receives what a client brings out of it. Read this before you trust a single number.*

Between is a **mirror, not a verdict.** It reads a personal message archive and reflects patterns back,
with receipts. It never diagnoses, never tells anyone to stay or leave, and never claims to know what
happened in a marriage — only what the *words* show. This document is what the scores are, what they are
not, and — most importantly — the one thing that decides whether the mirror tells the truth or tells you
what you want to hear.

---

## 0. The one thing that matters most: honesty in calibration

Between tunes itself to *you* through two short human passes:

1. **Hold-out labeling** — you label ~50 of your own messages (hostile? which direction? how severe? or
   is it a joke/quote?). This sets the detector's threshold and confidence language.
2. **Episode grading** — you read ~10 of your worst fights, already pattern-read on both sides, and mark
   each read fair / overstated / understated. This confirms the power-balance gate before it may speak.

**The entire instrument is only as honest as those two passes.** And here is the trap:

> Most people see the other person's role in a conflict far more readily than their own. Faced with your
> own cruel message, the pull is to call it "heated, not hostile," "just venting," "they started it."
> Faced with your partner's, the pull is the reverse. If you label that way — gently on yourself, harshly
> on them — Between will dutifully conclude that you were the victim, and hand you a comforting lie with
> receipts attached. That is the worst thing this tool could do.

So the instruction, stated plainly, is the instruction that makes it work: **be honest, and be
vulnerable. Score your own worst messages as harshly as you would score the same words from them. The
point of a mirror is to show you your own face, including the parts you flinch from.** A calibration done
defensively produces a beautiful, evidenced, wrong answer.

### The defence (so the tool doesn't depend only on your virtue)

Because the model scores every message **independently** of your labels, Between can *check* your
calibration against its own read (`server/src/lenses/bias.ts`, `computeSelfReportBias`):

- It compares, on the messages the model scored hostile, how often **you** called your *own* hostile and
  how often you called your *partner's* hostile.
- A gap — lenient on yourself, harsh on them — is the **self-report bias**. When it's present, Between
  (1) **says so, plainly**, and (2) **raises the bar the power-balance gate must clear** before it will
  speak in a one-sided "support" frame, and leans harder on the model's own reading than on your labels.
- The **coercive-marker evidence** the gate weighs (threats, monitoring, coercive demands) is always
  **model-detected, never user-labeled** — the robust backstop that a defensive labeler cannot soften.

*(Assume the gap is yours. Nearly everyone rates their own hard messages more gently than the ones
they received — that is what makes it a bias rather than a character flaw, and it is why the check
exists at all. Expecting to be the exception is the most reliable way to be wrong about it.)*

---

## 1. What the scores are

- **L1 emotion (per message):** warmth 0–3, tension 0–3, valence −1..1, tone flags — the raw texture,
  read by a model with the pragmatics of texting in mind (sarcasm, jokes, quoted speech).
- **Episodes (L7):** deterministic clusters of hostile messages — the fights — with per-side attribution,
  repair timing, and kid-proximity. No model output except an optional narration.
- **Eras (F2):** change-point segmentation of the monthly signals into a handful of named seasons.
- **Abuse patterns (L4):** a two-stage detector. Stage 1 = episodes (the hold-out-calibrated hostile
  threshold). Stage 2 = a model read of each episode for behavioural **patterns** per side — contempt,
  coercion, threat, monitoring, repair, apology — the *words and the moves*, never a diagnosis.
- **The power-balance gate:** a deterministic, recency-weighted judgement of whether abuse crosses a
  review threshold in **one direction** (→ a support frame) or runs **both ways** (→ a two-readings
  frame). It changes VOICE only; both sides' patterns are always computed and stored.

## 2. What the scores are NOT

- **Not the whole conversation.** Texts carry less than half. iMessage/RCS/voice/in-person are absent.
  Every surface says so.
- **Not a diagnosis.** The words "narcissist," "abuser," "gaslighter" are banned as labels for a person.
  Behaviour and patterns only.
- **Not a verdict, and not advice.** Between never says who was right, never says stay or leave.
- **Not interior weather.** It never claims motive, or what a child saw or felt — only proximity and
  words.

## 3. The gates (all of them narrow when uncertain)

| Gate | Trips when | Effect |
|---|---|---|
| Evidence floor | < ~150 substantive messages in range | declines to read; asks for a longer range |
| Grief mode | contact marked deceased | scoring suppressed; the space holds warmth only |
| Power-balance | severe volume + initiation + coercive markers all cross threshold one way | support VOICE frame for that era |
| **Self-report bias** | owner labeled self leniently vs partner | raises the power-balance bar; says so |

## 4. The evidence contract (invariant, everywhere)

Every rendered claim carries `evidence_ids` that resolve to real message rows. A sentence whose receipts
don't resolve is **dropped before it is ever shown** — in the first reflection, the episode notes, the
era summaries, the other-side reading, and the letter. If Between asserts something, you can open the
messages under it. If it can't show you the messages, it doesn't say it.

## 5. Safety & ethics surfaces (VOICE)

- The hard-moments gate wraps the heaviest views; `Not today` stays visible.
- A support-resource card appears where the pattern warrants it (both an "experiencing" and a "causing"
  variant — the tool is honest in both directions).
- A crisis banner appears where words point at not wanting to be here. **What actually ships is a single,
  US-centric line** — call or text **988** (the US Suicide & Crisis Lifeline), with a plain "outside the
  US, contact your local crisis line or tell someone who can sit with you today." It is deterministic
  (`safetyBanner` in `therapyPack.ts`): it surfaces in the conversation packet, and in the Findings view,
  whenever *any* death-wish disclosure exists on either side, regardless of age. **There is no
  region-aware resource lookup.** The banner does not detect the reader's country and does not substitute
  a local hotline. **If you (or the owner) are outside the US, treat the 988 line as a placeholder and put
  your own jurisdiction's crisis number in front of the client yourself** — the tool will not do it for
  you. (A support banner's recency wording sharpens if a disclosure falls in the last six weeks of the
  record, but the resource itself never changes and is never suppressed by age.)
- Regeneration is always a **new dated artifact**; nothing frozen is ever silently rewritten.

## 6. Running it on your own archive (the short version)

1. Import your archive (SMS/MMS XML). Nothing leaves the machine.
2. Drain L1 (local model, paid batch, or subscription) — the counting views work with any engine.
3. Do the **hold-out labeling** — honestly (see §0).
4. Materialize episodes/eras/growth/kids/ambient (`cli/phase3.ts`).
5. Do the **episode grading** — honestly (see §0). This confirms the gate.
6. Generate the reflection, and — last — the letter.

The deterministic views (rhythm, episodes, eras, exports, the trajectory) need no labels at all. Only the
things that *speak about the balance of harm* wait on your honest calibration. That ordering is on
purpose: the mirror shows you the shape of it for free, and only asks for your vulnerability before it is
willing to say something as heavy as "this was done to you," or "this was done by you."

---

# If you choose to share this packet with a professional

*The rest of this document is for whoever ends up reading the handoff — you, or a clinician you choose to
share it with. Between never operates on anyone's behalf and no therapist runs the tool; the owner may
assemble an **E2 conversation packet**, one or more **verbatim exports**, and possibly a **letter**, and
hand them on if and when they decide to. It is written so a careful reader who is not a statistician can
use these documents without over-reading them. If you read nothing else, read §11 (Limitations).*

## 7. What you are actually holding

Three kinds of artifact reach you, and they are not the same weight of thing:

- **The exports (E1)** are the ground floor: verbatim messages — ids, timestamps, speaker, text — and
  nothing else. No interpretation. These are the closest thing to primary evidence in the packet.
- **The conversation packet (E2)** is an *assembly* of already-frozen, receipt-validated readings plus a set of
  deterministic counts (the five findings, the era table, the trajectory line). It invents nothing at the
  moment it is built; it re-serves things that were computed and — for the prose parts — sampled and
  agreed to earlier.
- **The letter** is prose: one dated reading, in a deliberately non-clinical voice. It is the softest,
  most interpreted layer. Treat it as a letter, not a report.

Everything below explains how much to lean on each.

## 8. The exports and their SHA-256 — what a match does and does not prove

Every export carries a SHA-256 hash. Here is exactly what it covers and what it means, because it is easy
to over-trust.

**What is hashed.** Only the **verbatim message-body block** — the run of lines, one per message, each in
the form `[m<id>] <ISO timestamp> ME/THEM: <text>`. That block, and only that block, is fed to SHA-256
(`buildExport` in `server/src/lenses/exports.ts`).

**What is excluded.** The header and footer — the `generated:` stamp, the thread number, the range, the
message count, the "first id / last id" line — sit **outside** the hash. This is deliberate: it means the
same range of messages always produces the same hash, whatever day you regenerate it. The generated-at
timestamp changing does not change the fingerprint.

**How to verify it yourself.** Take the block of message lines between the two `---` rules (the body, not
the header, not the footer sentence), and run a standard tool:

- `sha256sum <that block>` on Linux, or
- `shasum -a 256 <that block>` on macOS.

Compare the hex string to the `body SHA-256` printed in the header and repeated in the footer. If they
match, the message text you are reading is **byte-for-byte** what the tool exported — nothing was edited,
inserted, or dropped in transit.

**What the match does NOT prove.** A matching hash is a *fidelity* check, not a *truth* check. It says the
bytes are intact. It says nothing about whether the messages themselves are truthful, complete, or
representative. In particular a clean hash does **not** establish that:

- the archive is the whole conversation (it is SMS/MMS only — iMessage, RCS, voice, and everything said
  in person are simply absent);
- either person's messages are honest (people lie, joke, quote, and perform in texts);
- the export was not *selected* to tell a particular story (a range or a ledger export is a slice; the
  hash certifies the slice, not the choice of slice).

So: use the hash to trust that the words weren't tampered with. Do not let a green checkmark stand in for
your own clinical judgement about what the words mean.

## 9. The five findings (A–E) — deterministic counts, not conclusions

The pack's "five findings" are labeled A–E and computed in `server/src/lenses/findings.ts`. **None of
them involves a model, a classifier, or any judgement.** Each one is a keyword or pattern match run over
the raw text and then counted. The memorable one-liners the pack prints next to them — *"she claims them
more than she shares them," "you reached more and were burned more," "you stopped meeting fire with fire
and started leaving the room"* — are **heuristic summaries of those counts**, written to be readable. They
are not clinical findings and were not reviewed by a clinician. Read them as captions on a tally, and go
to the underlying messages before you repeat any of them back to a client.

Here is what each one actually measures, what it eats, and where it goes wrong.

### A · The ledger of hands

- **Measures:** two count buckets — *physical* (partner-directed physical harm) and *death-wish* (words
  about wanting oneself or the other not to be alive), split by who said it.
- **Inputs:** two fixed regular expressions over message text. The physical pattern is *deliberately
  conservative* — it excludes the word "hurt" (emotional far more often than physical in this register),
  excludes "him" as an object (between these two it almost always means a son), and excludes "her own" (so
  an accusation about her hitting the *children* is not miscounted as partner violence).
- **Fails when:** the language is oblique, misspelled, or in a variant the regex doesn't cover (**under-
  counts**); or when a hit is a quote, a joke, an accusation, a threat, or a hypothetical rather than an
  admitted act (**mis-weights**). See §10 — *weigh, don't tally* — which exists mostly because of this
  finding. A number here is a count of **utterances that matched a pattern**, never a count of
  established incidents.

### B · Kids in the crossfire

- **Measures:** how often each person writes *"my kids"* vs *"our kids"* (and the son/daughter/boys/girls
  variants), by year. The intuition is possessive framing — claiming the children vs sharing them.
- **Inputs:** two regexes (`my …` / `our …`), counted per speaker per calendar year.
- **Fails when:** people use names instead of "my/our kids" (most of the time, honestly), or say "the
  kids," or when "my kids" is casual rather than territorial. It sees *pronoun choice*, not custody
  dynamics or parenting. The one-liner *"she claims them more than she shares them"* is a gloss on a ratio
  of two word-counts — treat it as a prompt to look, not a fact about the family.

### C · The apology economics

- **Measures:** two things. (1) *Who repairs first* after a fight — for each detected episode, which side
  says something apology-shaped within 24 hours of the last hostile message. (2) *Apology met with fire* —
  how often an apology is answered, within two hours, by a hostile reply from the other side, as a rate.
- **Inputs:** an apology regex ("sorry," "my bad," "I was wrong," "forgive me," "didn't mean it," etc.),
  the episode boundaries, and the calibrated hostility threshold for the "met with fire" reply.
- **Fails when:** an apology is sarcastic ("sorry you feel that way") and still counts as repair; when
  repair happens in person or by call and never appears in the text; when the two-hour / 24-hour windows
  miss a slower reconciliation. *"You reached more and were burned more"* is a summary of these two rates —
  directional, heuristic, and dependent on the hostility threshold being calibrated (see §0).

### D · The exit signature

- **Measures:** *how the owner leaves a fight*, per era. For each episode it takes the owner's **last**
  message inside the episode and classifies it into one of: *met* (answered heat with heat), *softened*
  (warmth or apology), *named pause* ("I need an hour," "let's talk tomorrow"), *silent withdrawal*
  (nothing warm, nothing hostile — just stops), or *block/threat* ("I'll block you," "stop texting me").
- **Inputs:** the episode spans, the owner's last in-episode message, its tension and warmth scores, and a
  few regexes for the pause/block language.
- **Fails when:** the "last message" is a poor proxy for how the fight actually ended (it often is); when
  a silence in the text was actually a phone call; when a real de-escalation reads as "silent withdrawal"
  because the calming happened off-channel. This is a shape over time, which is why it is shown *per era* —
  a rising rate of silent exits is the intended signal, not any single classification.

### E · The wearing-down curve

- **Measures:** per quarter, per side — average words per message, the rate of warm messages, the rate of
  *"I love you,"* and the rate of playful markers (lol/lmao/haha/jk and a few emoji). The idea is to see
  affection and playfulness thin out (or not) over years.
- **Inputs:** word counts, the calibrated warmth threshold, and two regexes ("i love you"; the playful
  set), bucketed by calendar quarter.
- **Fails when:** a couple simply stops writing "I love you" in text while still saying it aloud; when
  playfulness moves to a channel the archive can't see; when volume changes for unrelated reasons (a move,
  a new job, a new baby). A falling curve is worth a conversation; it is not evidence of a dying marriage.

## 10. Three principles for reading the pack without over-reading it

These three are the difference between using the pack well and misusing it. They matter more than any
single number in it.

### Weigh, don't tally

The ledger (finding A) is the sharpest example, and the pack itself repeats the warning next to it: the
physical-harm and death-wish counts **mix admissions, threats, accusations, quotes, and jokes** together,
pulled from a noisy channel where people say cruel and dramatic things they do not mean and describe real
things in oblique ways. **N hits is not N incidents.** A "3" in a bucket might be one real disclosure, one
recycled quote of it, and one furious accusation — or it might be three separate admissions. The only way
to know is to open the cited messages (the pack gives you the `m<id>` receipts for exactly this) and read
them in context. Cite the unambiguous, partner-directed ones sparingly; never read a raw count aloud as
though it were a case total.

### Both things are true

Between is built to hold, *in the same span of time*, evidence of harm **and** evidence of love and
repair — and to show you both rather than resolve them into a story. This is deliberate. A pack is not a
prosecution brief; it will place a cruel exchange and a tender one from the same week side by side on
purpose. The correct reading is almost never "which of these is the real relationship?" It is "**both of
these, over time**." When you find yourself reaching for a single verdict, that is usually the moment to
step back to the messages and let the record stay contradictory, because it was.

### The gate is per-era, not a verdict

The pack reports a **power-balance stance** — a direction (toward one person needing support, or
two-sided) with a confidence number. It is essential to understand that this is computed **era by era over
time**, not as one static ruling (`powerBalanceGate` in `server/src/lenses/abuse.ts`). An era only "trips"
toward a support frame when *severe volume, who initiates, and coercive markers* **all** point the same
way past a threshold — and the overall stance is a recency-weighted blend of the eras. That means a real
and common pattern is: **some eras trip toward one person needing support while the middle of the
relationship stays genuinely two-sided.** A recent support-shaped era does **not** retroactively recast
the earlier mutual years as one-sided, and a mostly two-sided history does not erase a recent era that
tips. Read the direction as *a claim about a season*, tied to its dates — and note that when the tool's
underlying honesty check hasn't been run for this owner (see §0), every directional claim is provisional
and should be read as "not yet tuned to this person."

## 11. Limitations — read this before you act on anything

This is the section to keep in front of you. The rest of the document earns its keep only if this part
lands.

- **It is a fraction of the conversation.** SMS/MMS text only. iMessage, RCS, calls, voice notes, and
  everything said face to face are absent. Whole reconciliations and whole ruptures can live entirely in
  the gaps. Every claim in the pack is a claim about *the visible slice*, not the marriage.
- **The counts are deterministic pattern matches, not judgements.** Findings A–E are regex tallies (§9).
  They have no understanding of sarcasm, quotation, or intent beyond a few hand-built exclusions. They
  under-count oblique language and over-count dramatic language. **Weigh, don't tally** (§10).
- **The editorial one-liners are heuristics, not clinical conclusions.** *"She claims them more than she
  shares them," "you reached more and were burned more,"* and the rest are captions generated from counts.
  No clinician wrote them; no model even wrote them. Do not quote them as findings.
- **The directional stance is seasonal and calibration-dependent.** It is per-era, recency-weighted, and
  it leans on the owner having labeled their *own* worst messages honestly. If that calibration was done
  defensively — or was never done at all — the tool can produce a fully evidenced, wrong direction (§0).
  When the pack says the calibration was not run, treat the direction as unverified.
- **The safety banner is US-only and unlocalized.** The crisis line that ships is **988** (US). The tool
  does **not** localize resources to the reader's country. If you or the client are outside the US,
  substitute your own jurisdiction's crisis and support numbers yourself; the packet will not do it (§5).
- **Nothing here is a diagnosis, a verdict, or advice.** The tool never names a person as an abuser,
  never says who was right, and never says stay or leave. Neither should the packet be read as doing so.
  It is a mirror held up to a partial record — most useful as a source of *questions to bring into the
  room*, not answers to carry out of it.

The single instruction that covers all of the above: **when a number or a sentence in the pack matters,
open the messages underneath it and read them yourself.** The tool is built so you always can — every
claim it shows resolves to real message ids. Its honesty depends on that habit; so does yours.
