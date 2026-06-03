---
name: mad-streamer-audit-context
description: >
  Project-specific build-guideline skill for the MAD (Music Africa Direct) streamer.
  Captures the prior-session backend audit findings (46 across FM/Auth, Payments,
  Downloads/Telkom), the GTM sprint workflow, design principles, and the priority-
  sequenced remediation backlog. Use whenever working on the MAD streamer codebase
  at /Users/tawandamujaji/Desktop/Claude-Context/projects/MAD - Streamer Build/
  MadMusicV3.0/ — especially before touching FM auth, payments, downloads, or
  Telkom integration. Trigger on "MAD streamer", "Telkom integration", "Paystack
  webhook", "FM auth", "audit finding", "PAY-H1/FM-H3/DL-H2/TKM-H1" or any
  reference to the GTM sprint backlog. Maps audit IDs to files/lines and shows
  the cross-cutting design principles distilled from the findings.
---

# MAD Streamer — Audit Context & Remediation Guide

The MAD streamer has been through **3 full back-end audits** (May 2026) before
any frontend rebuild was attempted. **46 findings** were documented but not all
have been remediated. This skill is the index + decision support for that work.

## Critical context — what you must know first

**The single most important finding across all audits:**
**TKM-H1 — Telkom webhook endpoints had NO authentication.** Anyone hitting
`POST /api/telkom/subscription` could mint subscription tokens for arbitrary
phone numbers. **This is a go-live blocker for Telkom integration testing**
unless TKM-H1 (HMAC-over-body + IP allowlist) is shipped first.

**Resolved decision D-001:** HMAC-over-body primary + IP allowlist
defense-in-depth. Mirrors `lib/paystack.js` verification.

## Where the audit lives

Inside the repo (added 2026-05-21):
```
docs/audit-may2026/
├── MAD_FM_Auth_Audit.md           16 findings (3H/7M/6L)
├── MAD_Payments_Audit.md          14 findings (4H/6M/5L)
├── MAD_Downloads_Telkom_Audit.md  16 findings (incl. TKM-H1)
├── SESSION_STATE.md               Where the prior session stopped + protocol
├── TEAM_KICKOFF.md                GTM sprint workflow (branches, PR titles, CI)
├── MAD_Audit_Tracker_v2.xlsx      Full 47-row priority-sequenced backlog
└── MAD_Audit_Executive_Report_v2.docx
```

When working on this project: **read TEAM_KICKOFF.md and SESSION_STATE.md first**.

## Top-of-stack High-severity findings (the GTM sprint backlog)

| Rank | ID | Severity | Issue | Effort | Module |
|---|---|---|---|---|---|
| 1 | PAY-H1 | High | Webhook signature uses `===` not `timingSafeEqual` | S (5 min) | `lib/paystack.js:89-95` |
| 2 | FM-H3 | High | Stale-grace honours revoked tokens (fail-open) | M | `lib/auth.js`, `routes/access.js` |
| 3 | DL-H2 | High | Download endpoint has no rate limit / no ref expiry | M | `routes/download.js:152-195` |
| 4 | TKM-H1 | High | Telkom webhooks have NO auth — free-token API | M | `routes/telkom.js` |
| 5 | PAY-H2 | High | Trial-token-by-email race condition | S + FM batch | `routes/payments.js`, `lib/token-store.js` |
| 6 | FM-H2 | High | Middleware doesn't pass sessionId to validateAccessToken | M | `server.js:242` |
| 7 | FM-H1 | High | Token expiry timezone math is wrong | S | `lib/auth.js:53-77,127-134` |
| 8 | DL-H3 | High | Duplicate purchase records from callback-vs-webhook race | M + FM batch | `routes/download.js` |
| 9 | PAY-H4 | High | Subscription-token-by-code race | S + FM batch | `routes/payments.js` |
| 10 | DL-H1 | High | `Status: 'complete'` substring-matches refunded states | S | `routes/download.js:40-46` |

**The FM batch** — five separate races (PAY-H2, PAY-H4, DL-H3, TKM-M1, FM-M4)
all close with a single FileMaker admin task: unique-validation constraints on
`API_Access_Tokens.Email` (when Token_Type='trial'), `Subscription_Code`,
`API_Download_Purchases.Paystack_Reference`, `API_Users.msisdn`.

## Three cross-cutting design principles (codified from the findings)

