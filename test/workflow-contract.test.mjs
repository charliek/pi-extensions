import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  EXPECTED_RESOURCES,
  parseFrontmatter,
  validateAgentDocument,
  validateRepository,
} from "../scripts/validate-resources.mjs";
import { syncAgents } from "../scripts/sync-agents.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

function readResource(kind, relative) {
  if (kind === "skills") {
    return readFileSync(join(repositoryRoot, "skills", relative, "SKILL.md"), "utf8");
  }
  return readFileSync(join(repositoryRoot, kind, relative), "utf8");
}

function allPromptBodies() {
  return EXPECTED_RESOURCES.prompts.map((name) => readResource("prompts", name)).join("\n");
}

function allAgentBodies() {
  return EXPECTED_RESOURCES.agents.map((name) => readResource("agents", name)).join("\n");
}

test("C2 expected resources exist and validate", () => {
  assert.equal(validateRepository(repositoryRoot), true);
});

test("C2 agent frontmatter omits model/thinking and restricts Pi tools", () => {
  for (const name of EXPECTED_RESOURCES.agents) {
    const content = readResource("agents", name);
    const values = validateAgentDocument(join("agents", name), content);
    assert.ok(!Object.hasOwn(values, "model"), `${name} must omit model`);
    assert.ok(!Object.hasOwn(values, "thinking"), `${name} must omit thinking`);
    assert.equal(values.prompt_mode, "append", `${name} must use prompt_mode append`);
    assert.equal(values.skills, false, `${name} must set skills false`);
    assert.match(String(values.disallowed_tools), /\bbash\b/, `${name} must disallow bash`);
    assert.match(String(values.disallowed_tools), /\bedit\b/, `${name} must disallow edit`);
    assert.match(String(values.disallowed_tools), /\bwrite\b/, `${name} must disallow write`);
  }
});

test("C2 reviewers load pi-cursor-sdk so callers may override to Cursor models", () => {
  for (const name of EXPECTED_RESOURCES.agents) {
    const { values } = parseFrontmatter(readResource("agents", name), name);
    assert.match(String(values.extensions), /pi-cursor-sdk/, `${name} must load pi-cursor-sdk`);
  }
});

test("C2 agent bodies declare non-overridable report-only charter", () => {
  const bodies = allAgentBodies();
  assert.match(bodies, /non-overridable/i);
  assert.match(bodies, /Do not edit, write, create, or delete files/);
  assert.match(bodies, /Do not run shell commands/);
  assert.match(bodies, /The parent alone|parent alone|parent validates|Do not apply changes/);
});

