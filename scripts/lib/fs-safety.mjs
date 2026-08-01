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
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const DEFAULT_LOCK_RETRIES = 100;
const DEFAULT_LOCK_DELAY_MS = 25;

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
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

/** Return true when `buffer` is valid UTF-8 (fatal decode). */
export function isValidUtf8(buffer) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
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
  // Use canonical paths so macOS /var vs /private/var does not false-fail containment.
  const resolved = canonicalPath(path);
  const resolvedRoot = root == null ? null : canonicalPath(root);
  if (resolvedRoot != null) {
    const rel = relative(resolvedRoot, resolved);
    if (rel.startsWith("..") || (rel !== "" && resolve(resolvedRoot, rel) !== resolved)) {
      throw new Error(`${label}: path escapes safety root`);
    }
  }

  // Symlink checks walk the logical resolved path (pre-realpath) so link leaves are still refused.
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
    writeFileSync(fd, contents);
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
 * Fully writes a same-directory temp file, then hard-links it into place and unlinks
 * the temp. Never writes the destination directly and never falls back to rename
 * (rename can replace on some platforms).
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

  // The destination now points at the fully written inode. Temp cleanup failure
  // does not make creation fail or leave a partial destination.
  try {
    unlinkSync(temp);
  } catch {
    // orphaned temp is harmless and can be cleaned later
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

/**
 * Legacy locks are pre-token file locks or proper-lockfile mkdir directories.
 * These are never reclaimed automatically — remove them manually before retrying.
 */
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
    // Fail closed: leave the lock for manual cleanup rather than unlink a foreign holder.
  }
}

/**
 * Acquire an exclusive lock via atomic O_EXCL file creation.
 *
 * Never reclaims stale, legacy, or foreign locks — a crash or killed holder may
 * leave the lock path behind and requires explicit manual removal before retrying.
 * Release only unlinks the lock when the path still references the owned inode and token.
 */
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

/** Resolve existing path prefixes through realpath (handles macOS /var -> /private/var). */
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

/** True when `candidate` resolves inside `root` (or equals root). */
export function isPathInside(root, candidate) {
  const resolvedRoot = canonicalPath(root);
  const resolved = canonicalPath(candidate);
  if (resolved === resolvedRoot) return true;
  const rel = relative(resolvedRoot, resolved);
  return rel !== "" && !rel.startsWith(`..${sep}`) && !rel.startsWith("..") && resolve(resolvedRoot, rel) === resolved;
}

/**
 * Validate a no-clobber destination for plan overrides / custom paths.
 * Parent must exist as a non-symlink directory; destination must not exist.
 */
export function assertSafeCreateDestination(path, { root = null, label = path } = {}) {
  const resolved = canonicalPath(path);
  const parent = dirname(resolved);
  if (!existsSync(parent)) {
    throw new Error(`${label}: parent directory does not exist: ${parent}`);
  }
  if (root != null) {
    assertSafePath(parent, { root, label: `${label} parent` });
  } else {
    assertNotSymlink(parent, `${label} parent`);
  }
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory()) {
    throw new Error(`${label}: parent is not a directory: ${parent}`);
  }
  if (existsSync(resolved)) {
    throw new Error(`${label}: refusing to clobber existing path: ${resolved}`);
  }
  return resolved;
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
