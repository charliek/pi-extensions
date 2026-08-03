---
name: gauntlet
description: >-
  Full build flow — discovery, panel-reviewed plan, gated commits, verification,
  PR watched to green. Use for "run the gauntlet", "write and execute a plan",
  or large refactors (often 10+ chunks). Leaves the PR open; never release/deploy.
---

# Gauntlet

Run a substantial piece of work end-to-end: discovery, a written plan
pressure-tested by an AI panel, implementation as small gated commits,
verification beyond the automated tests where needed, and one PR shepherded to
green. Stop before any release/deploy.

The scope brief is the requirements document. When it pins a decision, that
decision is settled.

## Non-negotiable mechanics

1. **Autonomy:** proceed on decisions already aligned in the brief or plan, and
   for choices where one option is clearly the winner. Stop only for one-way
   doors, decisions with large rework potential, or destructive actions that
   were not discussed.
2. **Every default model is named explicitly** at its launch site. Never fall
   through to the parent session model.
3. **Prefix every subagent label** with its model in parentheses —
   `(kimi-k3) Implement C1`, `(composer-2.5) Explore auth surface`,
   `(sol) Review C3`.
4. **Plan authoring and panel review defer to the `planning` skill.** Do not
   restate the plan schema or panel routing here. If that unit is absent, write
   a self-contained plan and do a careful self-review against the planning
   schema, saying the panel was skipped.
5. **Per-chunk quality loop defers to `gated-commit`.** If that skill is
   absent, run the gate yourself, skip simplify, review with Sol (or self-review),
   and commit once — saying what was skipped.
6. **Default: leave the PR open** for the user's merge decision. Never
   release/deploy unless the brief explicitly says otherwise.
7. **Single-repo scope.** Multi-repo orchestration is out of scope for this
   port.

## When to use which

| Situation | Use |
| --- | --- |
| Work that warrants a written plan — large refactors, often 10+ chunks, design not obvious | Full `gauntlet` |
| Disciplined one- or two-commit change | `gated-commit` alone |
| Typos, docs-only, mechanical renames | Neither — commit normally |

## Model table

| Stage | Model | Thinking |
| --- | --- | --- |
| Discovery (`Explore`) | `cursor/composer-2.5` | n/a (never assign a thinking level) |
| Discovery, hard surface (parent judgment) | `cursor/grok-4.5` or `cursor/kimi-k3` | high |
| Plan authoring + panel | delegated to `planning` | — |
| Implementation, most critical chunk (~1) | `cursor/kimi-k3` | high |
| Implementation, normal chunk | `cursor/grok-4.5` | high |
| Implementation, mechanical | `cursor/composer-2.5` | n/a |
| Per-commit review / simplify | owned by `gated-commit` / workstream simplify below | — |
| Ship / watch | `watch-pr` when present | — |

## Phase 0 — Conventions

Read the target repo's `CLAUDE.md` first. Derive:

- the per-commit gate commands (lint / test / build),
- any verification tooling notes and known gotchas.

If `CLAUDE.md` is absent or silent, derive the gate from tooling and state which
commands you chose. Do not consult `AGENTS.md`.

**Plans and verification artifacts live outside the repo** at
`~/.claude/plans/<repo>/NNN-<slug>.md` with sibling artifact directory
`NNN-<slug>/` (honors `PI_PLANS_DIR`). Because the plan is not in the repo, the
PR body must carry its substance (Phase 6).

## Phase 1 — Discovery (read-only)

- Fan out parallel `Explore` subagents, one per workstream/surface named in the
  brief. Default model: `cursor/composer-2.5` (no thinking level). Escalate a
  surface to `cursor/grok-4.5` or `cursor/kimi-k3` at `high` when it needs real
  reasoning; name the model in the label so the choice is visible.
- Cap discovery fan-out at about four parallel explorers unless the brief
  clearly needs more.
