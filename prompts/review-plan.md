---
description: Review an existing or active plan with panel or single-lens reviewers; parent records dispositions
argument-hint: "panel|grok|codex|glm [--model PROVIDER/MODEL] [--thinking LEVEL] [PLAN_PATH]"
---

# /review-plan — plan review only (parent orchestration)

Review an **existing** plan without regenerating it from scratch. **Only the parent agent may edit the plan file or worktree.** This prompt is self-contained — do not invoke another slash command or defer to `/plan`.

## Non-overridable constraints

- Reviewers must not edit, write, bash, commit, or mutate the worktree.
- Do not guess plan paths from unrelated recent files — resolve the plan explicitly (below).
- Re-capture plan/repo fingerprints before applying reviewer feedback; flag drift if the plan or worktree changed during review.
- Report the final plan fingerprint to the user in the parent summary — do not embed a self-referential hash line inside the plan body.

## Plan selection

Resolve the plan path in this order:

1. Explicit `PLAN_PATH` argument when provided (must exist).
2. Else the **active plan named in conversation** (path the user or parent is working from).
3. Do **not** guess from unrelated recent files in `~/.claude/plans`.

If no plan can be resolved, ask the user for a path.

## Review mode (required)

First positional argument must be one of: `panel`, `grok`, `codex`, `glm`.

| Mode | Behavior |
| --- | --- |
| `panel` | Three concurrent reviewers in one tool message, all `run_in_background: true` |
| `grok` | Single `px-plan-risk-reviewer` |
| `codex` | Single `px-plan-feasibility-reviewer` |
| `glm` | Single `px-plan-alternatives-reviewer` |

## Package root resolution

Resolve `PI_EXT_ROOT` before running helpers:

1. `PI_EXTENSIONS_ROOT` environment variable when set
2. Else `packageRoot` from `$PI_CODING_AGENT_DIR/pi-extensions-managed-agents.json` (default agent home: `~/.pi/agent`)
3. Else abort with instructions to sync agents or set `PI_EXTENSIONS_ROOT`

Scripts live under `$PI_EXT_ROOT/scripts/`.

## Model routing and overrides

Resolve model and thinking for **each review subagent** using this precedence (first match wins):

1. Explicit flags on this command: `--model PROVIDER/MODEL` and/or `--thinking LEVEL`
2. Composed-workflow stage overrides (when invoked from a future gauntlet/gated workflow)
3. Review-mode defaults (below)
4. Parent's current model/thinking (fallback only)

`--model` accepts `provider/model`.
`--thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

Review-mode defaults:

| Mode | Agent | Default model | Default thinking |
| --- | --- | --- | --- |
| `panel` (feasibility) | `px-plan-feasibility-reviewer` | `openai-codex/gpt-5.6-sol` | `high` |
| `panel` (risk) | `px-plan-risk-reviewer` | `cursor/grok-4.5` | `high` |
| `panel` (alternatives) | `px-plan-alternatives-reviewer` | `zai-coding-cn/glm-5.2` | `high` |
| `grok` | `px-plan-risk-reviewer` | `cursor/grok-4.5` | `high` |
| `codex` | `px-plan-feasibility-reviewer` | `openai-codex/gpt-5.6-sol` | `high` |
| `glm` | `px-plan-alternatives-reviewer` | `zai-coding-cn/glm-5.2` | `high` |

**Cost disclosure:** `panel` launches **three concurrent high-reasoning reviews** (Sol, Grok, GLM). Tell the user when starting if defaults apply.

## Pre-review fingerprint

Before launching reviewers:

- Record plan path and fingerprint (hash or stable summary of current plan body).
- **Required** target-repository fingerprint: `node "$PI_EXT_ROOT/scripts/capture-scope.mjs"` run from the plan's target repo.

## Panel review (`panel`)

Launch exactly these three `@tintinweb/pi-subagents` agents **concurrently**:

| Agent | Lens | Default routing |
| --- | --- | --- |
| `px-plan-feasibility-reviewer` | feasibility / implementability | Sol/high (`openai-codex/gpt-5.6-sol`, `high`) |
| `px-plan-risk-reviewer` | risk / failure modes | Grok/high (`cursor/grok-4.5`, `high`) |
| `px-plan-alternatives-reviewer` | alternatives / trade-offs | GLM/high (`zai-coding-cn/glm-5.2`, `high`) |

Set `run_in_background: true` on all three calls and emit all three `Agent` calls in **one tool message**. Collect results in **one parallel batch** of `get_subagent_result` calls with `wait: true` for each returned subagent id — do not poll repeatedly or collect sequentially.

## Single-lens modes

Launch exactly one matching agent with mode defaults above. Use `run_in_background: false` unless the user asked otherwise.

## Child prompt shape

```text
Plan path: <absolute path>

Plan contents:
<full plan markdown or bounded excerpt>

Repository: <name or git root>

Focus: <focus text or none>

Instructions: Report only. Do not edit. Return verdict and structured findings per your agent charter.
```

## Partial failures

If one or more reviewers fail, timeout, or return malformed output:

- Continue with successful reviewers.
- Report which agents failed and include error snippets.
- Do not adopt findings from failed reviewers without user confirmation.
- Offer to retry failed reviewers once if the user wants.

## Parent synthesis and plan update

1. **Before parent edits**, re-read the plan and compare to the pre-review fingerprint; re-run `capture-scope.mjs` on the target repo. If either changed, flag drift and do not apply stale findings.
2. **Disposition every finding** — none may be silently dropped. Record: id, reviewer, severity, disposition (`adopted` | `adapted` | `rejected` | `deferred`), and rationale in the plan's Panel dispositions section (or single-reviewer dispositions).
3. Update the plan file to reflect adopted/adapted items (pinned decisions, work breakdown, risks, verification).
4. Report reviewer models used, disposition summary, and the **final plan fingerprint in the parent message** (not inside the plan body).
5. Summarize verdicts, dispositions, partial failures, review cost, and drift warnings.

Arguments: ${@:-"(mode panel|grok|codex|glm required; optional PLAN_PATH, --model, --thinking)"}
