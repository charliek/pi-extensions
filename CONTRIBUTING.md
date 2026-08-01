# Contributing

## Requirements

- Node.js 22.19 or newer
- Pi 0.80.9 or newer for provider-extension compatibility

## Checks

Run before committing:

```bash
npm install
npm run check
```

The validator checks the Pi package manifest, required resource directories, and required Markdown frontmatter. Tests use Node's built-in test runner so the repository has no development dependencies yet.

## Resource conventions

- Agents: `agents/<name>.md` with a `description` frontmatter field.
- Prompts: `prompts/<command>.md` with a `description` frontmatter field.
- Skills: `skills/<name>/SKILL.md` with `name` and `description` frontmatter fields.
- Extensions: place each multi-file extension under `extensions/<name>/` with `index.ts` as its entry point.

Workflow resources must remain portable across target projects. They may inherit target-project instructions, but should not require workflow-specific additions to those projects' `CLAUDE.md` or `AGENTS.md` files.
