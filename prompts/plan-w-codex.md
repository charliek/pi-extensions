---
description: Generate a gauntlet-schema plan and run a feasibility-focused Sol/high review
argument-hint: "[--slug SLUG] [--repository NAME] [--model PROVIDER/MODEL] [--thinking LEVEL] [--] <brief>"
---

# /plan-w-codex — plan plus Codex review

Generate and review a plan using canonical `/plan --review codex` semantics. This template is self-contained; do not invoke another slash command.

## Non-overridable constraints

- Reviewers must not edit, write, bash, commit, or mutate the worktree.
- Report the final plan fingerprint to the user in the parent summary — do not embed a self-referential hash line inside the plan body.

## Argument parsing

Recognized flags (`--slug`, `--repository`, `--model`, `--thinking`) appear before an optional `--` delimiter; everything after `--` is the brief verbatim. Validate duplicate/unknown flags; derive slug from `--slug` or brief; pass only `--slug` and/or `--repository` to `allocate-plan.mjs` — never forward workflow flags or raw brief text the helper does not accept.

## Workflow

1. Resolve `PI_EXT_ROOT`: `PI_EXTENSIONS_ROOT` → `packageRoot` in `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/pi-extensions-managed-agents.json` → abort with setup instructions.
2. Before default allocation, inspect target-project instructions for an **explicit plan location override**. Auto-honor only when inside the target repo or configured `PI_PLANS_DIR`; any other destination requires explicit user confirmation and the no-clobber override helper (`--override-path` / `--confirm-override`).
3. Otherwise in the target repo run `node "$PI_EXT_ROOT/scripts/allocate-plan.mjs" [--slug SLUG] [--repository NAME]`; honor `PI_PLANS_DIR`.
4. Write a standalone plan at the returned path with motivation, verified `file:line` current state, pinned decisions/rejected alternatives, non-goals, gated `C1..Cn` work breakdown and files, file map, acceptance criteria, verification, risks/open items, reviewer-dispositions section, status, plan id, primary repository, and artifact path. Use the returned sibling artifact directory.
5. Record plan hash and **required** target-repo fingerprint (`capture-scope.mjs`) before review.
6. Launch `px-plan-feasibility-reviewer` with default `openai-codex/gpt-5.6-sol`, thinking `high`; explicit `--model`/`--thinking` wins, then composed-workflow override, default, parent fallback. Use `run_in_background: false` unless the user asked otherwise.

Child prompt:

```text
Plan path: <absolute path>
Plan contents: <full plan markdown>
Repository: <name or git root>
Focus: <focus text or none>
Instructions: Report only. Do not edit. Return verdict and structured findings per your agent charter.
```

7. After the reviewer returns, **before parent edits**, re-read the plan and re-run `capture-scope.mjs`. If either fingerprint changed, flag drift and stop stale application.
8. Disposition every finding as `adopted | adapted | rejected | deferred` with rationale. Parent updates the plan for adopted/adapted items. Report model, final plan hash, path, artifacts, partial failure, drift, and review cost in the parent message.

Arguments: ${@:-"(brief required after optional flags or `--`; Codex review fixed)"}
