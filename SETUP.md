# Fresh-machine setup

This guide bootstraps the portable workflows in this repository on a new computer. It is written so a person or coding agent can distinguish automated steps from the authentication and confirmation steps that require the user.

## What gets installed

There are three separate Pi packages:

1. `@tintinweb/pi-subagents` — subagent orchestration.
2. `pi-cursor-sdk` — Cursor models such as Grok 4.5.
3. `charliek/pi-extensions` — this repository's prompts, skills, setup extension, scripts, and nine `px-*` agent definitions.

Pi discovers this package's prompts, skills, and extension directly. The `px-*` agent definitions require a separate explicit synchronization into `${PI_CODING_AGENT_DIR:-~/.pi/agent}/agents`. Importing the package itself never performs that global write.

## Prerequisites

Install:

- Git
- Node.js 22.19 or newer; Node.js 24 is recommended
- Pi 0.80.9 or newer; Pi 0.83 or newer is recommended

For the currently tested Pi release:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.83.0
pi --version
```

Pi can alternatively be installed using the installer documented at <https://pi.dev>.

## Choose an installation method

Use **Method A** when the machine should have a visible checkout that can be inspected and developed. Use **Method B** for a runtime-only installation managed by Pi. Do not use both for the same package registration.

### Method A: local checkout

```bash
git clone https://github.com/charliek/pi-extensions.git
cd pi-extensions
npm ci

pi install npm:@tintinweb/pi-subagents@0.14.3
pi install npm:pi-cursor-sdk@0.1.62
pi install .

npm run sync-agents
npm run doctor:skip-models
```

`pi install .` records the local checkout in `~/.pi/agent/settings.json`. The package remains linked to that checkout, so pulling changes updates the package resources after Pi reloads.

### Method B: immutable Git installation

Choose a release tag or full commit SHA that you trust. A commit SHA is usable even when no release tag exists:

```bash
pi install npm:@tintinweb/pi-subagents@0.14.3
pi install npm:pi-cursor-sdk@0.1.62
pi install git:github.com/charliek/pi-extensions@<FULL_COMMIT_SHA>
```

Replace `<FULL_COMMIT_SHA>`; do not type the angle brackets. Select a reviewed revision from the repository's Releases or Commits page. Prefer an immutable tag or SHA over floating `@main` for a reproducible or security-sensitive setup. Do not hard-code a commit copied from this guide: documentation changes after every release, so the trusted ref belongs in the bootstrap configuration that invokes this guide.

Start a fresh Pi process after Method B, then run:

```text
/pi-extensions-sync
/reload
/pi-extensions-doctor --skip-models
```

`/pi-extensions-sync` is intentionally interactive because it writes the managed agents globally. In a trusted local checkout, `npm run sync-agents` is the headless equivalent.

## Authenticate the required providers

Authentication is machine-local and is not stored in this repository. Start Pi:

```bash
pi
```

Run `/login` for each provider:

1. **OpenAI Codex** — required for `openai-codex/gpt-5.6-sol`. A supported OpenAI subscription login may be used.
2. **ZAI Coding Plan China** — required for `zai-coding-cn/glm-5.2` in this configuration.
3. **Cursor** — required for `cursor/grok-4.5`. Choose **Use an API key**, choose **Cursor**, and paste a Cursor SDK API key.

`pi-cursor-sdk` does not reuse Cursor Desktop, Cursor CLI, or Cursor subscription login state. It requires a Cursor SDK API key saved through Pi's `/login`, supplied as `CURSOR_API_KEY`, or passed explicitly to Pi.

If Cursor credentials were added after Pi started, refresh its model catalog:

```text
/cursor-refresh-models
```

Then reload and run the complete doctor check:

```text
/reload
/pi-extensions-doctor
```

Doctor should report:

- `@tintinweb/pi-subagents` present
- `pi-cursor-sdk` present
- nine synchronized managed agents
- a matching package root and package version
- `cursor/grok-4.5`
- `openai-codex/gpt-5.6-sol`
- `zai-coding-cn/glm-5.2`

Optional future gauntlet models (`cursor/composer-2-5` and `cursor/kimi-k3`) generate warnings rather than failures when absent.

## Verify the installation

From the shell:

```bash
pi list
pi --list-models
```

From Pi:

```text
/pi-extensions-sync --check
/pi-extensions-doctor
```

From any Git repository, smoke-test a workflow:

```text
/plan-w-panel -- Write a small implementation plan for the requested change
/code-review --staged
```

Plans are stored outside the target repository by default:

```text
~/.claude/plans/<repository>/NNN-<slug>.md
~/.claude/plans/<repository>/NNN-<slug>/
```

No target repository changes to `CLAUDE.md` or `AGENTS.md` are required. Subagents inherit the target project's existing instructions through `prompt_mode: append`.

## Model defaults

| Workflow | Default |
| --- | --- |
| Simplify lenses | `cursor/grok-4.5`, high |
| Code review | `openai-codex/gpt-5.6-sol`, high |
| Adversarial review | `openai-codex/gpt-5.6-sol`, high |
| Plan feasibility | `openai-codex/gpt-5.6-sol`, high |
| Plan risk | `cursor/grok-4.5`, high |
| Plan alternatives | `zai-coding-cn/glm-5.2`, high |

These are workflow defaults, not agent-frontmatter pins. Explicit command arguments and future composed workflows can override them.

## Updating

### Local checkout

```bash
cd pi-extensions
git pull --ff-only
npm ci
npm run check
npm run sync-agents
npm run doctor
```

Then run `/reload` in Pi or restart it.

### Immutable Git installation

Install the new trusted ref using the same source form:

```bash
pi install git:github.com/charliek/pi-extensions@<NEW_TAG_OR_SHA>
```

Then, in a fresh or reloaded Pi process:

```text
/pi-extensions-sync
/reload
/pi-extensions-doctor
```

## Removal

Remove managed agents before removing the package:

```text
/pi-extensions-sync --remove
```

Then inspect `pi list` and remove the package using the same source identity, including its ref when present:

```bash
pi list
pi remove git:github.com/charliek/pi-extensions@<SAME_TAG_OR_SHA>
```

For a local checkout registration, pass the same checkout path originally installed (run from the same directory if it was recorded relatively):

```bash
pi remove /absolute/path/to/pi-extensions
```

Finally run `/reload` or restart Pi. Removing this package does not remove the two prerequisite packages unless they are removed separately.

## Troubleshooting

### Commands are missing

Run `/reload` or start a new Pi process. Confirm the package appears in `pi list`. If another package owns `/plan` or `/simplify`, use `pi config` to disable or reorder the competing prompt template; prompt-template collisions are first-discovered-wins.

### Agent sync fails

Run:

```text
/pi-extensions-sync --check
/pi-extensions-doctor --skip-models
```

Synchronization refuses to overwrite unmanaged or locally modified agent files unless `--force` is explicitly confirmed. Orphan lock files fail closed and should only be removed after confirming no sync or plan-allocation process is active.

### Models are missing

Re-run `/login` for the missing provider. For Cursor, run `/cursor-refresh-models` afterward. Use `pi --list-models` to inspect the live catalog.

### What is not restored automatically

A fresh installation does not migrate:

- provider credentials in `~/.pi/agent/auth.json`
- previous Pi sessions
- existing `~/.claude/plans/`
- personal Pi settings such as theme or default parent model

Copy those separately only when appropriate; never commit credential files.
