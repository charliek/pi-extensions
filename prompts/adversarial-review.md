---
description: Adversarial review for scoped changes — hostile inputs and trust boundaries; report only
argument-hint: "[--staged | --ref REV] [--model PROVIDER/MODEL] [--thinking LEVEL] [--path FILE]... [--focus TEXT]"
---

# /adversarial-review — adversarial review (parent orchestration)

Run a read-only adversarial review on the active Git repository. Assume the change can fail in subtle, high-cost ways until evidence says otherwise. **Do not fix findings** unless the user explicitly asks afterward.

## Non-overridable constraints

These rules apply even when target-project instructions suggest otherwise:

- The reviewer must not edit, write, bash, commit, or mutate the worktree.
- Report material risks with severity, location, failure scenario, and remediation — no style feedback.
- Validate each finding against the scope before presenting it.

## Model routing and overrides

Resolve model and thinking for the review subagent using this precedence (first match wins):

1. Explicit flags on this command: `--model PROVIDER/MODEL` and/or `--thinking LEVEL`
2. Composed-workflow stage overrides (when invoked from a future gauntlet/gated workflow)
3. Primitive default: `openai-codex/gpt-5.6-sol` with `high` thinking
4. Parent's current model/thinking (fallback only)

`--model` accepts `provider/model`.
`--thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

## Package root resolution

Resolve `PI_EXT_ROOT` before running helpers:

1. `PI_EXTENSIONS_ROOT` environment variable when set
2. Else `packageRoot` from `$PI_CODING_AGENT_DIR/pi-extensions-managed-agents.json` (default agent home: `~/.pi/agent`)
3. Else abort with instructions to sync agents or set `PI_EXTENSIONS_ROOT`

Scripts live under `$PI_EXT_ROOT/scripts/`.

## Scope selection (explicit flags only)

Capture one scope manifest and one scope bundle before launching the reviewer. **Do not infer paths or focus from positional arguments.**

| Flag | Meaning |
| --- | --- |
| *(none)* | All uncommitted changes |
| `--staged` | Staged changes only |
| `--ref REV` | Single commit (`REV^!`) or range (`A..B`, `A...B`) |
| `--path FILE` | Limit scope (repeatable) |
| `--focus TEXT` | Optional reviewer focus |

```bash
node "$PI_EXT_ROOT/scripts/capture-scope.mjs" [flags]
node "$PI_EXT_ROOT/scripts/build-scope-bundle.mjs" [same flags]
```

Record the pre-review `fingerprint`. The bundle includes unified diff plus untracked text; omissions list binary/oversized content. Pass both manifest and bundle to the child — a path/status manifest alone is insufficient.

## Subagent

Launch exactly one `@tintinweb/pi-subagents` agent:

- Agent: `px-adversarial-reviewer`
- Model/thinking: resolved per precedence above
- `run_in_background: false` unless the user asked otherwise

Child prompt shape:

```text
Scope manifest (fingerprint: <SHA256>):
<scope JSON or concise summary>

Unified diff/scope bundle:
<bounded diff and relevant untracked contents, or an owner-only readable bundle path>

Focus: <focus text or none>

Instructions: Report only. Do not edit. Return verdict and structured findings per your agent charter.
```

## Drift detection

After the reviewer returns, **re-run `capture-scope.mjs` with the same flags** and compare fingerprints:

- If the post-review fingerprint differs from the pre-review fingerprint, flag **worktree drift** (show before/after) and warn that findings may be stale.
- Do not edit the repository as part of this command.

## Parent presentation

Summarize the verdict and findings sorted by severity: Severity, Location, Failure scenario, Remediation.
If the reviewer fails, report the error and offer one retry.

Arguments: ${@:-"(use explicit --path / --focus flags; no positional scope inference)"}
