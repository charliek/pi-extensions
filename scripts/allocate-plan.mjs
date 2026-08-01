import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  atomicCreateFile,
  ensureDir,
  expandHome,
  withExclusiveLock,
} from "./lib/fs-safety.mjs";
import { detectGitRoot } from "./lib/git.mjs";

const PLAN_NAME = /^(\d{3})-(.+)\.md$/;
const WINDOWS_RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

export function defaultPlansDir() {
  const override = process.env.PI_PLANS_DIR;
  if (override) return resolve(expandHome(override));
  return resolve(expandHome("~/.claude/plans"));
}

export function sanitizeSlug(input) {
  const cleaned = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  if (!cleaned) throw new Error("slug must contain at least one alphanumeric character");
  return cleaned.slice(0, 80);
}

/**
 * Cross-platform repository directory name sanitization.
 * Rejects path separators, reserved Windows device names, and unsafe characters.
 */
export function sanitizeRepositoryName(input) {
  const name = String(input ?? "").trim();
  if (!name) throw new Error(`invalid repository name: ${input}`);
  if (name === "." || name === "..") throw new Error(`invalid repository name: ${input}`);
  if (name.includes("\0")) throw new Error(`invalid repository name: ${input}`);
  if (name.includes("/") || name.includes("\\") || name.includes(sep)) {
    throw new Error(`invalid repository name: ${input}`);
  }
  if (/[<>:"|?*\u0000-\u001f]/.test(name)) {
    throw new Error(`invalid repository name: ${input}`);
  }
  if (/[. ]$/.test(name)) {
    throw new Error(`invalid repository name: ${input}`);
  }
  const base = name.includes(".") ? name.slice(0, name.indexOf(".")) : name;
  if (WINDOWS_RESERVED.has(base.toLowerCase())) {
    throw new Error(`invalid repository name (reserved): ${input}`);
  }
  return name;
}

export { detectGitRoot } from "./lib/git.mjs";

export function detectRepositoryName(cwd = process.cwd(), explicitName) {
  if (explicitName) return sanitizeRepositoryName(explicitName);
  const root = detectGitRoot(cwd);
  if (!root) {
    throw new Error(
      "not inside a git repository; pass --repository <name> to allocate a plan outside a repo",
    );
  }
  return sanitizeRepositoryName(basename(root));
}

export function listPlanNumbers(repoDir) {
  if (!existsSync(repoDir)) return [];
  return readdirSync(repoDir)
    .map((name) => {
      const match = name.match(PLAN_NAME);
      return match ? Number(match[1]) : null;
    })
    .filter((n) => Number.isInteger(n));
}

export function nextPlanNumber(repoDir) {
  const numbers = listPlanNumbers(repoDir);
  const next = numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
  if (next > 999) throw new Error(`plan number space exhausted in ${repoDir}`);
  return next;
}

export function formatPlanNumber(n) {
  return String(n).padStart(3, "0");
}

export function allocatePlan({
  cwd = process.cwd(),
  slug,
  brief,
  plansDir = defaultPlansDir(),
  repository,
  body,
} = {}) {
  const repoName = detectRepositoryName(cwd, repository);
  const planSlug = sanitizeSlug(slug ?? brief ?? "plan");
  const rootPlansDir = resolve(expandHome(plansDir));
  const repoDir = join(rootPlansDir, repoName);
  const lockPath = join(repoDir, ".allocate.lock");

  return withExclusiveLock(lockPath, () => {
    ensureDir(repoDir);
    const number = nextPlanNumber(repoDir);
    const id = `${formatPlanNumber(number)}-${planSlug}`;
    const planPath = join(repoDir, `${id}.md`);
    const artifactsDir = join(repoDir, id);

    if (existsSync(planPath) || existsSync(artifactsDir)) {
      throw new Error(`plan path already exists: ${planPath}`);
    }

    const contents =
      body ??
      `# ${id}

## Status

Draft — allocated by allocate-plan.

## Motivation

${brief ? String(brief).trim() : "(fill in)"}
`;

    const normalized = contents.endsWith("\n") ? contents : `${contents}\n`;
    atomicCreateFile(planPath, normalized, { root: rootPlansDir });
    ensureDir(artifactsDir);

    return {
      repository: repoName,
      number,
      id,
      slug: planSlug,
      planPath,
      artifactsDir,
      plansDir: rootPlansDir,
      repoDir,
    };
  });
}

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    plansDir: defaultPlansDir(),
    slug: null,
    brief: null,
    repository: null,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--slug") options.slug = argv[++i];
    else if (arg === "--repository") options.repository = argv[++i];
    else if (arg === "--plans-dir") options.plansDir = argv[++i];
    else if (arg === "--cwd") options.cwd = argv[++i];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("-")) throw new Error(`unknown argument: ${arg}`);
    else positionals.push(arg);
  }
  if (positionals.length > 0) options.brief = positionals.join(" ");
  if (!options.slug && options.brief) options.slug = options.brief;
  return options;
}

const scriptPath = fileURLToPath(import.meta.url);
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(`Usage: node scripts/allocate-plan.mjs [--slug SLUG] [--repository NAME] [brief...]

Allocates ~/.claude/plans/<repo>/NNN-<slug>.md and a sibling artifact directory.
Honors PI_PLANS_DIR. Uses an exclusive lock while choosing the next number.
`);
      process.exit(0);
    }
    if (!options.slug && !options.brief) throw new Error("slug or brief is required");
    const result = allocatePlan(options);
    console.log(result.planPath);
    console.log(result.artifactsDir);
  } catch (error) {
    console.error(error.message ?? error);
    process.exit(1);
  }
}