### Principle 1 — No check-then-act races
Pattern: read FM to see if a record exists, then write a new one without holding
a lock. Race between two requests = duplicate records.
**Build requirement:** FM unique-validation constraint on the natural key + a
narrow JS lock in the meantime. Never trust check-then-act for money-path
inserts.

### Principle 2 — Access control fails CLOSED
Pattern: token validation cache + stale-grace + "FM unreachable means trust the
cache" — this honours revoked tokens during FM outages.
**Build requirement:** Distinguish "source said no" (deny immediately) from
"source unreachable" (limited stale-grace, with telemetry). The default must
be DENY on uncertainty, not allow.

### Principle 3 — No silent failures on money paths
Pattern: customer pays, downstream FM write fails, response says 200, no
recovery path. Money received, access not granted, no alarm.
**Build requirement:** try/finally to revert in-progress state.
`alert.fire(...)` (Slack webhook) on every money-path failure. Distinguish
"customer-not-charged" from "customer-charged-but-not-provisioned."

## GTM sprint workflow (per TEAM_KICKOFF.md)

- Branch naming: `fix/{finding-id}-{slug}` (e.g. `fix/pay-h1-timing-safe-signature`)
- Telkom branches: `feat/telkom-{component}`
- PR titles: `[{Finding-ID}] short summary` (CI enforces the regex)
- Telkom rebuild gated by `TELKOM_AUTH_MODE` env flag — stopgap stays in staging until PartnerHUB confirms HMAC support
- Tools: Sentry (exception tracking), Slack `#mad-alerts` + `#mad-build`, GitHub Issues + Actions CI, MCP connectors
- Append-only `docs/DECISIONS.md` for architecture decisions; `[PROPOSED]` prefix for drafts

## Working protocol (Tawanda's Step 0–4)

Used throughout the audits and explicitly preserved in `SESSION_STATE.md`:

- **Step 0 — Stakes calibration**
- **Step 1 — Context acquisition** (internal first, external only when needed)
- **Step 2 — Accumulative reasoning** (2-3 viable approaches, pick one, name discards)
- **Step 3 — Verification** (fact / logic / context / completeness; **discard explicitly**)
- **Step 4 — Synthesis** (clean output, machinery invisible)

Every audit finding format: Severity · Location · What's wrong · Why it
matters · Suggested fix. Rejected approaches named explicitly.

## What's been built ON TOP of the un-remediated audit (v3.0 → v3.1)

The frontend rebuild (carousel hero, 4 sub-projects, inline video, etc.)
landed on top of the unaddressed audit backlog. **This is a gap.** v3.1's
visual + new-features work is separate from the audit remediation that should
gate Telkom integration testing.

## When to use this skill — flowchart

```
Working on MAD streamer?
├─ Touching FM auth, payments, downloads, or Telkom?
│  └─ READ docs/audit-may2026/<relevant>.md FIRST. Most bugs you'll find are
│     already documented with IDs.
├─ Building a feature on a money path?
│  └─ Apply Principles 1-3 above. No check-then-act. Fail closed. No silent
│     money-path failures.
├─ Telkom integration work?
│  └─ TKM-H1 + D-001 are blocking. Read MAD_Downloads_Telkom_Audit.md and the
│     "Telkom Integration" section of BUILD_SPEC.md (if present).
└─ General refactor / new feature?
   └─ Check the tracker (MAD_Audit_Tracker_v2.xlsx) before assuming the existing
      code is good. ~37 production findings still open.
```

## Forbidden / anti-patterns specific to MAD

- Don't use `===` on HMAC outputs (always `crypto.timingSafeEqual`).
- Don't trust JS-side check-then-act for trial-token / subscription-token / purchase / MSISDN inserts.
- Don't fail open on FM unreachable — distinguish source-said-no from source-unreachable.
- Don't return 200 from money paths without verifying downstream state landed.
- Don't write live credentials to any committed file. Rotate exposed secrets when migrating envs.
- Don't deploy Telkom integration without TKM-H1 fix.

## Related skills

- `streaming-reference-architectures` — Netflix Zuul (gateway), YouTube Doorman (rate limiting), Netflix Chaos Monkey (resilience testing). The audit's Principles 1-3 map directly to those patterns.
- `subagent-driven-development` + `writing-plans` (Superpowers) — methodology for executing the GTM remediation sprint task-by-task.
- `bencium-code-conventions`, `vanity-engineering-review` — guardrails when applying fixes.
