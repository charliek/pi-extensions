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

## Fresh-computer setup

See **[SETUP.md](SETUP.md)** for the complete person- and agent-friendly bootstrap guide, including pinned installs, provider authentication, synchronization, verification, updates, removal, and troubleshooting.

High-level sequence:

1. Install Git, Node.js 22.19+ (Node 24 recommended), and Pi 0.80.9+ (Pi 0.83+ recommended).
2. Install the separate prerequisites: `@tintinweb/pi-subagents` and `pi-cursor-sdk`.
3. Install this package from a local checkout with `pi install .`, or from an **immutable** trusted Git tag/SHA.
4. Authenticate OpenAI Codex, ZAI Coding Plan China, and Cursor through `/login`.
5. Explicitly synchronize the nine managed agents with `npm run sync-agents` or `/pi-extensions-sync`.
6. Run `/reload`, followed by `npm run doctor` or `/pi-extensions-doctor`.

Minimal local-checkout path:

```bash
git clone https://github.com/charliek/pi-extensions.git
cd pi-extensions
npm ci
pi install npm:@tintinweb/pi-subagents@0.14.3
pi install npm:pi-cursor-sdk@0.1.62
pi install .
npm run sync-agents
npm run doctor:skip-models  # authenticate providers next, then run the full doctor
```

For a checkout-free install, pin a trusted full commit SHA or release tag rather than floating `@main`:

```bash
pi install git:github.com/charliek/pi-extensions@<FULL_COMMIT_SHA>
```

Then start Pi, authenticate with `/login`, run `/pi-extensions-sync`, `/reload`, and `/pi-extensions-doctor`. Cursor requires a Cursor SDK API key; `pi-cursor-sdk` does not reuse Cursor Desktop or CLI login state. Full details and manual checkpoints are in [SETUP.md](SETUP.md).

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
