# Contributing

## Requirements

- Node.js 22.19 or newer
- Pi 0.80.9 or newer (0.83+ recommended for provider extensions)
- `@tintinweb/pi-subagents` and `pi-cursor-sdk` installed as **separate Pi packages** (not npm deps of this repo)

## Setup

```bash
git clone https://github.com/charliek/pi-extensions.git
cd pi-extensions
npm install

pi install npm:@tintinweb/pi-subagents
pi install npm:pi-cursor-sdk
pi install ./                    # or git:… after publishing

npm run sync-agents
npm run doctor
```

Register the package globally or project-locally, then **`/reload`** in Pi (or restart) after changing prompts, skills, extensions, or synchronized agents.

Importing this package **never writes globally**. It alone does not sync agents — use `npm run sync-agents`, `/pi-extensions-sync`, or project docs. Never add import-time global writes in extensions or package load paths.

## Checks

Run before committing:

```bash
npm install
npm run check
```

`npm run check` runs resource validation and the full Node test suite. Validation uses a real YAML parser and enforces:

- Required directories: `agents/`, `extensions/`, `prompts/`, `skills/`
- Pi manifest paths in `package.json`
- Agent frontmatter: `px-` prefix, no `model`/`thinking` pins, reviewer tool allowlists
- Prompt/skill frontmatter and expected resource lists

Useful npm scripts:

| Script | Purpose |
| --- | --- |
| `npm run validate` | Static resource policy only |
| `npm test` | Contract and integration tests |
| `npm run sync-agents` | Install/update managed agents |
| `npm run sync-agents:check` | Drift check, no writes |
| `npm run sync-agents:remove` | Remove managed agents |
| `npm run doctor` | Prerequisites, sync, models |
| `npm run doctor:skip-models` | Doctor without model probe |

## Resource conventions

- **Agents:** `agents/px-<name>.md` with `description`, restricted `tools`, `disallowed_tools` including `bash`, `edit`, `write`, `prompt_mode: append`, `skills: false`, `extensions: pi-cursor-sdk` for Cursor-capable reviewers. No `model` or `thinking` in frontmatter.
- **Prompts:** `prompts/<command>.md` with `description` and self-contained orchestration (no nested template indirection).
- **Skills:** `skills/<kebab-name>/SKILL.md` with `name` and `description`.
- **Extensions:** `extensions/<name>.js` or `extensions/<name>/index.ts`. The setup extension registers `/pi-extensions-sync` and `/pi-extensions-doctor` with strict flag allowlists, confirmation for mutating sync, and non-UI fail-closed behavior for mutations.

Workflow resources must remain portable. They may inherit target-project instructions but must not require workflow-specific edits to target `CLAUDE.md` or `AGENTS.md`.

## Architecture notes for contributors

- **Two-layer agents:** Pi package prompts/skills + synchronized Tintinweb agents. Sync manifest stores `packageRoot` for script resolution (`PI_EXT_ROOT`).
- **Read-only reviewers:** Pi tools limited to `read`, `grep`, `find`, `ls`. Cursor SDK may expose additional native tools — document prompt-enforced immutability, do not claim OS sandboxing.
- **Model routing:** Defaults live in prompts/skills (e.g. simplify lenses and plan risk use `cursor/grok-4.5` at `high`); agents stay overridable via `--model` / `--thinking`.
- **Command collisions:** Prompt templates use **first-discovered wins**; extension commands get numeric suffixes when names collide. Prefer fixing load order (`pi config`) over renaming user-facing prompt commands.
- **Partial failures:** Parents continue with successful subagents, report failures, disposition all findings, re-fingerprint before edits.
- **Planning path:** Default `~/.claude/plans/<repo>/NNN-<slug>.md`; honor explicit project overrides; use `allocate-plan.mjs`.

## Testing expectations

Add or update tests when changing:

- Sync/remove/check semantics (`test/sync-agents.test.mjs`)
- Package root resolution (`test/package-root.test.mjs`)
- Prompt/agent contracts (`test/workflow-contract.test.mjs`)
- Setup extension allowlists and discovery (`test/setup-extension.test.mjs`)
- Plan allocation and scope capture (`test/allocate-plan.test.mjs`, `test/capture-scope.test.mjs`)

Planning artifacts for this repo: `~/.claude/plans/pi-extensions/`.

## Future work

Gated commit, gauntlet orchestration, npm publication, and structured orchestration extensions are out of scope until standalone primitives stabilize.