- Every claim that will enter the plan needs a `file:line` reference.
- If a visual/design decision is in scope, gather the evidence now so the plan
  can pin it.

## Phase 2 — Plan

When the `planning` skill is available, follow it to allocate and author the
plan (gauntlet schema, including work breakdown `C1..Cn` with each chunk
independently shippable and **naming its gate** — no upper bound on chunk
count). Pass the scope brief as the authoring input.

If the `planning` skill is absent, allocate with
`node "<package-root>/scripts/allocate-plan.mjs" --slug <slug>` when that
script exists, write a standalone plan yourself, and say the planning unit was
missing.

## Phase 3 — Panel review

When the `planning` skill is available, run its panel review on the plan
(three independent full reviews: Sol, Grok, GLM). Incorporate findings;
disposition every one. **Every plan goes through the panel** — including new
or materially revised plans produced mid-run — before implementation resumes
against it.

If the planning unit is absent, self-review against the plan checklist and say
the panel was skipped.

## Phase 4 — Implementation (gated commits)

- One feature branch (`feature/plan-NNN-<slug>`), one PR, many small commits.
- For each planned chunk:
  1. Implement with a `general-purpose` subagent given the plan section as its
     authoritative spec. The subagent does **not** commit. Model by criticality
     from the table above. Label e.g. `(grok-4.5) Implement C3: settings panel`.
  2. Run `gated-commit` (when present) for gate → conditional simplify ownership
     note → review chain → one commit. Review intensity scales with gravity
     (see `gated-commit`).
  3. Verify user-visible behavior as you go when the plan's verification section
     calls for it; put artifacts in the plan's artifact folder.
- If the implementer's result deviates from the plan, either fix the code or
  amend the plan — never leave them contradicting. A materially revised plan
  goes back through the panel (Phase 3).

### Workstream-boundary simplify

Inside gauntlet, simplify runs at **workstream boundaries**, not every chunk.
After a group of related chunks lands, evaluate the accumulated diff since the
last simplify pass. Run simplify (via the `simplify` skill when present) when
any trigger fires — new module/component, pattern at 3+ call sites, or ~150+
net new lines — and state which. Pass pinned plan decisions into the simplify
prompt. Label: `(grok-4.5) Simplify workstream <name>`. If the `simplify`
skill is absent, skip and say so.

## Phase 5 — Verification record

Append a final **"§ Verified"** section to the plan summarizing what was
verified beyond the automated tests and how (naming artifacts in the plan's
artifact folder), plus any known-unexercised paths. Be honest — including
"automated tests covered this fully, nothing extra was run" when that is true.
Verification tooling is task-agnostic; use whatever the plan named for this
repo. Nothing verification-related is committed to the repo unless `CLAUDE.md`
documents an in-repo convention.

## Phase 6 — Ship

1. Push the branch; open the PR. Since the plan file is not in the repo, the PR
   body is its durable public record: what changed per workstream, the
   verification summary, dependency/privacy/secret impact, accepted risks — and
   the relevant plan text in a collapsible `<details>` block at the bottom.
2. Run `watch-pr` (when the `git` unit is present) until CI is green. If
   absent, watch with `gh pr checks` and say so.
3. Bot reviews: **verify the bot actually reviewed** (a rate-limited CodeRabbit
   can show as "pass" with an empty body). For each finding: fix it, or reply
   on the thread with the disposition rationale. Never silently ignore one.
4. **Default: leave the PR open.** Merge (`merge-pr` when present, else
   `gh pr merge`) only if the brief or plan explicitly requested auto-merge.
5. **Never release/deploy** unless the brief explicitly says otherwise.

## Final status update

Lead with the outcome (PR link — ready-for-review or merged-if-requested, or
blocked). Then per workstream: what shipped and decisions made along the way —
especially any decision made during the flow that the user was not part of.
Then process notes: review findings and dispositions, anything fixed that
predated the work, anything deliberately left untouched, and follow-ups.