test("C2 prompts declare default models and override precedence", () => {
  const simplify = readResource("prompts", "simplify.md");
  const codeReview = readResource("prompts", "code-review.md");
  const adversarial = readResource("prompts", "adversarial-review.md");

  assert.match(simplify, /cursor\/grok-4\.5/);
  assert.match(simplify, /`high` thinking/);
  assert.match(codeReview, /openai-codex\/gpt-5\.6-sol/);
  assert.match(adversarial, /openai-codex\/gpt-5\.6-sol/);

  for (const body of [simplify, codeReview, adversarial]) {
    assert.match(body, /--model PROVIDER\/MODEL/);
    assert.match(body, /--thinking LEVEL/);
    assert.match(body, /Explicit flags on this command/);
    assert.match(body, /Primitive default/);
    assert.match(body, /Parent's current model/);
  }
});

test("C2 simplify prompt requires four concurrent Grok lenses and parent-only edits", () => {
  const body = readResource("prompts", "simplify.md");
  assert.match(body, /four concurrent/i);
  assert.match(body, /run_in_background: true/);
  assert.match(body, /get_subagent_result/);
  assert.match(body, /unified diff\/scope bundle/i);
  assert.match(body, /px-simplify-reuse/);
  assert.match(body, /px-simplify-structure/);
  assert.match(body, /px-simplify-efficiency/);
  assert.match(body, /px-simplify-altitude/);
  assert.match(body, /Only the parent agent may edit/);
  assert.match(body, /partial/i);
  assert.match(body, /fingerprint/);
  assert.match(body, /capture-scope\.mjs/);
  assert.match(body, /build-scope-bundle\.mjs/);
  assert.match(body, /packageRoot|PI_EXTENSIONS_ROOT|PI_EXT_ROOT|PI_CODING_AGENT_DIR/i);
  assert.match(body, /before\/after|pre-review fingerprint/i);
  assert.match(body, /four concurrent high-reasoning Grok/i);
});

test("C2 review prompts are report-only and fingerprint scoped changes", () => {
  for (const name of ["code-review.md", "adversarial-review.md"]) {
    const body = readResource("prompts", name);
    assert.match(body, /Do not fix findings/);
    assert.match(body, /px-(code|adversarial)-reviewer/);
    assert.match(body, /fingerprint/);
    assert.match(body, /unified diff\/scope bundle/i);
    assert.match(body, /build-scope-bundle\.mjs/);
    assert.match(body, /capture-scope\.mjs/);
    assert.match(body, /explicit --path|--path FILE/i);
    assert.match(body, /focus text or none/i);
    assert.match(body, /drift|before\/after|post-review fingerprint/i);
    assert.doesNotMatch(body, /\$\{focus or "none"\}/);
  }
});

test("C2 skills include self-contained scope, bundle, model, and drift workflow", () => {
  for (const skill of ["simplify", "code-review", "adversarial-review"]) {
    const content = readResource("skills", skill);
    assert.match(content, /capture-scope\.mjs/, `${skill} scope helper`);
    assert.match(content, /build-scope-bundle\.mjs/, `${skill} bundle helper`);
    assert.match(content, /PI_EXTENSIONS_ROOT|packageRoot|PI_CODING_AGENT_DIR/, `${skill} root resolution`);
    assert.match(content, /--path|--focus|explicit flags/i, `${skill} explicit flags`);
    if (skill === "simplify") {
      assert.match(content, /four concurrent|px-simplify-reuse/, `${skill} lenses`);
      assert.match(content, /cursor\/grok-4\.5/, `${skill} default model`);
      assert.match(content, /fingerprint.*before|before.*fingerprint|drift/i, `${skill} drift`);
    } else {
      assert.match(content, /openai-codex\/gpt-5\.6-sol/, `${skill} default model`);
      assert.match(content, /drift|fingerprint changed/i, `${skill} drift`);
    }
  }
});

test("C2 distinguishes Pi tool restriction from Cursor prompt enforcement for Grok lenses", () => {
  const simplifyAgents = allAgentBodies();
  assert.match(simplifyAgents, /Use only read, grep, find, and ls Pi tools/);
  assert.match(simplifyAgents, /If Cursor SDK or other native tools are available/);
  assert.match(simplifyAgents, /never for mutation/);

  const simplifyPrompt = readResource("prompts", "simplify.md");
  assert.match(simplifyPrompt, /Reviewers must not edit, write, bash/);
});

test("C2 sync-agents installs six managed agents and passes --check", () => {
  const agentHome = mkdtempSync(join(tmpdir(), "px-c2-sync-"));
  const result = syncAgents({
    packageRoot: repositoryRoot,
    agentHome,
    check: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.managedCount, EXPECTED_RESOURCES.agents.length);

  const check = syncAgents({
    packageRoot: repositoryRoot,
    agentHome,
    check: true,
  });
  assert.equal(check.ok, true);
  assert.equal(check.managedCount, EXPECTED_RESOURCES.agents.length);
  assert.equal(result.manifest.packageRoot, repositoryRoot);
});

test("C2 prompt set excludes planning aliases (C3 scope)", () => {
  const prompts = allPromptBodies();
  assert.doesNotMatch(prompts, /\/plan-w-glm/);
  assert.doesNotMatch(prompts, /\/plan\b/);
});
