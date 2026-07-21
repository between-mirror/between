# Between — Ethics

Between is a tool for reading your own relationship back to yourself. It is built around one line from
[VOICE.md](VOICE.md): **for understanding, not ammunition.** This document says plainly where the ethical
lines are, because a tool that reads intimate data can do real harm even when the code is correct.

## Local ownership is not relational consent

Between runs on your machine, on an archive you own. That gives you the technical right to analyze it. It
does **not** give you the other person's consent to be analyzed. A text conversation has two authors; the
device it was backed up on has one owner. Between is deliberately single-owner — it reads *your* archive,
for *your* understanding — but the person on the other side of those messages never agreed to be scored,
profiled, or read. That asymmetry is real, and no software setting resolves it.

So the honest framing is this: what you learn here is a mirror for *you*. It is not a finding *about them*
that you are entitled to act on against them. The other-side reading, in particular, is guesswork about a
person's interior — offered so you can understand what you were living with, never as a diagnosis or a
dossier. It is off by default (the experimental layer, P1-11) for exactly this reason.

## Purpose limitation: understanding, not ammunition

The same evidence can be read two ways: to understand a relationship, or to build a case against a person.
Between is built for the first and declines the second:

- Exports are **verbatim messages + an integrity hash** — never Between's readings folded in as if they
  were facts, never a "build a case" document.
- The findings are **counts to weigh, not tally** — N keyword hits is not N incidents, and the tool says so.
- The directional / support reading is **experimental, text-only, and not externally validated**, gated
  off by default, framed as one reading over time — never a verdict admissible as neutral proof.
- The power-balance gate refuses "your part in this" framing only when the signals are one-directional —
  it is a support register, not an accusation engine.

This one line — *for understanding, not ammunition* — is surfaced at the threshold (the first-run
principles card) and carried in the header of every export, so it travels with the document if it ever
leaves your hands.

## What the tool declines to do

- It has **no therapist-operated mode** and no multi-tenant mode. A clinician *receives* a packet if you
  choose to share one; no one runs the tool on someone else's messages.
- It makes **no diagnoses** and applies no clinical nouns to a person.
- It is **not a crisis service** and says so; the 988 line is a floor, not a feature.
- It does **not make sharing frictionless** — because the easiest thing to do with intimate data should not
  be to hand it to someone else.

## If you are the person in the archive

If you are worried that someone is using a tool like this to profile or build a case against you, know
that its exports and readings are not evidence-grade, and its design actively refuses the "neutral proof"
framing. The threat model ([THREAT-MODEL.md](THREAT-MODEL.md)) names the relational-misuse scenarios and
what the product does and declines to do about each.
