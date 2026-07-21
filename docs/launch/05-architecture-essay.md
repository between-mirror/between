# Skeleton — the architecture essay

**Status: NOT WRITTEN, NOT POSTED.** This is an outline with the load-bearing beats and the specifics
each one needs. It is worth writing properly, in one sitting, in the author's own voice — an essay
assembled from bullet points reads like one.

**Venue:** own blog or DEV first. Once it stands on its own it can be submitted to HN or Lobsters as
an essay — which is a completely different act from posting a project, and the one this project has
earned. Show HN still waits for the interactive demo.

**Working title:**
> An adversarial review found my "privacy architecture" was partly convention. Here is how I rebuilt it.

**The thesis, stated once and then demonstrated:**
> A claim may only be as strong as its enforcement. Everything else in this essay is an example.

---

## 1. The setup (short)

What the thing is, in three sentences. Years of your own messages, read locally. Why I did not want to
hand that to a scoring cloud. Do not sell here; the essay is the argument, not the pitch.

## 2. What I believed I had built

The promises as I would have described them before the review: local-first, nothing leaves without
your say, every observation traceable to the messages underneath. All of them true in the sense that I
had implemented them, and all of them enforced by *me remembering to*.

## 3. What the review actually found

Pick three, told concretely — the specifics are the whole essay:

- **The evidence chain had a bypass.** The model returned prose plus a side-list of claims, and one
  path read the raw engine output rather than the cleaned, re-validated payload. So a result that had
  failed validation could still reach a frozen reading. The fix was not more validation: the model no
  longer returns prose at all, only typed blocks whose ids must resolve to real messages, and the app
  composes the text from the survivors.
- **The engine boundary was a convention.** The client asked for an engine and the server obliged;
  an unknown engine name silently ran the test mock. Now the server decides, enforces the owner's
  mode, and refuses anything outside it.
- **The containment claim was too strong for what it did.** "Airlock" implied an architectural
  impossibility. What existed was a protocol plus tool restrictions — good, real, and not the same
  thing. The words changed to match the mechanism, which is the least glamorous fix in the essay and
  possibly the most important.

## 4. The pattern underneath (the part worth reading)

Every one was the same shape: **a true statement that nothing was keeping true.** Not a bug, not
negligence — a claim whose enforcement was me. Which means the interesting question is not "was it
secure" but "what happens when I am tired, or gone, or wrong."

Hence the doctrine, and hence the tests: not to prove correctness, but to make regressions *loud*.

## 5. The uncomfortable part

Three things this essay will be much better for including, and much worse for omitting — the audience
worth having will find them anyway:

- **The gender assumption.** The analysis view read "His hostile share" and "She initiates", with a
  tooltip explaining "His" as *your* messages. So the primary surface hard-coded that the archive's
  owner is a man and the other person a woman, on a screen full of claims about their relationship.
  It shipped for months. A tool that reads a marriage's worst hours and then misgenders one of them
  has failed at something more basic than analysis.
- **The hardening that destroyed access.** Boot-time file-permission tightening on Windows applied
  inheritance flags to *files*, where they are inert, after stripping every inherited entry — and
  reported success. It rendered a database unreadable by its own owner. The security feature was the
  thing doing the damage, and it said `ok: true` while doing it.
- **The test that proved nothing.** After fixing the gender bug I added a sweep to keep it fixed. It
  passed 44/44 while the words were still on screen, because it only read quoted attributes and
  skipped any text containing braces — which is most real interface copy. Meanwhile the status page
  said the fix was done *and enforced by test*. That is the thesis of this essay, committed by the
  release whose entire purpose was to stop doing it.

## 6. What I would tell someone building near this

- Write the claim down first, then ask what would fail if it stopped being true. If the answer is
  "nothing", it is not a guarantee, it is a habit.
- A test that has never failed has not been tested. Break the thing on purpose and watch.
- Prefer removing the capability to guarding it. The model cannot write unreceipted prose now because
  it cannot write prose — that needs no vigilance from anyone.
- Publish what is still broken. The status page has three buckets — fixed, deferred by design, newly
  tracked — and the third one is never empty. A review is a snapshot, not a certificate.

## 7. Close

Do not end on the product. End on the pattern, and let the link sit quietly at the bottom for whoever
wants it.

---

### Facts to get right when writing

- The review was July 2026; every original finding is fixed with a regression test.
- Do not imply the interpretive layer is validated. It is experimental, off by default, and its
  external clinical review is a future gate — that is the honest state and the essay must not blur it.
- No real archive, ever, in any example. Alex & Jordan or nothing.
