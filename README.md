# pi-extensions

Portable, version-controlled extensions and workflow primitives for the [Pi coding agent](https://pi.dev).

## Goals

This project will provide standalone, composable primitives for:

- planning and panel review;
- code simplification;
- correctness-focused code review;
- adversarial review;
- gated commits; and
- a higher-level gauntlet workflow.

Workflow behavior belongs here rather than in every target repository's `CLAUDE.md` or `AGENTS.md`. Agents can still inherit and follow each target project's local instructions.

## Layout

```text
agents/       @tintinweb/pi-subagents agent definitions
extensions/   Pi TypeScript extensions
prompts/      Global slash-command prompt templates
skills/       Agent Skills used for natural-language workflow discovery
scripts/      Installation and validation utilities
test/         Repository contract tests
```

Pi packages natively discover extensions, prompts, and skills through `package.json`. The custom agents in `agents/` will be synchronized to Pi's global agent directory by an installation utility added with the first workflow implementation.

## Development

Requires Node.js 22.19 or newer.

```bash
npm install
npm run check
```

## Planning convention

Plans and verification artifacts remain outside source repositories and are shared with the existing Claude Code workflows:

```text
~/.claude/plans/<primary-repo>/NNN-<slug>.md
~/.claude/plans/<primary-repo>/NNN-<slug>/
```

For this repository, plans live under `~/.claude/plans/pi-extensions/` unless a future repository instruction explicitly overrides that location.

## Status

The repository scaffold is in place. Workflow primitives will be implemented in follow-up commits after a written, panel-reviewed plan.

## License

MIT
