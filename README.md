# pi-extensions

Personal [Pi](https://pi.dev) skills and agents for four workflows: **planning**, **code review**, **simplify**, and **CodeRabbit**. One local package; units are directories you can delete wholesale.

## Units

```text
units/
  planning/     skill: planning          agent: px-plan-reviewer
  review/       skill: code-review       agent: px-reviewer
  simplify/     skill: simplify          agent: px-simplifier
  coderabbit/   skill: coderabbit        (CLI knowledge; no agent)
```

Each unit owns its skill and any agents. Removing `units/<name>/` removes that workflow; the other three keep working.

## Install

Requires Git, Node.js 22.19+, and Pi. Also install `@tintinweb/pi-subagents` (and `pi-cursor-sdk` if you use Cursor-backed models).

```bash
git clone https://github.com/charliek/pi-extensions.git
cd pi-extensions
pi install .
bash bin/link-agents.sh
```

Then `/reload` in Pi (or restart). Authenticate providers you need (`openai-codex`, `cursor`, `zai-coding-cn`) via Pi `/login`.

**Update:** `git pull` in the checkout, then re-run `bash bin/link-agents.sh` if agent files were added or renamed.

## Agent linking

Pi has no agents manifest key. Custom agents are discovered from `~/.pi/agent/agents/*.md` (override home with `PI_CODING_AGENT_DIR`). This package installs them by symlink:

```bash
bash bin/link-agents.sh
# or: npm run link-agents
```

The script links every `units/*/agents/*.md` into `$PI_CODING_AGENT_DIR/agents` (default `~/.pi/agent/agents`). It replaces existing symlinks, refuses to overwrite regular files, prunes its own stale links (symlinks whose target is under this repo's `units/` but no longer desired), and is safe to re-run.

Agents: `px-plan-reviewer`, `px-reviewer`, `px-simplifier`. Model, thinking, and lens are passed per invocation — one charter serves multi-model panels.

## Invoke skills

Natural language (Pi matches on skill descriptions):

- "write this up as a plan" / "panel review the plan"
- "code review my diff" / "adversarial review"
- "simplify this" / "deslop"
- "run coderabbit"

Or force a full skill read:

```text
/skill:planning
/skill:code-review
/skill:simplify
/skill:coderabbit
```

Skills accept optional model/thinking overrides in the request text. Plans allocate via:

```bash
node scripts/allocate-plan.mjs --slug <slug>
# npm run allocate-plan -- --slug <slug>
```

Honors `PI_PLANS_DIR` (default `~/.claude/plans`). Prints `planPath` then `artifactsDir`.

## Intentionally removed

Relative to earlier revisions of this repo:

- Prompt templates (`/plan`, `/simplify`, …) — skills cover `/skill:name` instead
- Diff fingerprint / scope-bundle helpers and the setup extension
- Agent file copying and the managed-agents manifest (replaced by `bin/link-agents.sh`)
- Doctor command and plan-location override flags on the allocator
- Multi-stage flow orchestration language in skill/prompt text
- The test suite that only covered the deleted infrastructure
- Nine per-lens agent charters (collapsed to three lens-parameterized charters)

## Layout

```text
bin/link-agents.sh
scripts/allocate-plan.mjs
units/*/skills/*/SKILL.md
units/*/agents/px-*.md
package.json          # pi.skills = ["./units/*/skills"]
```
