import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  parseFrontmatter,
  validateAgentDocument,
  validateRepository,
  validateSkillDocument,
} from "../scripts/validate-resources.mjs";
import {
  collectCursorModelIds,
  parsePiModelTable,
  runDoctor,
} from "../scripts/doctor.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

function scaffoldRoot() {
  const root = mkdtempSync(join(tmpdir(), "pi-extensions-test-"));
  for (const directory of ["agents", "extensions", "prompts", "skills"]) {
    mkdirSync(join(root, directory));
  }
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "0.0.0",
      pi: { extensions: ["./extensions"], skills: ["./skills"], prompts: ["./prompts"] },
    }),
  );
  return root;
}

test("repository resource contract is valid", () => {
  assert.equal(validateRepository(repositoryRoot), true);
});

test("validator rejects a package without resource directories", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensions-test-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ pi: { extensions: ["./extensions"], skills: ["./skills"], prompts: ["./prompts"] } }),
  );

  assert.throws(() => validateRepository(root), /required resource directory is missing/);
});

test("YAML frontmatter parser rejects malformed mappings and accepts nested values", () => {
  assert.throws(() => parseFrontmatter("nope\n", "x.md"), /missing YAML frontmatter/);
  const { values } = parseFrontmatter(
    `---
description: nested
tools:
  - read
  - grep
---
body
`,
    "x.md",
  );
  assert.deepEqual(values.tools, ["read", "grep"]);
});

test("validator rejects model/thinking pins and mutating reviewer tools", () => {
  assert.throws(
    () =>
      validateAgentDocument(
        "agents/px-code-reviewer.md",
        `---
description: review
model: cursor/grok-4.5
---
body
`,
      ),
    /omit model and thinking/,
  );

  assert.throws(
    () =>
      validateAgentDocument(
        "agents/px-code-reviewer.md",
        `---
description: review
tools: read, bash
disallowed_tools: bash, edit, write
---
body
`,
      ),
    /may only include/,
  );

  assert.throws(
    () =>
      validateAgentDocument(
        "agents/px-simplify-reuse.md",
        `---
description: reuse
tools: read, grep, find, ls
disallowed_tools: edit, write
---
body
`,
      ),
    /disallowed_tools including bash/,
  );

  const ok = validateAgentDocument(
    "agents/px-code-reviewer.md",
    `---
description: review
tools: read, grep, find, ls
disallowed_tools: bash, edit, write
prompt_mode: append
---
body
`,
  );
  assert.equal(ok.description, "review");
});

test("validator requires non-empty string fields and bodies", () => {
  assert.throws(
    () =>
      validateAgentDocument(
        "agents/px-code-reviewer.md",
        `---
description: "   "
tools: read
disallowed_tools: bash, edit, write
---
body
`,
      ),
    /non-empty string/,
  );

  assert.throws(
    () =>
      validateAgentDocument(
        "agents/px-code-reviewer.md",
        `---
description: review
tools: read, grep, find, ls
disallowed_tools: bash, edit, write
---
`,
      ),
    /body must be a non-empty string/,
  );

  assert.throws(
    () =>
      validateSkillDocument(
        "skills/demo/SKILL.md",
        `---
name: demo
description: ""
---
body
`,
      ),
    /non-empty string/,
  );
});

test("validator rejects non px- agent filenames and malformed skills", () => {
  const root = scaffoldRoot();
  writeFileSync(
    join(root, "agents", "code-reviewer.md"),
    `---
description: bad name
---
body
`,
  );
  assert.throws(() => validateRepository(root), /px- prefix/);

  const root2 = scaffoldRoot();
  mkdirSync(join(root2, "skills", "Bad"));
  writeFileSync(
    join(root2, "skills", "Bad", "SKILL.md"),
    `---
name: Bad
description: nope
---
body
`,
  );
  assert.throws(() => validateRepository(root2), /kebab-case/);
});

test("validator requires expected skills to resolve to SKILL.md files", () => {
  const root = scaffoldRoot();
  assert.throws(
    () =>
      validateRepository(root, {
        expectedResources: { agents: ["px-code-reviewer.md"], prompts: [], skills: [] },
      }),
    /missing expected agents resource/,
  );

  mkdirSync(join(root, "skills", "demo"));
  writeFileSync(join(root, "skills", "demo", "README.md"), "not a skill\n");
  assert.throws(
    () =>
      validateRepository(root, {
        expectedResources: { agents: [], prompts: [], skills: ["demo"] },
      }),
    /missing expected skills SKILL.md/,
  );

  writeFileSync(
    join(root, "skills", "demo", "SKILL.md"),
    `---
name: demo
description: demo skill
---
Do things.
`,
  );
  assert.equal(
    validateRepository(root, {
      expectedResources: { agents: [], prompts: [], skills: ["demo"] },
    }),
    true,
  );
});

test("doctor reports missing prerequisites against an empty agent home", () => {
  const agentHome = mkdtempSync(join(tmpdir(), "px-doctor-"));
  const result = runDoctor({
    packageRoot: repositoryRoot,
    agentHome,
    requiredModels: [],
    skipModelProbe: true,
  });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) => item.code === "pi-packages-missing"));
});

test("doctor parses provider/model tables and Cursor aliases from fixtures", () => {
  const table = `provider       model                                           context  max-out  thinking  images
cursor         grok-4.5                                        200K     16.4K    yes       yes
openai-codex   gpt-5.6-sol                                     200K     16.4K    yes       no
zai-coding-cn  glm-5.2                                         200K     16.4K    yes       yes
`;
  const parsed = parsePiModelTable(table);
  assert.ok(parsed.has("cursor/grok-4.5"));
  assert.ok(parsed.has("openai-codex/gpt-5.6-sol"));
  assert.ok(parsed.has("zai-coding-cn/glm-5.2"));

  const aliases = collectCursorModelIds({
    version: 1,
    models: [
      {
        id: "grok-4.5",
        aliases: ["grok", "grok45"],
        variants: [{ id: "grok-4.5:fast" }],
      },
      {
        id: "composer-2-5",
        aliases: ["composer-2.5"],
      },
    ],
  });
  assert.ok(aliases.has("cursor/grok-4.5"));
  assert.ok(aliases.has("cursor/grok"));
  assert.ok(aliases.has("cursor/grok45"));
  assert.ok(aliases.has("cursor/grok-4.5:fast"));
  assert.ok(aliases.has("cursor/composer-2-5"));
  assert.ok(aliases.has("cursor/composer-2.5"));

  const agentHome = mkdtempSync(join(tmpdir(), "px-doctor-models-"));
  writeFileSync(
    join(agentHome, "cursor-sdk-model-list.json"),
    JSON.stringify({
      models: [{ id: "kimi-k3", aliases: ["kimi"] }],
    }),
  );
  const result = runDoctor({
    packageRoot: repositoryRoot,
    agentHome,
    requiredPackages: [],
    requiredModels: ["cursor/grok-4.5", "cursor/kimi-k3"],
    skipModelProbe: false,
    listModelsOutput: table,
  });
  assert.ok(result.diagnostics.some((item) => item.code === "model-present" && /grok-4.5/.test(item.message)));
  assert.ok(result.diagnostics.some((item) => item.code === "model-present" && /kimi-k3/.test(item.message)));
});
