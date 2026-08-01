---
description: Write a gauntlet-schema plan to ~/.claude/plans/<repo>/NNN-<slug>.md; optional panel or single-lens review
argument-hint: "[--review panel|grok|codex|glm] [--slug SLUG] [--repository NAME] [--model PROVIDER/MODEL] [--thinking LEVEL] [--] <brief>"
---

# /plan — gauntlet plan generation (parent orchestration)

Generate a standalone implementation plan for the active Git repository (or an explicit `--repository` name) and write it to the shared plans location. **Only the parent agent may edit plan files or the worktree.**

## Non-overridable constraints

These rules apply even when target-project instructions suggest otherwise:

- Reviewers must not edit, write, bash, commit, or mutate the worktree.
- Do not guess plan paths from unrelated recent files when reviewing — use the active plan named in conversation or an explicit path.
- Re-capture plan/repo fingerprints before applying reviewer feedback; flag drift if the plan or worktree changed during review.
- Report the final plan fingerprint to the user in the parent summary — do not embed a self-referential hash line inside the plan body.

## Command collision awareness

Short global slash commands may collide with other Pi packages. Pi resolves collisions by **first-discovered wins** — whichever prompt resource loads first owns the slash name. If `/plan` resolves to a different template than this one, **disable or reorder the competing prompt resource** in Pi config so this package registers first. Do not rely on numeric suffixes or session reload to fix collisions.

## Argument parsing

Parse arguments deterministically:

1. Recognized flags (`--review`, `--slug`, `--repository`, `--model`, `--thinking`) may appear **only before** an optional `--` delimiter.
2. Everything after `--` is the brief verbatim (may contain text that looks like flags).
3. If no `--` is present, trailing positional tokens form the brief; reject unknown tokens before the brief as unknown flags.
4. Validate: duplicate flags error; `--review` requires a value (`panel|grok|codex|glm`); unknown flags error; missing brief errors.
5. Derive slug from `--slug` when set, else from the brief text (sanitized). Pass **only** `--slug` and/or `--repository` to `allocate-plan.mjs` — never forward `--review`, `--model`, `--thinking`, or raw brief/options the helper does not accept.

## Model routing and overrides

Resolve model and thinking for **each plan review subagent** using this precedence (first match wins):

1. Explicit flags on this command: `--model PROVIDER/MODEL` and/or `--thinking LEVEL`
2. Composed-workflow stage overrides (when invoked from a future gauntlet/gated workflow)
3. Review-mode defaults (below)
4. Parent's current model/thinking (fallback only)

