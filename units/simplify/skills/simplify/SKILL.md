---
name: simplify
description: >-
  Behavior-preserving cleanup of scoped changes via four parallel lenses: reuse,
  structure, efficiency, and altitude. Use for "simplify this diff", "clean up my
  changes", "deslop", or pre-commit simplification. Parent applies; not a
  correctness or security hunt.
---

# Simplify

## Non-negotiable mechanics

1. **Behavior-preserving only.** If a change would alter observable behavior, public API, or tests' expected results, skip it or mark `needs-user`.
2. This is **not** a correctness or security review. When the `code-review` skill is available, route bugs and attack-surface issues there; otherwise note them for the user and continue simplify-only.
3. Launch **four** concurrent `px-simplifier` subagents in **one** tool message, all `run_in_background: true`, one lens each: `reuse`, `structure`, `efficiency`, `altitude`. Collect in one parallel wait batch.
4. Default model/thinking when unset: `cursor/grok-4.5` + `high` for every lens. Precedence: user override → this default → parent model.
5. Only the **parent** edits the worktree. Reviewers report only.
6. Before any edit: re-check `git status` / the scoped diff. If the scope drifted since review, stop and report drift; do not apply stale suggestions.
7. Never commit unless the user explicitly asks.

## Scope (inline git)

Choose one (ask if ambiguous):

| Scope | Commands |
| --- | --- |
| Working tree (default) | `git diff` / `git diff HEAD` plus untracked files |
| Staged | `git diff --cached` |
| Against a base branch | `git diff <base>...HEAD` |
| Single ref / range | `git diff <ref>` or `<ref>^!` for one commit |

If the scoped diff is empty, say so and stop.

## Workflow

1. Capture scope; list files to the user; disclose four parallel high-reasoning simplify lenses when defaults apply.
2. Launch four `px-simplifier` agents in one tool message (`run_in_background: true`), each prompt naming its lens and including the diff/file list plus: `Report only. Behavior-preserving suggestions only. Do not edit. Return findings per your charter.`
3. Collect all four in one parallel wait batch. On partial failure: continue with successes; do not apply findings from failed lenses.
4. Deduplicate overlapping suggestions across lenses.
5. Present a disposition table: `apply` | `skip` | `needs-user`, with lens id, location, and rationale.
6. Apply only `apply` items the user accepted (or that the user pre-authorized as "go ahead and clean up"). Re-diff after edits and summarize what changed.

## Out of scope

- Correctness bugs, missing tests, security → `code-review` when present; else note for the user
- Plan writing → `planning` when present; else tell the user that unit is absent
- Drive-by refactors outside the scoped diff
