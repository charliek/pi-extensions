# pi-extensions

Personal [Pi](https://pi.dev) skills and agents for six workflows: **planning**, **code review**, **simplify**, **CodeRabbit**, **flows** (gauntlet / gated-commit), and **git** (watch-pr / merge-pr). One local package; units are directories you can delete wholesale.

## Units

```text
units/
  planning/     skill: planning          agent: px-plan-reviewer
  review/       skill: code-review       agent: px-reviewer
  simplify/     skill: simplify          agent: px-simplifier
  coderabbit/   skill: coderabbit        (CLI knowledge; no agent)
  flows/        skills: gauntlet, gated-commit
  git/          skills: watch-pr, merge-pr
```

Each unit owns its skill(s) and any agents. Removing `units/<name>/` removes that workflow. The remaining skills still load and run — no dangling references — but a step that reached into the removed unit degrades to a named fallback and says so:

| Removed | Effect elsewhere |
| --- | --- |
| `review` | `gated-commit` review chain drops to parent self-review; `simplify` notes bugs instead of routing them |
| `coderabbit` | `gated-commit` skips its second reviewer; `code-review` and `planning` lose the optional CLI pass |
| `simplify` | `gauntlet` and `gated-commit` skip the simplify pass |
| `planning` | `gauntlet` writes a plan itself and skips the panel |
| `git` | `gauntlet` watches with `gh pr checks` instead of `watch-pr` |
| `flows` | no behavior change elsewhere; other units mention it only as "when present" |

## When to reach for what

| Situation | Skill |
| --- | --- |
| Write or panel-review a plan | `planning` |
| Large refactor / full plan → PR lifecycle | `gauntlet` |
| Single coherent change that deserves the discipline | `gated-commit` |
| Typos, docs, mechanical renames | neither flow — commit normally |
| Review a diff (correctness or adversarial) | `code-review` |
| Behavior-preserving cleanup | `simplify` |
| Local CodeRabbit CLI on a git diff | `coderabbit` |
| Babysit a PR to green (CI + bot reviews) | `watch-pr` |
| Merge a green PR | `merge-pr` |

## Commit authority

- `gated-commit` — invoking it authorizes **exactly one** commit; it never pushes.
- Nested `simplify` / `code-review` stay report-only; only the gated-commit parent commits.
- `watch-pr` commits and pushes fix commits autonomously, with a circuit breaker if the same check fails twice.
- `merge-pr` never merges unless invoked directly; gauntlet leaves PRs open by default.
- `planning`, `simplify`, `code-review`, and all reviewer charters never commit.

## Models and cost

Defaults stay on free or flat-rate providers on this machine. Every launch site names its model explicitly (session defaults may be API-rate).

| Role | Default |
| --- | --- |
| Plan panel | `openai-codex/gpt-5.6-sol`, `cursor/grok-4.5`, `zai-coding-cn/glm-5.2` (all high) |
| Code review | `openai-codex/gpt-5.6-sol` (high); gated-commit falls back to CodeRabbit CLI, then `cursor/grok-4.5` |
| Simplify | `cursor/grok-4.5` (high), four lenses |
| Gauntlet discovery | `cursor/composer-2.5` (no thinking level); escalate hard surfaces to grok/kimi |
| Gauntlet implementation | `cursor/kimi-k3` (critical), `cursor/grok-4.5` (normal), `cursor/composer-2.5` (mechanical) |
| watch-pr triage / fixes | `cursor/composer-2.5` / `cursor/grok-4.5` |

Every subagent label is prefixed with its model, e.g. `(sol) Review C3`.

## Install

Requires Git, Node.js 22.19+, and Pi. Also install `@tintinweb/pi-subagents` (and `pi-cursor-sdk` if you use Cursor-backed models).

```bash
git clone https://github.com/charliek/pi-extensions.git
cd pi-extensions
pi install .
bash bin/link-agents.sh
```

Then `/reload` in Pi (or restart). Authenticate providers you need (`openai-codex`, `cursor`, `zai-coding-cn`) via Pi `/login`. For `watch-pr` / `merge-pr`, install and authenticate the GitHub CLI (`gh`).

**Update:** `git pull` in the checkout, then re-run `bash bin/link-agents.sh` whenever agent files or units are added, renamed, or removed — the same pass that creates new links prunes stale ones.

## Agent linking

Pi has no agents manifest key. Custom agents are discovered from `~/.pi/agent/agents/*.md` (override home with `PI_CODING_AGENT_DIR`). This package installs them by symlink:

```bash
bash bin/link-agents.sh
# or: npm run link-agents
```

The script links every `units/*/agents/*.md` into `$PI_CODING_AGENT_DIR/agents` (default `~/.pi/agent/agents`). It replaces existing symlinks, refuses to overwrite regular files, prunes its own stale links (symlinks whose target is under this repo's `units/` but no longer desired), and is safe to re-run.

Agents: `px-plan-reviewer`, `px-reviewer`, `px-simplifier`. Model, thinking, and lens/emphasis are passed per invocation.

## Invoke skills

Natural language (Pi matches on skill descriptions):

- "write this up as a plan" / "panel review the plan"
- "run the gauntlet" / "write and execute a plan"
- "gated commit" / "commit with review"
- "code review my diff" / "adversarial review"
- "simplify this" / "deslop"
- "run coderabbit"
- "watch this PR" / "get CI green"
- "merge this PR"

Or force a full skill read:

```text
/skill:planning
/skill:gauntlet
/skill:gated-commit
/skill:code-review
/skill:simplify
/skill:coderabbit
/skill:watch-pr
/skill:merge-pr
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
- The test suite that only covered the deleted infrastructure
- Nine per-lens agent charters (collapsed to three parameterized charters)
- Multi-repo gauntlet orchestration (single-repo only for now)

## Layout

```text
bin/link-agents.sh
scripts/allocate-plan.mjs
units/*/skills/*/SKILL.md
units/*/agents/px-*.md
package.json          # pi.skills = ["./units/*/skills"]
```
