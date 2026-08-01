import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const REQUIRED_DIRECTORIES = ["agents", "extensions", "prompts", "skills"];

/** C2 simplify/review primitives; C3 planning primitive and panel review. */
export const EXPECTED_RESOURCES = {
  agents: [
    "px-simplify-reuse.md",
    "px-simplify-structure.md",
    "px-simplify-efficiency.md",
    "px-simplify-altitude.md",
    "px-code-reviewer.md",
    "px-adversarial-reviewer.md",
    "px-plan-feasibility-reviewer.md",
    "px-plan-risk-reviewer.md",
    "px-plan-alternatives-reviewer.md",
  ],
  prompts: [
    "simplify.md",
    "code-review.md",
    "adversarial-review.md",
    "plan.md",
    "review-plan.md",
    "plan-w-panel.md",
    "plan-w-grok.md",
    "plan-w-codex.md",
  ],
  skills: ["simplify", "code-review", "adversarial-review", "planning"],
};

const REVIEWER_TOOL_ALLOWLIST = new Set(["read", "grep", "find", "ls"]);
const REVIEWER_TOOL_DENYLIST = ["bash", "edit", "write"];

function markdownFiles(directory, recursive = false) {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return recursive ? markdownFiles(path, true) : [];
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

export function parseFrontmatter(content, path = "<memory>") {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    throw new Error(`${path}: missing YAML frontmatter`);
  }

  const normalized = content.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`${path}: unterminated YAML frontmatter`);

  let values;
  try {
    values = parseYaml(match[1], { uniqueKeys: true });
  } catch (error) {
    throw new Error(`${path}: invalid YAML frontmatter: ${error.message}`);
  }

  if (values == null || typeof values !== "object" || Array.isArray(values)) {
    throw new Error(`${path}: frontmatter must be a YAML mapping`);
  }

  return {
    values,
    body: normalized.slice(match[0].length),
  };
}

function requireNonEmptyStringFields(path, values, keys) {
  for (const key of keys) {
    const value = values[key];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${path}: frontmatter field '${key}' must be a non-empty string`);
    }
  }
}

function requireNonEmptyBody(path, body) {
  if (typeof body !== "string" || !body.trim()) {
    throw new Error(`${path}: document body must be a non-empty string`);
  }
}

function csvItems(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && item.toLowerCase() !== "none");
}

export function isReviewerAgentFilename(name) {
  return /(reviewer|simplify|adversarial)/i.test(name);
}

export function validateAgentDocument(path, content) {
  const { values, body } = parseFrontmatter(content, path);
  requireNonEmptyStringFields(path, values, ["description"]);

  if (Object.hasOwn(values, "model") || Object.hasOwn(values, "thinking")) {
    throw new Error(`${path}: agent frontmatter must omit model and thinking so callers can override routing`);
  }

  const base = path.split(/[\\/]/).at(-1) ?? path;
  if (base.endsWith(".md") && base !== ".gitkeep" && !base.startsWith("px-") && base !== "README.md") {
    throw new Error(`${path}: managed agent filenames must use the px- prefix`);
  }

  if (isReviewerAgentFilename(base)) {
    const tools = csvItems(values.tools);
    const disallowed = new Set(csvItems(values.disallowed_tools).map((item) => item.toLowerCase()));

    if (tools.length === 0) {
      throw new Error(`${path}: reviewer agents must set an explicit read-only tools allowlist`);
    }

    for (const tool of tools) {
      const normalized = tool.toLowerCase();
      if (normalized === "*" || normalized === "all") {
        throw new Error(`${path}: reviewer agents must not allow all tools`);
      }
      if (normalized.startsWith("ext:")) continue;
      if (!REVIEWER_TOOL_ALLOWLIST.has(normalized)) {
        throw new Error(
          `${path}: reviewer tools may only include ${[...REVIEWER_TOOL_ALLOWLIST].join(", ")}; found '${tool}'`,
        );
      }
    }

    for (const denied of REVIEWER_TOOL_DENYLIST) {
      if (!disallowed.has(denied)) {
        throw new Error(`${path}: reviewer agents must set disallowed_tools including ${denied}`);
      }
    }
  }

  requireNonEmptyBody(path, body);
  return values;
}

export function validatePromptDocument(path, content) {
  const { values, body } = parseFrontmatter(content, path);
  requireNonEmptyStringFields(path, values, ["description"]);
  requireNonEmptyBody(path, body);
  return values;
}

export function validateSkillDocument(path, content) {
  const { values, body } = parseFrontmatter(content, path);
  requireNonEmptyStringFields(path, values, ["name", "description"]);
  requireNonEmptyBody(path, body);
  if (typeof values.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(values.name)) {
    throw new Error(`${path}: skill name must be lowercase kebab-case`);
  }
  return values;
}

/**
 * Expected skills must resolve to an actual SKILL.md file (directory/SKILL.md or explicit path).
 */
function assertExpectedResources(root, expected = EXPECTED_RESOURCES) {
  for (const [kind, relatives] of Object.entries(expected)) {
    for (const relative of relatives) {
      if (kind === "skills") {
        const skillMdCandidates = relative.endsWith("SKILL.md")
          ? [join(root, "skills", relative)]
          : [
              join(root, "skills", relative, "SKILL.md"),
              join(root, "skills", `${relative}.md`),
            ];
        if (!skillMdCandidates.some((candidate) => existsSync(candidate) && statSync(candidate).isFile())) {
          throw new Error(`missing expected skills SKILL.md resource: ${relative}`);
        }
        continue;
      }

      const path = join(root, kind, relative);
      if (!existsSync(path)) {
        throw new Error(`missing expected ${kind} resource: ${relative}`);
      }
    }
  }
}

export function validateRepository(root, { expectedResources = EXPECTED_RESOURCES } = {}) {
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath)) throw new Error(`${packagePath}: missing`);

  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  if (!manifest.pi) throw new Error("package.json: missing pi manifest");

  for (const directory of REQUIRED_DIRECTORIES) {
    const path = join(root, directory);
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new Error(`${path}: required resource directory is missing`);
    }
  }

  for (const resource of ["extensions", "skills", "prompts"]) {
    const entries = manifest.pi[resource];
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`package.json: pi.${resource} must be a non-empty array`);
    }
    for (const entry of entries) {
      const path = resolve(root, entry);
      if (!existsSync(path)) throw new Error(`package.json: pi.${resource} path does not exist: ${entry}`);
    }
  }

  for (const path of markdownFiles(join(root, "agents"))) {
    validateAgentDocument(path, readFileSync(path, "utf8"));
  }
  for (const path of markdownFiles(join(root, "prompts"))) {
    validatePromptDocument(path, readFileSync(path, "utf8"));
  }
  for (const path of markdownFiles(join(root, "skills"), true).filter((candidate) =>
    candidate.endsWith("SKILL.md"),
  )) {
    validateSkillDocument(path, readFileSync(path, "utf8"));
  }

  assertExpectedResources(root, expectedResources);
  return true;
}

const scriptPath = fileURLToPath(import.meta.url);
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = resolve(dirname(scriptPath), "..");
  validateRepository(root);
  console.log("Pi resource validation passed.");
}
