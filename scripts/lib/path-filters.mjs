import { isAbsolute, normalize, posix, win32 } from "node:path";

/**
 * Normalize and validate a repository-relative literal file path for --path filters.
 * Rejects Git pathspec magic, globs, absolute paths, and `..` escapes.
 * Returns the normalized relative path (forward slashes, no leading ./).
 */
export function normalizeLiteralRepoPath(input, { label = "--path" } = {}) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error(`${label} requires a non-empty repository-relative file path`);
  }
  let value = input.trim();
  if (value.includes("\0") || /[\r\n]/.test(value)) {
    throw new Error(`${label} contains invalid control characters: ${input}`);
  }
  if (value.startsWith(":")) {
    throw new Error(`${label} rejects Git pathspec magic: ${input}`);
  }
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/")) {
    throw new Error(`${label} must be repository-relative (not absolute): ${input}`);
  }
  if (value.includes("*") || value.includes("?") || value.includes("[") || value.includes("]")) {
    throw new Error(`${label} rejects glob metacharacters: ${input}`);
  }
  // Strip a single leading ./ only (not ../).
  value = value.replace(/^\.\//, "");
  if (!value || value === ".") {
    throw new Error(`${label} must refer to a file path: ${input}`);
  }

  const normalized = normalize(value);
  const posixNorm = normalized.split(win32.sep).join(posix.sep);
  if (
    posixNorm === ".." ||
    posixNorm.startsWith("../") ||
    posixNorm.split("/").includes("..") ||
    posixNorm.includes("\\")
  ) {
    throw new Error(`${label} escapes the repository root: ${input}`);
  }
  if (posixNorm.startsWith("./")) {
    throw new Error(`${label} must be a normalized repository-relative path: ${input}`);
  }
  return posixNorm;
}

/** Build Git pathspec args that force literal matching for each path. */
export function literalPathspecs(paths) {
  return paths.map((path) => `:(literal)${path}`);
}

/**
 * Filter status entries by exact path or oldPath match.
 * Throws when any requested path does not match at least one entry.
 */
export function applyLiteralPathFilters(entries, paths, { label = "--path" } = {}) {
  if (paths.length === 0) return entries;
  const wanted = paths.map((path) => normalizeLiteralRepoPath(path, { label }));
  const matched = new Set();
  const filtered = entries.filter((entry) => {
    let keep = false;
    if (wanted.includes(entry.path)) {
      matched.add(entry.path);
      keep = true;
    }
    if (entry.oldPath && wanted.includes(entry.oldPath)) {
      matched.add(entry.oldPath);
      keep = true;
    }
    return keep;
  });
  const missing = wanted.filter((path) => !matched.has(path));
  if (missing.length > 0) {
    throw new Error(
      `${label} unmatched in current scope (exact path or rename old path required): ${missing.join(", ")}`,
    );
  }
  return filtered;
}
