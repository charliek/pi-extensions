import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";

const DEFAULT_STALE_LOCK_MS = 30_000;

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // intentional short spin for exclusive-lock retries
  }
}

export function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function sha256File(path) {
  return sha256Buffer(readFileSync(path));
}

export function sha256Text(text) {
  return sha256Buffer(Buffer.from(text, "utf8"));
}

/** Resolve and require `candidate` to stay inside `root`. */
export function resolveInside(root, candidate) {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, candidate);
  const rel = relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || rel.includes(`..${sep}`) || resolve(resolvedRoot, rel) !== resolved) {
    throw new Error(`path escapes root: ${candidate}`);
  }
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
    throw new Error(`path escapes root: ${candidate}`);
  }
  return resolved;
}

export function assertNotSymlink(path, label = path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label}: refusing to use symlink`);
  }
}

/**
 * Refuse symlink leaves. When `root` is provided, also refuse any symlink
 * ancestor at or below that root (but never walk above it — system paths like
 * macOS `/var -> /private/var` are out of scope).
 */
export function assertSafePath(path, { root = null, label = path } = {}) {
  const resolved = resolve(path);
  const resolvedRoot = root == null ? null : resolve(root);
  if (resolvedRoot != null) {
    const rel = relative(resolvedRoot, resolved);
    if (rel.startsWith("..") || (rel !== "" && resolve(resolvedRoot, rel) !== resolved)) {
      throw new Error(`${label}: path escapes safety root`);
    }
  }

  let current = resolved;
  while (true) {
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`${label}: refusing to use symlink at ${current}`);
      }
    }
    if (resolvedRoot == null || current === resolvedRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function assertSafeAgentFilename(name) {
  if (!/^[a-z0-9][a-z0-9-]*\.md$/.test(name)) {
    throw new Error(`unexpected agent filename: ${name}`);
  }
  if (!name.startsWith("px-")) {
    throw new Error(`managed agent filename must start with px-: ${name}`);
  }
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeTempFile(dir, contents, mode) {
  const temp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
  chmodSync(temp, mode);
  return temp;
}

/** Write file atomically via temp+rename in the destination directory. */
export function atomicWriteFile(path, contents, { mode = 0o644, root = null } = {}) {
  const dir = dirname(path);
  ensureDir(dir);
  if (root != null) assertSafePath(dir, { root, label: dir });
  else assertNotSymlink(dir);
  if (existsSync(path)) assertNotSymlink(path);

  const temp = writeTempFile(dir, contents, mode);
  try {
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // ignore cleanup failures
    }
    throw error;
  }
}

/**
 * Create a new file atomically; fails if the destination already exists (no-clobber).
 */
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
    // Prefer link+unlink for no-clobber when rename would replace.
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
      try {
        writeSync(fd, contents);
      } finally {
        closeSync(fd);
      }
      unlinkSync(temp);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Error(`refusing to clobber existing path: ${path}`);
      }
      // Fall back to rename only when exclusive create is unavailable and dest still absent.
      if (!existsSync(path)) {
        renameSync(temp, path);
      } else {
        throw new Error(`refusing to clobber existing path: ${path}`);
      }
    }
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // ignore cleanup failures
    }
    throw error;
  }
}

export function describePathKind(path) {
  if (!existsSync(path)) return { kind: "missing", target: null, sha256: null };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    return { kind: "symlink", target: readlinkSync(path), sha256: null };
  }
  if (stat.isDirectory()) {
    return { kind: "directory", target: null, sha256: null };
  }
  if (stat.isFile()) {
    return { kind: "file", target: null, sha256: sha256File(path) };
  }
  return { kind: "other", target: null, sha256: null, mode: stat.mode };
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function parseLockContents(text) {
  const lines = String(text).split(/\r?\n/);
  const pid = Number.parseInt(lines[0] ?? "", 10);
  const timestamp = Date.parse(lines[1] ?? "");
  return {
    pid: Number.isInteger(pid) ? pid : null,
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
  };
}

export function isLockStale(
  lockPath,
  { staleMs = DEFAULT_STALE_LOCK_MS, now = Date.now() } = {},
) {
  if (!existsSync(lockPath)) return false;
  let mtimeMs = null;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    return true;
  }

  let parsed;
  try {
    parsed = parseLockContents(readFileSync(lockPath, "utf8"));
  } catch {
    // Incomplete lock files (create-before-write races) are not stale while young.
    return mtimeMs != null ? now - mtimeMs > staleMs : true;
  }
  // A live owner retains the lock regardless of age.
  if (parsed.pid != null && processExists(parsed.pid)) return false;
  if (parsed.timestamp != null) {
    return now - parsed.timestamp > staleMs;
  }
  // Unreadable/missing metadata: use mtime so we do not steal a brand-new lock.
  return mtimeMs != null ? now - mtimeMs > staleMs : true;
}

function tryRecoverStaleLock(lockPath, options) {
  if (!isLockStale(lockPath, options)) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/** Acquire an exclusive lock file; returns a release function via finally. */
export function withExclusiveLock(
  lockPath,
  fn,
  { retries = 100, delayMs = 25, staleMs = DEFAULT_STALE_LOCK_MS } = {},
) {
  ensureDir(dirname(lockPath));
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      // wx creates+writes without leaving an empty lock file for stale recovery to steal.
      writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`, {
        flag: "wx",
        mode: 0o644,
      });
      try {
        return fn();
      } finally {
        try {
          unlinkSync(lockPath);
        } catch {
          // ignore
        }
      }
    } catch (error) {
      lastError = error;
      if (error?.code !== "EEXIST") throw error;
      if (tryRecoverStaleLock(lockPath, { staleMs })) continue;
      sleepSync(delayMs);
    }
  }
  throw new Error(`could not acquire lock ${lockPath}: ${lastError?.message ?? "busy"}`);
}

export function readJsonIfExists(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  assertNotSymlink(path);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJsonAtomic(path, value, { root = null } = {}) {
  atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, { root });
}

export function removePath(path) {
  if (!existsSync(path)) return;
  assertNotSymlink(path);
  rmSync(path, { recursive: true, force: true });
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

/** Capture a directory tree snapshot for non-mutation tests (relative paths -> sha256 or kind). */
export function snapshotFilesystem(root) {
  const base = resolve(root);
  if (!existsSync(base)) return { root: base, entries: {} };

  const entries = {};
  const walk = (dir, prefix = "") => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const described = describePathKind(full);
      if (described.kind === "directory") {
        entries[rel] = { kind: "directory" };
        walk(full, rel);
      } else {
        entries[rel] = described;
      }
    }
  };
  walk(base);
  return { root: base, entries };
}
