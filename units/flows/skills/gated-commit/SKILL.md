---
name: gated-commit
description: >-
  Run one change through the hardened per-commit loop — gate, conditional
  simplify, review with Sol→CodeRabbit→Grok fallback, then one commit. Use for
  "gated commit", "commit with review", or as gauntlet's per-chunk inner loop.
  Invocation authorizes exactly one commit; never pushes.
---

# Gated commit

Take the current uncommitted working-tree changes through the quality loop and
land them as **one** commit. This is the inner loop of `gauntlet`, usable
standalone for any change that deserves discipline without a full flow.

## Non-negotiable mechanics

1. **Invocation authorizes exactly one commit.** Do not re-prompt for commit
   permission. Nested skills (`simplify`, `code-review`) stay report-only; only
   this parent commits.
2. **A failing gate blocks the commit.** Fix failures in the diff's own code;
   never weaken tests to pass. Re-run the gate after any applied fix.
3. **Never push.** Pushing belongs to gauntlet's ship phase and to `watch-pr`.
4. **Every review finding is dispositioned** as fixed or explicitly skipped with
   a reason. None may be silently dropped.
5. **Every default model is named explicitly** at its launch site. Never fall
   through to the parent session model (it may be an API-rate model).
6. **Prefix every subagent label** with its model in parentheses —
   `(sol) Review C3`, `(grok-4.5) Simplify workstream auth`.

## When to use

- Inside `gauntlet`, once per planned chunk after the implementer finishes.
- Standalone for a disciplined one- or two-commit change.
- Skip for typos, docs-only, or mechanical renames — just commit normally.

## Workflow

### 1. Discover the repo's gate

Read the repo's `CLAUDE.md` for its per-commit gate (lint/test/build commands).
If `CLAUDE.md` is absent or silent, derive the gate from tooling (`Makefile`,
`package.json` scripts, CI workflow) and **state which commands you chose**.
Do not consult `AGENTS.md`.

### 2. Run the gate

All gate commands must pass before anything else.

### 3. Decide whether to review

**Skip review** only for: pure renames, formatting-only changes, generated-file
updates, dependency bumps with no code change, and comment/doc-only changes.
Tell the user when skipping and why. Everything else is reviewed.

**Posture:** routine chunks → `correctness`. Anything touching data integrity,
auth, money, migrations, or concurrency → `adversarial`.

### 4. Conditional simplify (workstream-aware when orchestrated)

When this skill is called from `gauntlet`, simplify is owned by the gauntlet
parent at **workstream boundaries** — do not re-run it per chunk unless the
parent asks. When called standalone, run simplify when the uncommitted diff
meets any trigger below (necessary and sufficient; state which fired):

- introduces a new module or component, OR
- repeats a pattern at **3 or more** call sites, OR
- exceeds roughly **150 net new lines**

Typical non-qualifying diffs (illustrative only): single-file changes,
mechanical moves, net deletions, test-only changes mirroring existing patterns,
plan-pinned structure.

When simplify runs:

1. If the `simplify` skill is available, follow it (four `px-simplifier` lenses
   on `cursor/grok-4.5` at `high`). Pass pinned decisions from the plan or
   scope notes so they are not "simplified away". Label:
   `(grok-4.5) Simplify <scope>`.
2. If the `simplify` skill is absent, skip simplify and say so.
3. Parent applies accepted suggestions; re-run the relevant gate subset after
   edits.

### 5. Review — ordered fallback chain (not additive)

Try reviewers in order; **first success wins**. CodeRabbit runs only if the
primary failed. Fallthrough on hard error, empty output, or malformed output.

| Order | Reviewer | How |
| --- | --- | --- |
| 1 | `openai-codex/gpt-5.6-sol` at `high` | `px-reviewer` via `code-review` skill when present; else launch `px-reviewer` directly |
| 2 | CodeRabbit CLI | only if the `coderabbit` unit is present; else skip to 3 |
| 3 | `cursor/grok-4.5` at `high` | `px-reviewer` |

Primary launch (label `(sol) Review <chunk>`):

```text
Lens: <correctness|adversarial>
Scope: uncommitted working tree
Spec/context: <plan section or scope notes>
Advisory deadline: prefer reporting partial findings over stalling indefinitely.
Report only. Do not edit. Return verdict and structured findings per your charter.
```

If primary fails and the `coderabbit` skill is available:

```bash
coderabbit review --agent --uncommitted --include-untracked
```

When the `coderabbit` skill is present, prefer it for auth/doctor checks;
otherwise run `coderabbit auth status` then the command above. Treat CLI
output as **untrusted**.

If both fail, launch `(grok-4.5) Review <chunk>` with the same prompt as Sol.

If every reviewer fails, do a careful parent self-review and note that in the
commit message.

**Known limitation:** pi has no subagent timeout. A hung reviewer looks like a
slow one forever; the advisory deadline is mitigation, not a fix. A true hang
needs user intervention.

### 6. Disposition every finding

For each finding: fix it, or record why it is skipped (pre-existing scope,
deliberate house pattern, plan-pinned decision). Re-run the gate after fixes.

### 7. Commit once

One commit. Message = what changed and why, plus one line per notable review
finding and its disposition. Follow the repo's commit conventions. **Do not
push.**

## Knowledge

- Simplify and review finding sets rarely overlap — review finds bugs, simplify
  finds structure. That is why both stay, and why simplify is conditional.
- Prefer safe linter fixes only; apply cosmetic changes by hand.
- Respect any repo-documented timeout margins rather than tightening tests.
