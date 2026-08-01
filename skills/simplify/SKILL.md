---
name: simplify
description: Simplify scoped code with four parallel read-only lenses (reuse, structure, efficiency, altitude); parent applies behavior-preserving cleanups only. Use for "simplify this diff", "clean up my changes", "deslop", or behavior-preserving refactors before commit.
---

# Simplify scoped changes

Use when the user wants to simplify, deslop, or clean up scoped code without changing behavior.

## Entry points

- Explicit: `/simplify` with optional `[--staged | --ref REV] [--model PROVIDER/MODEL] [--thinking LEVEL] [--path FILE]... [--focus TEXT]`
- Natural language: "simplify my changes", "clean up this diff", "deslop the branch", "behavior-preserving cleanup"

## Package root

Resolve `PI_EXT_ROOT`: `PI_EXTENSIONS_ROOT` env → `packageRoot` in `$PI_CODING_AGENT_DIR/pi-extensions-managed-agents.json` (default `~/.pi/agent`) → abort if unknown. Run helpers from `$PI_EXT_ROOT/scripts/`.

## Scope and bundle (explicit flags only)

1. `node "$PI_EXT_ROOT/scripts/capture-scope.mjs"` with `--staged`, `--ref`, `--path`, or `--focus` as needed. Positional scope inference is rejected.
2. `node "$PI_EXT_ROOT/scripts/build-scope-bundle.mjs"` with the **same flags**. Single `--ref` revisions diff that commit only (`REV^!`); ranges stay ranges.
3. Record pre-review `fingerprint`. Pass manifest + owner-only bundle path to all lenses.

## Model routing

Per lens, first match wins: `--model` / `--thinking` flags → composed-workflow overrides → default `cursor/grok-4.5` + `high` → parent model fallback.

## Workflow

1. Capture scope + bundle once.
2. Launch **four concurrent** read-only subagents (`run_in_background: true`, one tool message): `px-simplify-reuse`, `px-simplify-structure`, `px-simplify-efficiency`, `px-simplify-altitude`.
3. Collect with `get_subagent_result`; continue on partial failures; do not apply findings from failed lenses.
4. Deduplicate findings; present disposition table (apply | skip | needs-user).
5. **Before any edit:** re-run capture-scope; if fingerprint ≠ pre-review fingerprint, stop and report drift (before/after).
6. **After edits:** re-run capture-scope; report fingerprint before/after.

Simplify does not hunt correctness or security bugs — route those to code review or adversarial review.

## Prerequisites

- `@tintinweb/pi-subagents` and `pi-cursor-sdk` installed as Pi packages
- px agents synchronized: `npm run sync-agents` from the pi-extensions checkout
