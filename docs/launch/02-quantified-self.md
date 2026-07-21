# Draft — Quantified Self forum

**Status: NOT POSTED.**

**Why this venue:** the question is genuinely open and this is the community that has thought hardest
about it. Post it as a question, not a product. If the discussion never mentions the tool again, that
is a good outcome.

---

**Title:** What should a personal-data tool be allowed to infer about you?

---

I spent a while building something that reads your own SMS archive — counts, rhythms, spans, and
optionally a model reading the actual text — and the hardest problems turned out not to be technical.
I would like to put the design questions to this group, because I do not think I have them right.

**1. Where does counting stop and interpreting start?**

"You sent 412 messages in April" is a fact. "You were pulling away in April" is an interpretation
wearing a fact's clothes. My current rule is that observations are stated plainly and interpretations
are always offered with an alternative beside them — *one reading is that you were pulling away;
another is that spring is busy.* But "who reached out first" is already an interpretation dressed as
arithmetic: it depends entirely on what counts as a conversation boundary, and I picked that number.

**2. Should a tool tell you something you did not ask about?**

If a pattern is visible in the data — someone's messages getting shorter over three years — is
surfacing it unprompted a service or an ambush? I currently require you to ask for a reading and show
a cost estimate first, partly for capacity reasons and partly because I could not defend surfacing it
unasked. But that also means the thing most worth seeing is the thing you have to think to look for.

**3. What is the ethical status of the other person?**

They never consented to being analysed. They are half of every conversation in the archive. I landed
on: no diagnostic language about anyone ever, no scoring a person, exports are verbatim messages
only with no readings attached, and no feature that helps you build a case. But "I did not build a
weapon" is a weaker claim than I would like, because the data is still there and someone determined
will read it their own way.

**4. How do you keep a mirror from becoming a mood?**

Re-reading your worst arguments is not obviously good for anyone. There is a check-in after repeated
visits to an ended thread — *you've sat with this one a few times lately; is it giving you anything
back?* — which is the most paternalistic thing in the whole design, and I still do not know if it is
right.

**5. Coverage, which turned out to be the sharpest one.**

An unscored message reads as neutral. So a thread the model has read 60% of does not look
half-read — it looks *calm*. I now refuse to draw the model layer below 95% coverage and say which
layer you are looking at, in both directions. Every partial-analysis tool I have used has this
problem and none of them mention it, which makes me think I am missing why.

Not selling anything; there is no signup and nothing to buy. If it is useful to see what these
choices look like implemented, it is AGPL at
<https://github.com/between-mirror/between> — but I am more interested in where you think the lines
belong than in the code.
