# pi-extensions

Portable, version-controlled workflow primitives for the [Pi coding agent](https://pi.dev): planning, simplification, correctness review, and adversarial review. Resources are packaged as a Pi package (`prompts`, `skills`, `extensions`) plus separately synchronized custom agents.

**Importing this package never writes globally.** Prompts, skills, and the setup extension load read-only. Only explicit agent sync (`/pi-extensions-sync`, `npm run sync-agents`) copies `px-*` agents into your Pi agent home.

## Architecture

```text
agents/       px-* specialist definitions (synced to ~/.pi/agent/agents)
extensions/   Pi extension(s) for explicit setup commands
prompts/      Global slash-command templates (/plan, /simplify, …)
skills/       Agent Skills for natural-language workflow discovery
scripts/      Agent sync, doctor, plan allocation, scope capture
test/         Repository contract and synchronization tests
```

| Layer | Role |
| --- | --- |
| **Prompts** | Deterministic slash commands with model routing, concurrency, and disposition rules |
| **Skills** | Self-contained natural-language entry points mirroring prompt semantics |
| **Agents** | `@tintinweb/pi-subagents` definitions with restricted Pi tool surfaces |
| **Extensions** | `/pi-extensions-sync` and `/pi-extensions-doctor` for setup without finding the clone |
| **Scripts** | Headless utilities invoked by prompts, npm, and the setup extension |

Pi natively discovers `extensions/`, `prompts/`, and `skills/` from `package.json`. Custom agents in `agents/` are **not** auto-loaded; they are copied to `${PI_CODING_AGENT_DIR:-~/.pi/agent}/agents` by the sync utility and tracked in `${PI_CODING_AGENT_DIR}/pi-extensions-managed-agents.json` (manifest lives **outside** `agents/`).

Workflow behavior lives here rather than in each target repository's `CLAUDE.md` or `AGENTS.md`. Agents use `prompt_mode: append` so they still inherit target-project instructions.

## Prerequisites

- **Node.js** 22.19 or newer
- **Pi** 0.80.9+ (0.83+ recommended for provider extensions)
- **Git** (for plan allocation and scope capture in target repos)

Install these **separate Pi packages** before using panel review, simplify, or Cursor-backed reviewers:

```bash
pi install npm:@tintinweb/pi-subagents
pi install npm:pi-cursor-sdk
```

This package does not bundle them; npm dependencies here do not auto-load their Pi resources.

### Cursor authentication

Cursor-backed models (`cursor/grok-4.5`, `cursor/composer-2-5`, `cursor/kimi-k3`) require a working **pi-cursor-sdk** install and Cursor authentication. After installing `pi-cursor-sdk`, authenticate per that package's docs, then verify:

```bash
pi --list-models cursor
```

Doctor checks **required workflow models** (Grok, Sol, GLM) when run interactively; optional future models (`cursor/composer-2-5`, `cursor/kimi-k3`) produce warnings only. Use `npm run doctor:skip-models` or `/pi-extensions-doctor --skip-models` when offline.

## Installation

### From a local checkout (development)

```bash
git clone https://github.com/charliek/pi-extensions.git
cd pi-extensions
npm install

# Install prerequisite Pi packages (required, separate step)
pi install npm:@tintinweb/pi-subagents
pi install npm:pi-cursor-sdk

# Register this package with Pi (global or project-local)
pi install .                    # writes ~/.pi/agent/settings.json
# pi install -l .               # project-local .pi/settings.json

# Synchronize px-* agents (explicit global write)
npm run sync-agents

# Verify prerequisites and sync state
npm run doctor
```

### From Git (without cloning manually)

Pin an **immutable ref** (release tag or commit SHA) you trust — avoid floating `@main` in production setups:

```bash
pi install npm:@tintinweb/pi-subagents
pi install npm:pi-cursor-sdk
pi install git:github.com/charliek/pi-extensions@v0.1.0   # tag
# pi install git:github.com/charliek/pi-extensions@abc1234   # commit SHA

# After install, sync agents from the installed package root:
/pi-extensions-sync
/pi-extensions-doctor
```

### Updating or uninstalling

1. **Update package:** `pi install git:github.com/charliek/pi-extensions@<new-ref>` (or `pi install .` from a fresh checkout)
2. **Reload Pi:** `/reload` (or restart) so prompts, skills, and extensions reload
3. **Re-sync agents:** `/pi-extensions-sync` or `npm run sync-agents` from a checkout
4. **Verify:** `/pi-extensions-doctor` or `npm run doctor`

To remove:

1. **Remove managed agents first:** `/pi-extensions-sync --remove` or `npm run sync-agents:remove`
2. **Remove the Pi package:** `pi remove git:github.com/charliek/pi-extensions` (use the same source identity recorded by `pi list`)
3. **Reload Pi:** `/reload`

After changing the installed package or syncing agents, run **`/reload`** in Pi (or start a fresh `pi` process) so prompts, skills, extensions, and synchronized agents are picked up.

## Agent sync, check, update, and remove

| Action | npm | Pi command |
| --- | --- | --- |
| Install/update agents | `npm run sync-agents` | `/pi-extensions-sync` |
| Check drift (no writes) | `npm run sync-agents:check` | `/pi-extensions-sync --check` |
| Force overwrite conflicts | `npm run sync-agents -- --force` | `/pi-extensions-sync --force` |
| Remove managed agents | `npm run sync-agents:remove` | `/pi-extensions-sync --remove` |
| Health check | `npm run doctor` | `/pi-extensions-doctor` |
| Doctor without model probe | `npm run doctor:skip-models` | `/pi-extensions-doctor --skip-models` |

Sync behavior:

- Copies only `agents/px-*.md` from the package
- Refuses to overwrite unmanaged or locally modified files unless `--force`
- `--remove` deletes only manifest-owned files whose hashes still match (never deletes hash-modified files, even with `--force`)
- Records `packageRoot`, `packageVersion`, and per-file SHA-256 in the manifest

Resolve script paths for prompts (`PI_EXT_ROOT`):

1. `PI_EXTENSIONS_ROOT` environment variable
2. `packageRoot` in `$PI_CODING_AGENT_DIR/pi-extensions-managed-agents.json`
3. Abort with setup instructions if unknown

## Slash commands

| Command | Purpose |
| --- | --- |
| `/plan` | Write a gauntlet-schema plan to `~/.claude/plans/<repo>/NNN-<slug>.md` |
| `/plan --review panel\|grok\|codex\|glm …` | Plan + review (panel = three concurrent reviewers) |
| `/review-plan panel\|grok\|codex\|glm [path]` | Review an existing plan |
| `/plan-w-panel`, `/plan-w-grok`, `/plan-w-codex` | Convenience aliases (no `/plan-w-glm`) |
| `/simplify` | Four concurrent simplify lenses on uncommitted scope |
| `/code-review` | Correctness-focused read-only review |
| `/adversarial-review` | Hostile-input / trust-boundary review |

Skills (`planning`, `simplify`, `code-review`, `adversarial-review`) mirror these flows for natural-language invocation.

### Prompt-template collisions (first wins)

Short global slash **prompt template** names may collide with other Pi packages. Pi resolves duplicate prompt templates by **first-discovered wins** — whichever prompt loads first owns the name. If `/plan` or `/simplify` resolves to a different template, disable or reorder the competing resource in Pi config (`pi config`) so this package registers first. Do not rely on numeric suffixes or `/reload` alone to fix prompt collisions.

**Extension commands** (such as `/pi-extensions-sync`) are registered separately; if two extensions define the same command name, Pi assigns colon-numbered invocation suffixes (for example `/pi-extensions-sync:1` and `/pi-extensions-sync:2`).

### Model defaults and overrides

Specialist agents omit `model` and `thinking` in frontmatter so callers can override. Precedence:

1. Explicit `--model PROVIDER/MODEL` and/or `--thinking LEVEL` on the command
2. Composed-workflow stage overrides (future gauntlet)
3. Primitive defaults (below)
4. Parent's current model/thinking

| Primitive / lens | Default model | Default thinking |
| --- | --- | --- |
| Simplify (each lens) | `cursor/grok-4.5` | `high` |
| Code review | `openai-codex/gpt-5.6-sol` | `high` |
| Adversarial review | `openai-codex/gpt-5.6-sol` | `high` |
| Plan feasibility | `openai-codex/gpt-5.6-sol` | `high` |
| Plan risk | `cursor/grok-4.5` | `high` |
| Plan alternatives | `zai-coding-cn/glm-5.2` | `high` |

Future gauntlet tiers (not implemented here): `cursor/composer-2-5` (routine), `cursor/grok-4.5` / `high` (complex), `cursor/kimi-k3` / `max` (orchestration).

### Costs

- **`/simplify`**: four concurrent high-reasoning Grok calls
- **`/plan --review panel`**: three concurrent high-reasoning reviews (Sol, Grok, GLM)
- Single-lens plan review: one high-reasoning call

Prompts disclose costs when defaults apply.

### Partial failures

If one or more subagents fail, timeout, or return malformed output:

- Continue with successful reviewers
- Report which agents failed with error snippets
- Do not adopt findings from failed reviewers without user confirmation
- Offer to retry failed reviewers once

Parents must disposition every finding (`adopted` | `adapted` | `rejected` | `deferred`) and re-fingerprint plan/scope before applying feedback.

### Cursor reviewer caveat (prompt-enforced, accepted residual risk)

Cursor SDK models retain **Cursor-native tools** independently of Tintinweb's Pi tool allowlist. Grok-backed reviewers disable Pi `bash`/`edit`/`write`, load only `pi-cursor-sdk`, instruct read-only behavior, and fingerprint the worktree — but they are **not** OS-sandboxed. This package does **not** attempt to solve Cursor-native tool sandbox limitations or change user-pinned Cursor defaults. Documentation and tests distinguish Pi tool restriction from Cursor prompt enforcement. Treat Cursor-backed immutability as prompt/fingerprint enforcement only — an accepted residual risk.

### Incomplete scope bundles

`build-scope-bundle.mjs` sets `complete: false` when any truncation, max-buffer, binary, oversized, or unreadable omission occurs (including tracked binary changes inventoried via `git diff --numstat`). Parents and skills must **fail closed** on incomplete bundles unless the user explicitly acknowledges the omitted paths.

## Planning convention

Plans and artifacts remain outside target repositories:

```text
~/.claude/plans/<primary-repo>/NNN-<slug>.md
~/.claude/plans/<primary-repo>/NNN-<slug>/
```

Set `PI_PLANS_DIR` to change the base (default `~/.claude/plans`). Target-project instruction overrides (e.g. `CLAUDE.md`) are auto-honored only when the destination is inside the target repository or the configured `PI_PLANS_DIR`. Any other destination requires explicit user confirmation and must be created through the no-clobber helper (`allocate-plan.mjs --override-path` with `--confirm-override` when needed): non-existing path, regular non-symlink parent.

For this repository, plans live under `~/.claude/plans/pi-extensions/` unless overridden.

## Development

Requires Node.js 22.19+.

```bash
npm install
npm run check          # validate resources + full test suite
npm run sync-agents    # after changing agents/
npm run doctor         # prerequisites, sync, models
```

Contract tests cover agent sync safety, plan allocation, scope capture, prompt/agent invariants, and setup-extension registration. CI runs `npm run check` on every push.

## Future scope (not in this package yet)

- `/pre-commit-review`, `/gated-commit`, `/gauntlet` composed workflows
- Persistent routing config and structured orchestration extension
- Review fingerprints, PR/CI integration, npm publication

## Status

Planning, simplification, code review, adversarial review, and panel plan review primitives are implemented. Gated commit and gauntlet orchestration are planned follow-ups.

## License

MIT
