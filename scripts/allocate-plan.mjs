import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertSafeCreateDestination,
  atomicCreateFile,
  canonicalPath,
  ensureDir,
  expandHome,
  isPathInside,
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

/**
 * Classify a plan-location override from target instructions.
 * Auto-allowed only when contained in the target repo or configured PI_PLANS_DIR.
 * Any other destination requires explicit user confirmation (`confirmed: true`).
 */
export function classifyPlanLocationOverride({
  overridePath,
  cwd = process.cwd(),
  plansDir = defaultPlansDir(),
  confirmed = false,
} = {}) {
  if (typeof overridePath !== "string" || !overridePath.trim()) {
    throw new Error("plan location override path is required");
  }
  const resolved = canonicalPath(expandHome(overridePath.trim()));
  const repoRoot = detectGitRoot(cwd);
  const rootPlansDir = canonicalPath(expandHome(plansDir));
  const allowedRoots = [rootPlansDir];
  if (repoRoot) allowedRoots.push(canonicalPath(repoRoot));

  const autoAllowed = allowedRoots.some((root) => isPathInside(root, resolved));
  if (!autoAllowed && !confirmed) {
    const error = new Error(
      `plan location override requires explicit user confirmation (outside target repo and PI_PLANS_DIR): ${resolved}`,
    );
    error.code = "PLAN_LOCATION_CONFIRM_REQUIRED";
    error.resolvedPath = resolved;
    error.allowedRoots = allowedRoots;
    throw error;
  }

  const safetyRoot = autoAllowed
    ? allowedRoots.find((root) => isPathInside(root, resolved))
    : null;
  assertSafeCreateDestination(resolved, {
    root: safetyRoot,
    label: "plan location override",
  });

  return {
    planPath: resolved,
    artifactsDir: join(dirname(resolved), basename(resolved, ".md")),
    autoAllowed,
    confirmed: Boolean(confirmed),
    plansDir: rootPlansDir,
    repoRoot,
  };
}

/**
 * Create a plan file at an explicit override path (no-clobber, symlink-safe parent).
 */
export function allocatePlanAtOverride({
  overridePath,
  cwd = process.cwd(),
  plansDir = defaultPlansDir(),
  confirmed = false,
  slug,
  brief,
  body,
} = {}) {
  const classified = classifyPlanLocationOverride({
    overridePath,
    cwd,
    plansDir,
    confirmed,
  });
  const planSlug = sanitizeSlug(slug ?? brief ?? basename(classified.planPath, ".md"));
  const lockTarget = join(dirname(classified.planPath), ".allocate-override.lock");

  return withExclusiveLock(lockTarget, () => {
    // Re-validate under the lock so a concurrent creator cannot be clobbered.
    assertSafeCreateDestination(classified.planPath, {
      label: "plan location override",
    });
    if (existsSync(classified.artifactsDir)) {
      throw new Error(`plan artifacts path already exists: ${classified.artifactsDir}`);
    }

    const contents =
      body ??
      `# ${basename(classified.planPath, ".md")}

## Status

Draft — allocated by allocate-plan override.

## Motivation

${brief ? String(brief).trim() : "(fill in)"}
`;
    const normalized = contents.endsWith("\n") ? contents : `${contents}\n`;
    atomicCreateFile(classified.planPath, normalized);
    ensureDir(classified.artifactsDir);

    return {
      ...classified,
      slug: planSlug,
      id: basename(classified.planPath, ".md"),
      overridden: true,
    };
  });
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
      overridden: false,
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
    overridePath: null,
    confirmed: false,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--slug") options.slug = argv[++i];
    else if (arg === "--repository") options.repository = argv[++i];
    else if (arg === "--plans-dir") options.plansDir = argv[++i];
    else if (arg === "--cwd") options.cwd = argv[++i];
    else if (arg === "--override-path") options.overridePath = argv[++i];
    else if (arg === "--confirm-override") options.confirmed = true;
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
       node scripts/allocate-plan.mjs --override-path PATH [--confirm-override] [--slug SLUG]

Allocates ~/.claude/plans/<repo>/NNN-<slug>.md and a sibling artifact directory.
Honors PI_PLANS_DIR. Uses an exclusive lock while choosing the next number.

Override paths inside the target repo or PI_PLANS_DIR are auto-allowed.
Any other override path requires --confirm-override and must be a non-existing
destination with a non-symlink regular parent (no-clobber).
`);
      process.exit(0);
    }
    if (options.overridePath) {
      const result = allocatePlanAtOverride(options);
      console.log(result.planPath);
      console.log(result.artifactsDir);
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
