# Audit Context — How to use this

`SKILL.md` in this folder is the **MAD Streamer audit-context skill** — a portable briefing that gives any Claude session working on the MAD codebase the same baseline understanding of the 46-finding May 2026 audit (4 Critical, 10 High, 18 Medium, 14 Low) without having to re-derive it from scratch.

## Install (one minute, one-time)

```bash
mkdir -p ~/.claude/skills/mad-streamer-audit-context
cp SKILL.md ~/.claude/skills/mad-streamer-audit-context/SKILL.md
```

Once installed, any Claude Code / Cowork / Chat session opened in the v2.1 (or any MAD) repo will see the skill listed and can invoke it via `/mad-streamer-audit-context` or have it auto-trigger from filename/content matches.

## What it gives the team

When a developer (or SDClaude, or any other Claude session) starts working on a file in the MAD repo, this skill ensures:

1. **Known blockers don't get re-fixed badly.** The skill names each Critical and High finding by ID (e.g. TKM-H1, PAY-H1, FM-H3) so a Claude session won't propose a fix that's already been merged elsewhere, or — worse — propose a "fix" that re-introduces an audit-flagged anti-pattern.
2. **The principle catalogue is shared.** "Access control fails CLOSED", "session-scoped FM URLs are never persisted", "Paystack signatures verify via `timingSafeEqual`" — these are stated as principles the team has already adopted, not invitations to re-debate.
3. **Drift detection.** When a new change conflicts with an audit principle (e.g. someone adds a route that mints a token without HMAC auth), the skill flags it as a regression rather than treating it as a new question.

## How to keep it current

After each completed audit cycle (quarterly is the suggested cadence — every milestone release at minimum), run a delta pass and update `SKILL.md` in place: add new findings, mark resolved ones, update the principle list if practice has changed. Commit the updated file alongside the code change that closed the finding.

## Why ship this with v2.1

The v2.1 codebase has every Critical/High blocker the audit identified except PAY-H1 (Paystack signature verification — that one was fixed). Without the audit-context skill installed, SDClaude or anyone else working on v2.1 has no built-in awareness of the 46 known findings — they will rediscover them slowly and inconsistently, or worse, write new code that trips them.

The skill is not a substitute for actually fixing the blockers, but it makes sure no one accidentally undoes the principles that were derived from them.
