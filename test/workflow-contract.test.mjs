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
  assert.match(body, /wait:\s*true|wait: true/);
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
    assert.match(body, /fail closed|complete:\s*false/i);
    assert.match(body, /literal file paths|repository-relative literal/i);
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
    assert.match(content, /fail closed|complete:\s*false/i, `${skill} incomplete bundle`);
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

test("C2 sync-agents installs managed agents and passes --check", () => {
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

test("C3 expected resources exist and validate", () => {
  assert.equal(validateRepository(repositoryRoot), true);
  assert.equal(EXPECTED_RESOURCES.agents.length, 9);
  assert.equal(EXPECTED_RESOURCES.prompts.length, 8);
  assert.equal(EXPECTED_RESOURCES.skills.length, 4);
});

test("C3 plan reviewer agents match read-only charter and omit model pins", () => {
  const planAgents = [
    "px-plan-feasibility-reviewer.md",
    "px-plan-risk-reviewer.md",
    "px-plan-alternatives-reviewer.md",
  ];
  for (const name of planAgents) {
    const content = readResource("agents", name);
    const values = validateAgentDocument(join("agents", name), content);
    assert.ok(!Object.hasOwn(values, "model"), `${name} must omit model`);
    assert.ok(!Object.hasOwn(values, "thinking"), `${name} must omit thinking`);
    assert.equal(values.prompt_mode, "append", `${name} must use prompt_mode append`);
    assert.equal(values.skills, false, `${name} must set skills false`);
    assert.match(String(values.extensions), /pi-cursor-sdk/, `${name} must load pi-cursor-sdk`);
    assert.match(String(values.disallowed_tools), /\bbash\b/, `${name} must disallow bash`);
    assert.match(String(values.disallowed_tools), /\bedit\b/, `${name} must disallow edit`);
    assert.match(String(values.disallowed_tools), /\bwrite\b/, `${name} must disallow write`);
    assert.match(content, /non-overridable/i, `${name} charter`);
    assert.match(content, /Do not edit, write, create, or delete files/, `${name} mutation ban`);
  }
});

test("C3 planning prompts declare canonical commands, schema, and review modes", () => {
  const plan = readResource("prompts", "plan.md");
  const reviewPlan = readResource("prompts", "review-plan.md");

  assert.match(plan, /\/plan — gauntlet plan generation/);
  assert.match(plan, /--review panel\|grok\|codex\|glm/);
  assert.match(plan, /allocate-plan\.mjs/);
  assert.match(plan, /~\/\.claude\/plans\/<primary-repo>\/NNN-<slug>\.md/);
  assert.match(plan, /Verified current state.*file:line/s);
  assert.match(plan, /Pinned design decisions/);
  assert.match(plan, /Acceptance criteria/);
  assert.match(plan, /Verification plan/);
  assert.match(plan, /px-plan-feasibility-reviewer/);
  assert.match(plan, /px-plan-risk-reviewer/);
  assert.match(plan, /px-plan-alternatives-reviewer/);
  assert.match(plan, /openai-codex\/gpt-5\.6-sol/);
  assert.match(plan, /cursor\/grok-4\.5/);
  assert.match(plan, /zai-coding-cn\/glm-5\.2/);
  assert.match(plan, /--model PROVIDER\/MODEL/);
  assert.match(plan, /Explicit flags on this command/);
  assert.match(plan, /PI_EXTENSIONS_ROOT|PI_CODING_AGENT_DIR|PI_EXT_ROOT/);
  assert.match(plan, /fingerprint/);
  assert.match(plan, /Disposition every finding/);
  assert.match(plan, /partial/i);
  assert.match(plan, /first-discovered wins/i);
  assert.match(plan, /disable or reorder the competing prompt resource/i);
  assert.match(plan, /Do not rely on numeric suffixes/i);
  assert.doesNotMatch(plan, /use `\/reload`|\/reload after syncing/i);
  assert.match(plan, /before an optional `--` delimiter|--` delimiter/i);
  assert.match(plan, /explicit plan location override/i);
  assert.match(plan, /PI_PLANS_DIR/);
  assert.match(plan, /explicit user confirmation/i);
  assert.match(plan, /--override-path|--confirm-override/);
  assert.match(plan, /accepted residual risk|prompt\/fingerprint-enforced/i);
  assert.match(plan, /never forward.*allocate-plan|Pass \*\*only\*\*.*allocate-plan/is);
  assert.match(plan, /wait:\s*true|wait: true/);
  assert.match(plan, /do not embed a self-referential hash/i);

  assert.match(reviewPlan, /\/review-plan/);
  assert.match(reviewPlan, /active plan named in conversation/);
  assert.match(reviewPlan, /Do \*\*not\*\* guess from unrelated recent files/);
  assert.match(reviewPlan, /panel.*grok.*codex.*glm/s);
  assert.match(reviewPlan, /self-contained/i);
  assert.doesNotMatch(reviewPlan, /See `\/plan`/);
  assert.match(reviewPlan, /wait:\s*true|wait: true/);
  assert.match(reviewPlan, /px-plan-feasibility-reviewer/);
  assert.match(reviewPlan, /openai-codex\/gpt-5\.6-sol/);
  assert.match(reviewPlan, /cursor\/grok-4\.5/);
  assert.match(reviewPlan, /zai-coding-cn\/glm-5\.2/);
  assert.match(reviewPlan, /Disposition every finding/);
  assert.match(reviewPlan, /partial/i);
  assert.match(reviewPlan, /capture-scope\.mjs/);
});

test("C3 panel review requires three concurrent subagents in one message", () => {
  const plan = readResource("prompts", "plan.md");
  const panel = readResource("prompts", "plan-w-panel.md");

  for (const body of [plan, panel]) {
    assert.match(body, /three (?:concurrent )?(?:reviewers|agents)|three concurrent/i);
    assert.match(body, /run_in_background: true/);
    assert.match(body, /one tool message/i);
    assert.match(body, /get_subagent_result/);
    assert.match(body, /wait:\s*true|wait: true/);
    assert.match(body, /px-plan-feasibility-reviewer/);
    assert.match(body, /openai-codex\/gpt-5\.6-sol/);
    assert.match(body, /px-plan-risk-reviewer/);
    assert.match(body, /cursor\/grok-4\.5/);
    assert.match(body, /px-plan-alternatives-reviewer/);
    assert.match(body, /zai-coding-cn\/glm-5\.2/);
  }
});

test("C3 aliases compose canonical /plan behavior and exclude plan-w-glm", () => {
  const aliasNames = ["plan-w-panel.md", "plan-w-grok.md", "plan-w-codex.md"];
  const allPrompts = allPromptBodies();

  assert.doesNotMatch(allPrompts, /\/plan-w-glm/);
  assert.doesNotMatch(allPrompts, /plan-w-glm/);
  assert.doesNotMatch(allPrompts, /--feasibility-model|--risk-model|--alternatives-model/);

  for (const name of aliasNames) {
    const body = readResource("prompts", name);
    assert.match(body, /\/plan --review/, `${name} must identify canonical behavior`);
    assert.match(body, /self-contained/i, `${name} must execute without nested template expansion`);
    assert.match(body, /allocate-plan\.mjs/, `${name} must allocate the canonical plan location`);
    assert.match(body, /verified.*file:line/is, `${name} must require evidence-backed plan schema`);
    assert.match(body, /before parent edits/i, `${name} must detect reviewer drift before applying findings`);
    assert.match(body, /explicit plan location override/i, `${name} must honor project plan override`);
    assert.match(body, /PI_PLANS_DIR|explicit user confirmation|--confirm-override/i, `${name} override safety`);
    assert.match(body, /Disposition every finding|disposition every finding/i, `${name} must disposition findings`);
    assert.match(body, /partial/i, `${name} must handle partial failures`);
    assert.match(body, /cost|Cost disclosure/i, `${name} must disclose review cost`);
    assert.match(body, /--model PROVIDER\/MODEL|--model.*--thinking/, `${name} must document generic model flags`);
    assert.doesNotMatch(body, /See `\/plan`/, `${name} must not defer to /plan template`);
  }

  assert.match(readResource("prompts", "plan-w-panel.md"), /--review panel/);
  assert.match(readResource("prompts", "plan-w-grok.md"), /--review grok/);
  assert.match(readResource("prompts", "plan-w-codex.md"), /--review codex/);
  assert.match(readResource("prompts", "plan-w-panel.md"), /wait:\s*true|wait: true/);
});

test("C3 planning skill is self-contained with allocation, panel, and drift rules", () => {
  const content = readResource("skills", "planning");
  assert.match(content, /allocate-plan\.mjs/);
  assert.match(content, /PI_EXTENSIONS_ROOT|PI_CODING_AGENT_DIR/);
  assert.match(content, /px-plan-feasibility-reviewer/);
  assert.match(content, /px-plan-risk-reviewer/);
  assert.match(content, /px-plan-alternatives-reviewer/);
  assert.match(content, /three concurrent/i);
  assert.match(content, /no.*\/plan-w-glm/i);
  assert.match(content, /fingerprint|drift/i);
  assert.match(content, /partial/i);
  assert.match(content, /wait:\s*true|wait: true/);
  assert.match(content, /Explicit.*Active.*Ask|explicit.*active.*ask/is);
  assert.match(content, /explicit plan location override/i);
  assert.match(content, /PI_PLANS_DIR|explicit user confirmation|--confirm-override/i);
  assert.match(content, /natural language|write a plan for/i);
  assert.match(content, /review only|review this plan/i);
  assert.match(content, /Argument parsing|-- delimiter/i);
});

test("C3 distinguishes Pi tool restriction from Cursor prompt enforcement for Grok risk reviewer", () => {
  const risk = readResource("agents", "px-plan-risk-reviewer.md");
  assert.match(risk, /Use only read, grep, find, and ls Pi tools/);
  assert.match(risk, /If Cursor SDK or other native tools are available/);
  assert.match(risk, /never for mutation/);
});

test("C3 sync-agents installs nine managed agents including plan reviewers", () => {
  const agentHome = mkdtempSync(join(tmpdir(), "px-c3-sync-"));
  const result = syncAgents({
    packageRoot: repositoryRoot,
    agentHome,
    check: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.managedCount, 9);

  for (const name of [
    "px-plan-feasibility-reviewer.md",
    "px-plan-risk-reviewer.md",
    "px-plan-alternatives-reviewer.md",
  ]) {
    assert.ok(
      Object.hasOwn(result.manifest.files, name),
      `manifest must track ${name}`,
    );
  }
});

test("C4 setup extension and documentation contract", () => {
  const readme = readFileSync(join(repositoryRoot, "README.md"), "utf8");
  const contributing = readFileSync(join(repositoryRoot, "CONTRIBUTING.md"), "utf8");
  const setupSource = readFileSync(join(repositoryRoot, "extensions/setup.js"), "utf8");

  for (const doc of [readme, contributing]) {
    assert.match(doc, /@tintinweb\/pi-subagents/, "must document pi-subagents prerequisite");
    assert.match(doc, /pi-cursor-sdk/, "must document pi-cursor-sdk prerequisite");
    assert.match(doc, /sync-agents|pi-extensions-sync/, "must document agent sync");
    assert.match(doc, /\/reload/, "must document /reload");
    assert.match(doc, /first-discovered wins|first wins/i, "must document prompt-template collisions");
    assert.match(doc, /extension command|numeric suffix/i, "must document extension command collisions");
    assert.match(doc, /partial/i, "must document partial failures");
    assert.match(doc, /cursor\/grok-4\.5/, "must document Grok default");
    assert.match(doc, /prompt-enforced|Cursor-native|not.*sandbox/i, "must document Cursor caveat");
    assert.match(doc, /~\/\.claude\/plans/, "must document planning path");
    assert.match(doc, /gauntlet|gated-commit/i, "must mention future gauntlet scope");
    assert.match(doc, /never writes globally|Importing this package never/i, "must state import never writes");
  }

  assert.match(readme, /pi install \./, "local install must use pi install .");
  assert.doesNotMatch(readme, /pi install \.\/pi-extensions/);
  assert.match(readme, /immutable|tag|SHA|@v/i, "git install must recommend pinned refs");
  assert.match(readme, /Implemented|implemented/, "README status must not remain scaffold-only");
  assert.doesNotMatch(readme, /scaffold is in place/i);

  assert.match(setupSource, /registerCommand\(\s*SYNC_COMMAND|registerCommand\(\s*["']pi-extensions-sync["']/);
  assert.match(setupSource, /registerCommand\(\s*DOCTOR_COMMAND|registerCommand\(\s*["']pi-extensions-doctor["']/);
  assert.match(setupSource, /ctx\.hasUI/);
  assert.match(setupSource, /ctx\.ui\.confirm/);
  assert.match(setupSource, /await runPackageScript|runPackageScript/);
  assert.doesNotMatch(setupSource, /spawnSync/);
  assert.doesNotMatch(setupSource, /writeFileSync|mkdirSync|unlinkSync/);
});
