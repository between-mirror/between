// Between — human-facing copy. VOICE is DATA, not code (HANDOFF invariant 7).
// Every string tagged `verbatim` is copied EXACTLY from docs/VOICE.md §6 and must
// not be paraphrased. Strings tagged `ui` are neutral interface labels (not voice
// prose); if a proper VOICE string is later authored for one, swap it in here.
//
// TODO(voice): no dedicated microcopy exists yet for a coverage badge label or the
// per-thread persistent caveat bar. We reuse the onboarding data-incompleteness
// caption (verbatim) for the caveat text, and a neutral "Partial record" label.
// Flag to Fable if a purpose-built string is wanted.
//
// TODO(voice): VOICE §6 does not cover Phase-0 browse chrome. The following
// interim strings are authored in-register (calm, unhurried, no BI-speak) but
// should be reviewed / replaced by Fable: button labels ("Continue", "Search",
// "Latest", "Conversations", "Filter people", scope "This conversation"/
// "Everyone"), browse loading/error states ("Opening the years…", "Reaching
// back…", "The beginning of this conversation", "Looking…", "Nothing matches
// that yet.", the search placeholder, and the load/network error lines).

export const VOICE = {
  // Onboarding — the awe sequence (VOICE §6, verbatim)
  parsingLine: 'Reading quietly. Nothing leaves this machine.',
  /** Template — fill {years}/{message_count}/{contact_count}. */
  revealTemplate: '{years} years. {message_count} messages. {contact_count} people.',
  disclosures: [
    "This archive holds SMS and MMS only. iMessage and RCS aren't here — some conversations will look quieter than they really were.",
    'This is a mirror, not a verdict. You are the expert on your life.',
    "Deep readings use your Claude subscription and take real time. You'll always see an estimate first.",
  ] as const,

  // First-run principles (VOICE §6 / GAMEPLAN §6, verbatim, middot-separated)
  firstRunPrinciples: [
    'This is a mirror, not a verdict',
    'You are the expert on your life',
    'For understanding, not ammunition',
    'Reflection, not rumination',
    'Your data stays with you',
    'Not a therapist',
    'This archive may be missing iMessage/RCS',
    'Deep readings cost real capacity and take time',
  ] as const,

  // Empty / loading states (VOICE §6, verbatim)
  noThreadSelected: 'Pick a person. The years are ready.',
  awaitFirstAnalysis: 'The charts are counting. The reading comes when you ask for it.',
  momentsHeader: 'Worth remembering',

  // Coverage caveat — reuse the verbatim incompleteness caption as the caveat body.
  coverageCaption:
    "This archive holds SMS and MMS only. iMessage and RCS aren't here — some conversations will look quieter than they really were.",
  coverageLabel: 'Partial record', // ui label (not voice prose)

  // ── Calibration (P2 — hold-out labeling; honesty is load-bearing, VOICE §6 verbatim) ──
  calibrationIntro:
    "This tunes the reading to you — and it only works if you're honest, especially about your own hardest messages. Score your words as harshly as you'd score the same words from them. A gentle-on-yourself calibration produces a comforting, wrong answer.",
  /** Rubric v1, superseded by calibrationItemHintV2. Kept because v1 calibrations remain in force. */
  calibrationItemHint: "Whose is this — and how does it actually land, not how you'd defend it?",

  // ── Calibration rubric v2 (VOICE §6, verbatim) ────────────────────────────
  // v1 asked how bad a message was, which is a judgement of intent — the axis where a defensive
  // labeller has the most room. v2 asks what is visible in the words. The honesty imperative above
  // is unchanged: it was the part that worked.
  calibrationItemHintV2: 'What is actually in these words? Not how you meant it — what it says.',
  calibrationSkip: "Can't tell (s)",
  calibrationReviewHeader: 'Where the reading and you disagree',
  calibrationReviewIntro:
    'On these, the tool read your archive differently than you did. Nothing is settled until you '
    + 'say so — look at them, and change any label you want to change.',
  calibrationReviewModelHarder: 'The tool called this a hard message. You didn’t.',
  calibrationReviewOwnerHarder: 'You called this a hard message. The tool didn’t.',
  calibrationReviewConfirm: 'These are right — save my calibration',
  calibrationReviewAdjust: 'Let me change some',
  calibrationReviewNone: 'The tool read every one of these the same way you did. Nothing to reconsider.',
  calibrationBiasLenient:
    "You marked your own hard messages more gently than your partner's. That's the common human tilt — so this reading leans on the model's own eyes, not just your labels, and holds the frame more neutral.",
  calibrationBiasClean: 'Your calibration weighed both sides evenly. Read the reading as one perspective to review, not a verdict.',
  calibrationBiasSelfCritical:
    "You marked your own hard messages at least as harshly as your partner's — the uncommon direction. Read the reading as one perspective to review and consider, not a verdict.",
  calibrationBiasInsufficient:
    "Not enough model-hostile messages on both sides to measure how your labels and the model's read compare. The reading stays cautious and holds the frame more neutral.",

  // ── Analysis & drain (VOICE §6, verbatim) ─────────────────────────────────
  /** Template — fill {window_count}/{drain_count}/{time_estimate}. */
  estimateTemplate:
    'This will read {window_count} stretches of conversation — about {drain_count} sittings, roughly {time_estimate}. Nothing is ever read twice.',
  begin: 'Begin the reading',
  decline: 'Not now',
  /** Template — fill {done}/{total}. */
  drainProgressTemplate: 'Reading {done} of {total}. You can leave — this picks up where it stopped.',
  /** Template — fill {new_count}/{cached_count}. */
  drainCompleteTemplate: 'Done. {new_count} new readings, {cached_count} remembered from before.',
  refusedWindow: "Couldn't score this stretch. The messages are still here to read yourself.",
  belowEvidenceFloor: "There isn't enough here yet for an honest reading. A longer range would say more.",

  // ── Evidence & disagreement (VOICE §6, verbatim) ──────────────────────────
  evidencePanelHeader: 'The words underneath',
  rationaleToggle: 'Why the model read it this way',
  confidenceSurer: 'felt fairly sure',
  confidenceLessSure: 'less sure — read it yourself',
  disagree: "That's not right",
  disagreeAck: "Noted. This won't appear again, and future readings will know.",

  // ── First Reflection framing (VOICE §4 exemplar footer, verbatim) ─────────
  // The epistemic footer that closes every first reading (§4 anatomy).
  firstReadingFooter: 'One reading, from the words alone. Texts carry less than half of any conversation.',

  // Grief mode banner — template, fill {name} (VOICE §6, verbatim).
  griefBannerTemplate: 'Remembering {name}. This space is for the warmth — nothing here gets scored.',
} as const;

