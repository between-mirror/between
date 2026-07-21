# Security Policy

Between reads a person's private message archive on their own machine. A security bug here is not
abstract — it could expose the most intimate data someone owns. Reports are taken seriously.

## Reporting a vulnerability

**Please report privately, not in a public issue.** Use GitHub's private vulnerability reporting:

- Go to the **Security** tab of the repository (`github.com/between-mirror/between`) → **Report a
  vulnerability** (GitHub Security Advisories). This opens a private channel visible only to the
  maintainers and you.

If private reporting is not available to you, open a minimal public issue that says only "security
report — please open a private channel" (no details), and a maintainer will follow up.

Please include, as far as you can: what the issue is, how to reproduce it, the affected version/commit,
and the impact you see. A proof-of-concept helps but is not required.

## Scope

In scope — anything that breaks the tool's core privacy promises (see
[docs/PRIVACY-INVARIANTS.md](docs/PRIVACY-INVARIANTS.md) and [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)):

- the read API binding or accepting connections beyond loopback; a DNS-rebinding or cross-origin bypass;
- any egress of message content beyond the three disclosed model paths, or any telemetry;
- a way for a result file to reach a frozen reflection without passing the envelope + schema + evidence
  validation (the airlock evidence chain);
- an escape from the tool-level containment of the subscription drain that reaches the DB, the archive,
  the repo, or the home directory;
- an export that carries anything beyond verbatim message bodies + the integrity hash.

Out of scope — the deliberately-deferred items named in the threat model (at-rest DB encryption; an
OS-level sandbox for the drain), and threats local-first cannot defend against (malware on the machine,
another account/physical access, backup or cloud-sync software, stolen hardware). These are documented,
not bugs.

## Response

This is maintained software, not a company with an SLA. Expect an initial acknowledgement within about
a week, and an honest timeline after triage. Fixes to the core privacy invariants are prioritized over
everything else. When a fix ships, the advisory credits the reporter unless they prefer otherwise.

## Note for maintainers

Private vulnerability reporting must be enabled on the repository (Settings → Code security → Private
vulnerability reporting) for the flow above to work — this is a launch step, not something the code can
turn on for you.
