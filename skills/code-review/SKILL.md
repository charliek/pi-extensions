---
name: code-review
description: Read-only correctness review for scoped changes — concrete regressions and missing tests, no fixes. Use for "code review", "review my diff", "check for bugs", or pre-commit correctness passes.
---

# Code review (correctness)

Use when the user wants a correctness-focused review without automatic fixes.

## Entry points

- Explicit: `/code-review` with optional `[--staged | --ref REV] [--model PROVIDER/MODEL] [--thinking LEVEL] [--path FILE]... [--focus TEXT]`
- Natural language: "review my changes", "code review this diff", "any bugs in what I wrote?", "check for regressions"

## Package root

Resolve `PI_EXT_ROOT`: `PI_EXTENSIONS_ROOT` env → `packageRoot` in `$PI_CODING_AGENT_DIR/pi-extensions-managed-agents.json` (default `~/.pi/agent`) → abort if unknown.

## Scope and bundle (explicit flags only)

1. `capture-scope.mjs` then `build-scope-bundle.mjs` with identical flags (`--staged`, `--ref`, `--path`, `--focus`). No positional scope inference.
2. Record pre-review `fingerprint`. Pass manifest + bundle to the reviewer.

## Model routing

First match wins: `--model` / `--thinking` → composed-workflow overrides → default `openai-codex/gpt-5.6-sol` + `high` → parent model fallback.

## Workflow

1. Capture scope + bundle once.
2. Launch one read-only subagent: `px-code-reviewer`.
3. After the reviewer returns, re-run `capture-scope.mjs` with the same flags. If fingerprint changed, flag worktree drift with before/after values.
4. Present findings with severity and remediation; **do not edit** unless the user asks afterward.

## Prerequisites

- `@tintinweb/pi-subagents` and `pi-cursor-sdk` installed as Pi packages
- px agents synchronized: `npm run sync-agents` from the pi-extensions checkout