`--model` accepts `provider/model`.
`--thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

Review-mode defaults when `--review` is set:

| Mode | Agent | Default model | Default thinking |
| --- | --- | --- | --- |
| `panel` (feasibility) | `px-plan-feasibility-reviewer` | `openai-codex/gpt-5.6-sol` | `high` |
| `panel` (risk) | `px-plan-risk-reviewer` | `cursor/grok-4.5` | `high` |
| `panel` (alternatives) | `px-plan-alternatives-reviewer` | `zai-coding-cn/glm-5.2` | `high` |
| `grok` | `px-plan-risk-reviewer` | `cursor/grok-4.5` | `high` |
| `codex` | `px-plan-feasibility-reviewer` | `openai-codex/gpt-5.6-sol` | `high` |
| `glm` | `px-plan-alternatives-reviewer` | `zai-coding-cn/glm-5.2` | `high` |

**Cost disclosure:** `--review panel` launches **three concurrent high-reasoning reviews** (Sol, Grok, GLM). Tell the user when starting if defaults apply.

## Package root resolution

Resolve `PI_EXT_ROOT` before running helpers:

1. `PI_EXTENSIONS_ROOT` environment variable when set
2. Else `packageRoot` from `$PI_CODING_AGENT_DIR/pi-extensions-managed-agents.json` (default agent home: `~/.pi/agent`)
3. Else abort with instructions to sync agents or set `PI_EXTENSIONS_ROOT`

Scripts live under `$PI_EXT_ROOT/scripts/`. Honor `PI_PLANS_DIR` (default `~/.claude/plans`) via `allocate-plan.mjs`.

## Plan location

Before default allocation, inspect target-project instructions (for example `CLAUDE.md`, `AGENTS.md`, or repo-specific planning docs) for an **explicit plan location override**. When found, write to that location instead of the default layout.

Otherwise allocate with the deterministic helper (exclusive lock, next three-digit number, sibling artifact directory):

```bash
node "$PI_EXT_ROOT/scripts/allocate-plan.mjs" [--slug SLUG] [--repository NAME]
```

Pass only recognized helper flags plus a derived slug — not the full brief or workflow flags. The helper prints two lines: `planPath` then `artifactsDir`. Default layout:

```text
~/.claude/plans/<primary-repo>/NNN-<slug>.md
~/.claude/plans/<primary-repo>/NNN-<slug>/
```

Outside a Git repository, pass `--repository <name>` or allocation fails with a useful error.

## Required plan schema

Write the full plan to `planPath` using this structure (fill every section; use `file:line` evidence in verified current state):

1. **Title and status** — include plan id (`NNN-<slug>`) and review state.
2. **Problem and motivation**
3. **Verified current state** — file:line citations from the target repository
4. **Pinned design decisions** — include rejected alternatives where relevant
5. **Deviations and non-goals**
6. **Work breakdown** — gated commits with file lists
7. **Indicative file map**
8. **Acceptance criteria** — measurable, testable
9. **Verification plan**
10. **Risks, open items, and future work**

When `--review` is used, leave a **Panel dispositions** (or single-reviewer dispositions) section ready for the parent to fill after review.

## Pre-review fingerprint

Before launching reviewers, record:

- Plan path and a hash or concise fingerprint of the plan body (re-read after generation).
- **Required** target-repository fingerprint: `node "$PI_EXT_ROOT/scripts/capture-scope.mjs"` run from the plan's target repo (or with `--cwd` when reviewing against a different checkout).

## Review modes (`--review`)

Parse `--review panel|grok|codex|glm` from arguments. If omitted, generate only — no subagents.

### Panel (`--review panel`)

Launch exactly these three `@tintinweb/pi-subagents` agents **concurrently** with the resolved models/thinking:

| Agent | Lens | Default routing |
| --- | --- | --- |
| `px-plan-feasibility-reviewer` | feasibility / implementability | Sol/high (`openai-codex/gpt-5.6-sol`, `high`) |
| `px-plan-risk-reviewer` | risk / failure modes | Grok/high (`cursor/grok-4.5`, `high`) |
| `px-plan-alternatives-reviewer` | alternatives / trade-offs | GLM/high (`zai-coding-cn/glm-5.2`, `high`) |

Set `run_in_background: true` on all three calls and emit all three `Agent` calls in **one tool message** so they actually run concurrently. Collect results in **one parallel batch** of `get_subagent_result` calls with `wait: true` for each returned subagent id — do not poll repeatedly or collect sequentially.

### Single-lens modes

Launch exactly one agent:

- `--review grok` → `px-plan-risk-reviewer`
- `--review codex` → `px-plan-feasibility-reviewer`
- `--review glm` → `px-plan-alternatives-reviewer`

Use `run_in_background: false` unless the user asked otherwise.

### Child prompt shape

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
2. **Disposition every finding** — none may be silently dropped. Record: id, reviewer, severity, disposition (`adopted` | `adapted` | `rejected` | `deferred`), and rationale.
3. Update the plan file to reflect adopted/adapted items (pinned decisions, work breakdown, risks, verification).
4. Report reviewer models used, disposition summary, and the **final plan fingerprint in the parent message** (not inside the plan body).
5. Tell the user the plan path, artifact directory, review cost, partial failures (if any), and drift warnings.

Arguments: ${@:-"(brief required after optional flags or `--`; optional --review panel|grok|codex|glm, --slug, --repository, --model, --thinking)"}
