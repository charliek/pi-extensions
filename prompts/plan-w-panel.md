---
description: Generate a gauntlet-schema plan and review it with Sol, Grok, and GLM concurrently
argument-hint: "[--slug SLUG] [--repository NAME] [--model PROVIDER/MODEL] [--thinking LEVEL] [--] <brief>"
---

# /plan-w-panel — plan plus full panel

Generate and review a plan using the canonical `/plan --review panel` semantics below. This template is self-contained; do not attempt to invoke another slash command.

## Non-overridable constraints

- Reviewers must not edit, write, bash, commit, or mutate the worktree.
- Report the final plan fingerprint to the user in the parent summary — do not embed a self-referential hash line inside the plan body.

## Argument parsing

Recognized flags (`--slug`, `--repository`, `--model`, `--thinking`) appear before an optional `--` delimiter; everything after `--` is the brief verbatim. Validate duplicate/unknown flags; derive slug from `--slug` or brief; pass only `--slug` and/or `--repository` to `allocate-plan.mjs` — never forward workflow flags or raw brief text the helper does not accept.

## Allocate and write

1. Resolve `PI_EXT_ROOT`: `PI_EXTENSIONS_ROOT` → `packageRoot` in `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/pi-extensions-managed-agents.json` → abort with setup instructions.
2. Before default allocation, inspect target-project instructions (`CLAUDE.md`, `AGENTS.md`, etc.) for an **explicit plan location override**; use it when present.
3. Otherwise from the target repository run `node "$PI_EXT_ROOT/scripts/allocate-plan.mjs" [--slug SLUG] [--repository NAME]`; honor `PI_PLANS_DIR` (default `~/.claude/plans`).
4. Write the returned plan path and use its sibling artifact directory.
5. Make the plan standalone with: motivation; verified current state with `file:line` evidence; pinned decisions and rejected alternatives; deviations/non-goals; gated `C1..Cn` work breakdown with file lists; indicative file map; measurable acceptance criteria; verification plan; risks/open items/future work; status, plan id, primary repository, artifact path, and a panel-dispositions section.

Only the parent edits the plan. Record the plan hash and **required** target-repo fingerprint (`capture-scope.mjs`) before review.

## Panel routing

Launch these three agents in one tool message with `run_in_background: true`:

- `px-plan-feasibility-reviewer`: `openai-codex/gpt-5.6-sol`, thinking `high`
- `px-plan-risk-reviewer`: `cursor/grok-4.5`, thinking `high`
- `px-plan-alternatives-reviewer`: `zai-coding-cn/glm-5.2`, thinking `high`

Model/thinking precedence per reviewer (first match wins): explicit `--model` / `--thinking` on this command → composed-workflow overrides → defaults above → parent fallback. There are no per-role CLI flags — one `--model` / `--thinking` applies to every panel reviewer when supplied.

Collect results in **one parallel batch** of `get_subagent_result` calls with `wait: true` for each returned subagent id.

Each child receives:

```text
Plan path: <absolute path>
Plan contents: <full plan markdown>
Repository: <name or git root>
Focus: <focus text or none>
Instructions: Report only. Do not edit. Return verdict and structured findings per your agent charter.
```

**Cost disclosure:** three concurrent high-reasoning reviews (Sol, Grok, GLM). Continue with successful reviewers after partial failures; report failures and malformed output; offer one retry per failed reviewer if the user wants.

## Drift and disposition

Immediately after reviewers return—and **before parent edits**—re-read the plan and re-run `capture-scope.mjs`. If either differs from pre-review fingerprints, flag drift and do not apply stale findings. Otherwise disposition every finding as `adopted | adapted | rejected | deferred` with rationale, update the plan for adopted/adapted items, and report reviewer models plus final plan hash in the parent message. Report plan path, artifact directory, cost, failures, and drift.

Arguments: ${@:-"(brief required after optional flags or `--`; panel review fixed)"}