// ── Interim glue (NOT verbatim VOICE) ────────────────────────────────────────
// VOICE §6 does not yet author copy for the on-demand-drain mechanics of local
// Phase-2 dev (the reading is triggered by the user's /drain-jobs, never a
// background process). These strings are written in-register — calm, unhurried,
// no BI-speak, honest that nothing runs on its own — and MUST be reviewed /
// replaced by Fable. Flagged here so they never masquerade as authored voice.
export const VOICE_INTERIM = {
  // The invite that opens the estimate flow (Overview affordance).
  analyzeInvite: 'Read this closely',
  analyzeInviteSub: 'A close reading of these years — with the exact messages under every line.',
  // Session tab — before any reflection exists.
  reflectionEmptyTitle: 'No reading yet',
  reflectionEmptyBody: 'When you ask for one, a first reading is written here — and frozen, with its receipts.',
  askForReading: 'Write a first reading',
  // Reflection framing line (composed around the frozen letter).
  oneReadingDatedTemplate: 'one reading · generated on {date}',
  // The standing caveat under every reading. A receipt makes a claim inspectable, not correct — the
  // evidence contract stops invention, it cannot stop a true message being cherry-picked, a joke
  // being read flat, or three examples standing in for years. Said here, where someone is actually
  // reading the interpretation, rather than only in a document they will never open.
  receiptsAreNotProof:
    'Open any line to see the messages it rests on. Those messages show where the observation came '
    + 'from — not that it is the only fair reading of them. You were there and this was not.',
  // Drain mechanics — honest that the reading is on-demand, never automatic.
  drainOnDemand: 'The reading happens when you run the drain. It never runs on its own.',
  checkForReadings: 'Check for new readings',
  drainIdleTitle: 'The reading is waiting',
  // Estimate dialog framing.
  estimateTitle: 'Before the reading',
  reflectionEstimateTitle: 'Before a first reading',
  // Loading / error, in-register.
  estimateLoading: 'Counting the stretches…',
  estimateError: 'Could not size the reading just now. The conversation is still here — try again in a moment.',
  reflectionLoadError: 'This reading did not open. It is still saved — try again in a moment.',
  // Evidence panel affordances.
  openInTranscript: 'Open in the transcript',
  showReceipts: 'The words underneath',
  hideReceipts: 'Close the words',

  // First-run empty state — no archive imported yet (distinct from a filter
  // matching nothing). Calm, unhurried; names the one command that starts it.
  firstRunTitle: 'Nothing to read yet.',
  firstRunBody: 'The archive hasn’t been imported. Point Between at your export and it will read the years back to you — quietly, on this machine.',
  firstRunCmdLabel: 'From the repo folder, run:',
  firstRunPhoneHint: 'No export yet? On Android, back up with SMS Backup & Restore, save the XML into data/. iPhone isn’t supported yet.',

  // Filtered-empty — a name filter is active and matched nobody (was the only
  // empty copy; now shown *only* when a filter is set, never on first run).
  noOneByThatName: 'No one by that name.',
} as const;

/** Fill the reveal template, formatting numbers with locale grouping. */
export function revealLine(years: number, messageCount: number, contactCount: number): string {
  return VOICE.revealTemplate
    .replace('{years}', String(years))
    .replace('{message_count}', messageCount.toLocaleString())
    .replace('{contact_count}', contactCount.toLocaleString());
}

/** Fill the capacity-estimate line (VOICE §6, verbatim template). */
export function estimateLine(windowCount: number, drainCount: number, timeEstimate: string): string {
  return VOICE.estimateTemplate
    .replace('{window_count}', windowCount.toLocaleString())
    .replace('{drain_count}', drainCount.toLocaleString())
    .replace('{time_estimate}', timeEstimate);
}

/** Fill the drain-progress line (VOICE §6, verbatim template). */
export function drainProgressLine(done: number, total: number): string {
  return VOICE.drainProgressTemplate
    .replace('{done}', done.toLocaleString())
    .replace('{total}', total.toLocaleString());
}

/** Fill the drain-complete line (VOICE §6, verbatim template). */
export function drainCompleteLine(newCount: number, cachedCount: number): string {
  return VOICE.drainCompleteTemplate
    .replace('{new_count}', newCount.toLocaleString())
    .replace('{cached_count}', cachedCount.toLocaleString());
}

/** Fill the grief-mode banner (VOICE §6, verbatim template). */
export function griefBannerLine(name: string): string {
  return VOICE.griefBannerTemplate.replace('{name}', name);
}
