---
name: adversarial-review
description: Read-only adversarial review — hostile inputs, auth, money, migrations, concurrency, secrets. Use for "adversarial review", "break this change", "what could go wrong?", or high-risk diffs.
---

# Adversarial review

Use when the user wants a skeptical, ship/no-ship review focused on expensive or dangerous failure modes.

## Entry points

- Explicit: `/adversarial-review` with optional `[--staged | --ref REV] [--model PROVIDER/MODEL] [--thinking LEVEL] [--path FILE]... [--focus TEXT]`
- Natural language: "adversarial review", "try to break this", "what's the worst that could happen?", "review for security and data integrity"

## Package root

Resolve `PI_EXT_ROOT`: `PI_EXTENSIONS_ROOT` env → `packageRoot` in `$PI_CODING_AGENT_DIR/pi-extensions-managed-agents.json` (default `~/.pi/agent`) → abort if unknown.

## Scope and bundle (explicit flags only)

1. `capture-scope.mjs` then `build-scope-bundle.mjs` with identical flags. Single `--ref` = that commit only (`REV^!`); ranges unchanged. `--path` values must be normalized repository-relative literal file paths.
2. Record pre-review `fingerprint`. Pass manifest + bundle to the reviewer.
3. If the bundle has `complete: false` (or any omissions), **fail closed** unless the user explicitly acknowledges the omitted paths.

## Model routing

First match wins: `--model` / `--thinking` → composed-workflow overrides → default `openai-codex/gpt-5.6-sol` + `high` → parent model fallback.

## Workflow

1. Capture scope + bundle once; stop on incomplete bundles without user acknowledgment.
2. Launch one read-only subagent: `px-adversarial-reviewer`.
3. After the reviewer returns, re-run `capture-scope.mjs` with the same flags. If fingerprint changed, flag worktree drift with before/after values.
4. Present findings sorted by severity; **do not edit** unless the user asks afterward.

## Prerequisites

- `@tintinweb/pi-subagents` installed as a Pi package
- px agents synchronized: `npm run sync-agents` from the pi-extensions checkout
