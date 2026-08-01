---
name: planning
description: Write and review gauntlet-schema implementation plans at ~/.claude/plans/<repo>/NNN-<slug>.md with optional panel or single-lens review. Use for "write a plan", "plan this feature", "review my plan", "panel review the plan", or planning before implementation.
---

# Planning workflow

Use when the user wants to author or review an implementation plan outside the target repository.

## Entry points

- Explicit: `/plan`, `/review-plan`, `/plan-w-panel`, `/plan-w-grok`, `/plan-w-codex`
- Natural language: "write a plan for …", "review this plan", "panel review the plan", "plan with Grok risk review"

When intent is **generation** (new plan from a brief), run the `/plan` workflow — allocate, write schema, optionally review.
When intent is **review only** (existing plan), run `/review-plan MODE [path]` — do not regenerate from scratch.

There is **no** `/plan-w-glm` alias; use `/plan --review glm` or `/review-plan glm` for GLM alternatives review.

## Package root

Resolve `PI_EXT_ROOT`: `PI_EXTENSIONS_ROOT` env → `packageRoot` in `$PI_CODING_AGENT_DIR/pi-extensions-managed-agents.json` (default `~/.pi/agent`) → abort if unknown. Run helpers from `$PI_EXT_ROOT/scripts/`.

## Plan path resolution

1. **Explicit** path argument or user-provided path — use when given.
2. **Active** plan named in conversation — use when reviewing without an explicit path.
3. **Ask** — when neither resolves, ask the user; do not guess from unrelated recent files.

For **new** plans: inspect target-project instructions (`CLAUDE.md`, `AGENTS.md`, etc.) for an explicit plan location override before default allocation. Otherwise:

```bash
node "$PI_EXT_ROOT/scripts/allocate-plan.mjs" [--slug SLUG] [--repository NAME]
```

Pass only helper flags plus derived slug — not workflow flags or raw brief text. Writes `~/.claude/plans/<repo>/NNN-<slug>.md` plus sibling artifact directory. Honors `PI_PLANS_DIR`.

## Argument parsing (`/plan`)

Recognized flags before optional `--`; brief after delimiter (may contain `--`-like text). Validate duplicates, unknown flags, and missing brief. Derive slug from `--slug` or brief.

## Required schema

Plans must include: motivation, verified current state (file:line), pinned decisions and rejected alternatives, non-goals, gated work breakdown, file map, acceptance criteria, verification plan, risks/open items. After review, add dispositions.

## Review mode selection

| User intent | Default action |
| --- | --- |
| "write a plan" / brief only | Generate only (no `--review`) |
| "panel review" / `/plan-w-panel` | `--review panel` |
| "Grok review" / `/plan-w-grok` | `--review grok` |
| "Codex review" / `/plan-w-codex` | `--review codex` |
| "review this plan" without mode | Ask which mode (`panel`, `grok`, `codex`, `glm`) unless context makes it obvious |

| Command | Review |
| --- | --- |
| `/plan <brief>` | Generate only |
| `/plan --review panel\|grok\|codex\|glm <brief>` | Generate + review |
| `/review-plan MODE [path]` | Review existing/active plan |
| `/plan-w-panel` | Same as `--review panel` |
| `/plan-w-grok` | Same as `--review grok` |
| `/plan-w-codex` | Same as `--review codex` |

**Panel:** three concurrent subagents in one message (`run_in_background: true`): `px-plan-feasibility-reviewer` (Sol/high), `px-plan-risk-reviewer` (Grok/high), `px-plan-alternatives-reviewer` (GLM/high). Collect in one parallel batch of `get_subagent_result` with `wait: true`.

**Single lens:** one matching agent per mode defaults above.

## Model routing

Per reviewer, first match wins: `--model` / `--thinking` flags → composed-workflow overrides → mode defaults → parent model fallback. No per-role CLI flags; agent frontmatter never pins models.

## Fingerprint and drift

Fingerprint plan body and **required** target-repo scope (`capture-scope.mjs`) before review. Immediately after reviewers return and before parent edits, re-read plan and re-run capture-scope; flag drift and do not apply stale findings. Reviewers report only — parent alone edits the plan. Report final plan fingerprint in the parent message, not inside the plan body.

## Partial failures

Continue with successful reviewers; report failures and malformed output; disposition only findings from successful runs unless user confirms retry.

## Prerequisites

- `@tintinweb/pi-subagents` and `pi-cursor-sdk` installed as Pi packages
- px agents synchronized: `npm run sync-agents` from the pi-extensions checkout
