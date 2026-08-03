#!/usr/bin/env node
/**
 * Allocate ~/.claude/plans/<repo>/NNN-<slug>.md and a sibling artifact directory.
 * Honors PI_PLANS_DIR. Uses an exclusive lock while choosing the next number.
 *
 * Prints two lines: planPath, then artifactsDir.
 */
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const PLAN_NAME = /^(\d{3})-(.+)\.md$/;
const DEFAULT_LOCK_RETRIES = 100;
const DEFAULT_LOCK_DELAY_MS = 25;
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

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

export function expandHome(path) {
  if (path === "~") return process.env.HOME ?? process.env.USERPROFILE ?? path;
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (!home) return path;
    return join(home, path.slice(2));
  }
  return path;
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function assertNotSymlink(path, label = path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label}: refusing to use symlink`);
  }
}

export function canonicalPath(path) {
  const resolved = resolve(path);
  if (existsSync(resolved)) {
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  }
  const missing = [];
  let current = resolved;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  try {
    current = realpathSync(current);
  } catch {
    // keep logical prefix
  }
  return missing.length > 0 ? join(current, ...missing) : current;
}

export function assertSafePath(path, { root = null, label = path } = {}) {
  const resolved = canonicalPath(path);
  const resolvedRoot = root == null ? null : canonicalPath(root);
  if (resolvedRoot != null) {
    const rel = relative(resolvedRoot, resolved);
    if (rel.startsWith("..") || (rel !== "" && resolve(resolvedRoot, rel) !== resolved)) {
      throw new Error(`${label}: path escapes safety root`);
    }
  }

  let current = resolve(path);
  const stopAt = root == null ? null : resolve(root);
  while (true) {
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`${label}: refusing to use symlink at ${current}`);
      }
    }
    if (stopAt == null || current === stopAt || canonicalPath(current) === resolvedRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function writeTempFile(dir, contents, mode) {
  const temp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    writeFileSync(fd, contents);
  } finally {
    closeSync(fd);
  }
  chmodSync(temp, mode);
  return temp;
}

export function atomicCreateFile(path, contents, { mode = 0o644, root = null } = {}) {
  const dir = dirname(path);
  ensureDir(dir);
  if (root != null) assertSafePath(dir, { root, label: dir });
  else assertNotSymlink(dir);
  if (existsSync(path)) {
    throw new Error(`refusing to clobber existing path: ${path}`);
  }

  const temp = writeTempFile(dir, contents, mode);
  try {
    linkSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // ignore cleanup failures
    }
    if (error?.code === "EEXIST") {
      throw new Error(`refusing to clobber existing path: ${path}`);
    }
    throw error;
  }

  try {
    unlinkSync(temp);
  } catch {
    // orphaned temp is harmless
  }
}

function formatLockContents(token) {
  return `${process.pid}\n${new Date().toISOString()}\n${token}\n`;
}

function parseOwnedLockContents(text, token) {
  const lines = String(text).split(/\r?\n/);
  const pid = Number.parseInt(lines[0] ?? "", 10);
  const lockToken = lines[2] ?? "";
  return {
    pid: Number.isInteger(pid) ? pid : null,
    token: lockToken,
    owned: lockToken === token,
  };
}

export function isLegacyLockPath(lockPath) {
  if (!existsSync(lockPath)) return false;
  try {
    const stat = lstatSync(lockPath);
    if (stat.isDirectory()) return true;
    if (!stat.isFile()) return true;
    const lines = readFileSync(lockPath, "utf8").split(/\r?\n/);
    return lines.length < 3 || !lines[2];
  } catch {
    return true;
  }
}

function describeLegacyLock(lockPath) {
  if (!existsSync(lockPath)) return null;
  try {
    const stat = lstatSync(lockPath);
    if (stat.isDirectory()) {
      return "legacy directory lock (remove manually before retrying)";
    }
    return "legacy lock file (remove manually before retrying)";
  } catch {
    return "unreadable lock path (remove manually before retrying)";
  }
}

function releaseOwnedLock(lockPath, { inode, token }) {
  if (!existsSync(lockPath)) return;
  try {
    const stat = statSync(lockPath);
    if (stat.ino !== inode) return;
    const contents = readFileSync(lockPath, "utf8");
    const parsed = parseOwnedLockContents(contents, token);
    if (!parsed.owned) return;
    unlinkSync(lockPath);
  } catch {
    // leave the lock for manual cleanup
  }
}

export function withExclusiveLock(
  lockPath,
  fn,
  { retries = DEFAULT_LOCK_RETRIES, delayMs = DEFAULT_LOCK_DELAY_MS } = {},
) {
  ensureDir(dirname(lockPath));

  const token = randomBytes(16).toString("hex");
  const payload = formatLockContents(token);
  let fd;
  let inode;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (isLegacyLockPath(lockPath)) {
      const reason = describeLegacyLock(lockPath) ?? "legacy lock present";
      throw new Error(`could not acquire lock ${lockPath}: ${reason}`);
    }

    try {
      fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      inode = fstatSync(fd).ino;
      writeFileSync(fd, payload);
      closeSync(fd);
      fd = null;
      break;
    } catch (error) {
      if (fd != null) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
        fd = null;
      }
      if (error?.code === "EEXIST") {
        if (isLegacyLockPath(lockPath)) {
          const reason = describeLegacyLock(lockPath) ?? "legacy lock present";
          throw new Error(`could not acquire lock ${lockPath}: ${reason}`);
        }
        if (attempt + 1 >= retries) {
          throw new Error(
            `could not acquire lock ${lockPath}: lock held (remove manually if orphaned)`,
          );
        }
        sleepSync(delayMs);
        continue;
      }
      throw error;
    }
  }

  if (inode == null) {
    throw new Error(`could not acquire lock ${lockPath}: busy`);
  }

  try {
    return fn();
  } finally {
    releaseOwnedLock(lockPath, { inode, token });
  }
}

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "git command failed").trim();
    const error = new Error(message);
    error.code = "GIT_ERROR";
    throw error;
  }
  return result.stdout;
}

export function detectGitRoot(cwd = process.cwd()) {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return null;
  }
}

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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(`Usage: node scripts/allocate-plan.mjs [--slug SLUG] [--repository NAME] [brief...]

Allocates ~/.claude/plans/<repo>/NNN-<slug>.md and a sibling artifact directory.
Honors PI_PLANS_DIR (or --plans-dir). Uses an exclusive lock while choosing the next number.

Prints two lines: planPath, then artifactsDir.
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
