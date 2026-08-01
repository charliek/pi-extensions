---
description: Simplify scoped changes with four parallel read-only lenses; parent applies justified cleanups only
argument-hint: "[--staged | --ref REV] [--model PROVIDER/MODEL] [--thinking LEVEL] [--path FILE]... [--focus TEXT]"
---

# /simplify — behavior-preserving cleanup (parent orchestration)

Run the portable simplify workflow on the active Git repository. **Only the parent agent may edit files.** Child reviewers report findings only.

## Non-overridable constraints

These rules apply even when target-project instructions suggest otherwise:

- Reviewers must not edit, write, bash, commit, or mutate the worktree.
- Simplify does not hunt correctness bugs — use `/code-review` or `/adversarial-review` for that.
- Re-capture scope and compare fingerprints before applying any finding; abort application if the worktree drifted.

## Model routing and overrides

Resolve model and thinking for **each simplify lens subagent** using this precedence (first match wins):

1. Explicit flags on this command: `--model PROVIDER/MODEL` and/or `--thinking LEVEL`
2. Composed-workflow stage overrides (when invoked from a future gauntlet/gated workflow)
3. Primitive default: `cursor/grok-4.5` with `high` thinking
4. Parent's current model/thinking (fallback only)

`--model` accepts `provider/model` (for example `cursor/grok-4.5`, `openai-codex/gpt-5.6-sol`).
`--thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

**Cost disclosure:** This workflow launches **four concurrent high-reasoning Grok reviews** by default. Tell the user when starting if defaults apply.

## Package root resolution

Resolve `PI_EXT_ROOT` before running helpers:

1. `PI_EXTENSIONS_ROOT` environment variable when set
2. Else `packageRoot` from `$PI_CODING_AGENT_DIR/pi-extensions-managed-agents.json` (default agent home: `~/.pi/agent`)
3. Else abort with instructions to sync agents or set `PI_EXTENSIONS_ROOT`

Scripts live under `$PI_EXT_ROOT/scripts/`.

## Scope selection (explicit flags only)

Capture **one** scope manifest and **one** scope bundle before launching reviewers. **Do not infer paths or focus from positional arguments** — use explicit flags only:

| Flag | Meaning |
| --- | --- |
| *(none)* | All uncommitted changes (staged, unstaged, untracked) |
| `--staged` | Staged changes only |
| `--ref REV` | Committed revision or range (`A..B`, `A...B`). A single revision diffs **that commit only** (`REV^!`). |
| `--path FILE` | Limit scope to FILE (repeatable) |
| `--focus TEXT` | Optional reviewer focus string |

Example (default uncommitted scope):

```bash
node "$PI_EXT_ROOT/scripts/capture-scope.mjs"
node "$PI_EXT_ROOT/scripts/build-scope-bundle.mjs"
```

With filters:

```bash
node "$PI_EXT_ROOT/scripts/capture-scope.mjs" --path src/foo.ts --focus "error handling only"
node "$PI_EXT_ROOT/scripts/build-scope-bundle.mjs" --path src/foo.ts --focus "error handling only"
```

Record the returned `fingerprint` and file manifest. The bundle helper writes an owner-only file outside the repository containing the unified staged/unstaged or ref diff plus relevant untracked text; binary/oversized paths appear under **Omissions**. Pass the same manifest and bundle path/content to all four lenses — a path/status manifest alone is not enough to review changed lines.

List untracked files explicitly in the parent summary.

## Subagents (launch in one parallel batch)

Launch exactly these four `@tintinweb/pi-subagents` agents **concurrently** with the resolved model/thinking:

| Agent | Lens |
| --- | --- |
| `px-simplify-reuse` | reuse existing patterns/helpers |
| `px-simplify-structure` | structure, clarity, dead code |
| `px-simplify-efficiency` | redundant work and hot-path waste |
| `px-simplify-altitude` | over/under abstraction |

Each child prompt must include:

```text
Scope manifest (fingerprint: <SHA256>):
<scope JSON or concise summary>

Unified diff/scope bundle:
<bounded diff and relevant untracked contents, or an owner-only readable bundle path>

Focus: <focus text or none>

Instructions: Report only. Do not edit. Return structured findings per your agent charter.
```

Set `run_in_background: true` on all four calls and emit all four `Agent` calls in one tool message so they actually run concurrently. Then collect each result with `get_subagent_result`; do not poll repeatedly.

## Partial failures

If one or more lenses fail, timeout, or return malformed output:

- Continue with successful lenses.
- Report which agents failed and include error snippets.
- Do not apply findings derived from failed lenses.
- Offer to retry failed lenses once if the user wants.

## Parent synthesis and application

1. Deduplicate overlapping findings across lenses.
2. Present a disposition table: finding id, lens, confidence, location, recommendation, **apply | skip | needs-user**.
3. Apply **only** high-confidence, behavior-preserving changes that stay within scope.
4. Medium-confidence or scope-expanding items require explicit user disposition before editing.
5. **Before editing:** re-run `capture-scope.mjs` and compare fingerprints to the pre-review fingerprint; if different, stop and report drift (include before/after fingerprints).
6. **After edits:** re-run `capture-scope.mjs` and note the new fingerprint.
7. Run lightweight checks for touched files when practical.

Summarize: files changed, findings applied vs skipped, partial failures, fingerprint before/after, and approximate review cost (four Grok/high calls when defaults used).

Arguments: ${@:-"(use explicit --path / --focus flags; no positional scope inference)"}
