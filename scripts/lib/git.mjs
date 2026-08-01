import { spawnSync } from "node:child_process";

export const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * Run git in cwd. Throws GIT_ERROR on non-zero exit; GIT_MAXBUFFER when output exceeds maxBuffer.
 */
export function git(cwd, args, { maxBuffer = GIT_MAX_BUFFER_BYTES } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer,
  });
  if (result.error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    const error = new Error("git output exceeded buffer limit");
    error.code = "GIT_MAXBUFFER";
    throw error;
  }
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

/**
 * Reject option-like / unsafe revision tokens before they reach git argv.
 * Supports single revisions and A..B / A...B ranges.
 */
export function assertSafeGitRevision(ref) {
  if (typeof ref !== "string" || !ref.trim()) {
    throw new Error("ref is required");
  }
  const value = ref.trim();
  if (value.startsWith("-")) {
    throw new Error(`ref looks like a git option and was rejected: ${value}`);
  }
  if (/[\0\r\n]/.test(value)) {
    throw new Error("ref contains invalid control characters");
  }

  const sides = value.includes("...")
    ? value.split("...")
    : value.includes("..")
      ? value.split("..")
      : [value];

  if (sides.length > 2) {
    throw new Error(`invalid revision range: ${value}`);
  }
  for (const side of sides) {
    if (!side) continue; // allow "..HEAD" / "HEAD.." forms where one side is empty
    if (side.startsWith("-")) {
      throw new Error(`ref looks like a git option and was rejected: ${side}`);
    }
    if (/[\0\r\n\s]/.test(side)) {
      throw new Error(`invalid revision token: ${side}`);
    }
  }
  return value;
}

export function validateGitRevision(cwd, ref) {
  const safe = assertSafeGitRevision(ref);
  // Validate through rev-parse with an explicit end-of-options boundary.
  git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${safe}^{commit}`]);
  return safe;
}

/** True when ref is a single revision token (not A..B or A...B). */
export function isSingleRevision(ref) {
  const safe = assertSafeGitRevision(ref);
  return !safe.includes("..") && !safe.includes("...");
}

/**
 * Map a user ref to the git diff spec.
 * Single revisions become REV^! (that commit only); ranges stay ranges.
 */
export function refDiffSpec(ref) {
  const safe = assertSafeGitRevision(ref);
  if (isSingleRevision(safe)) {
    return { userRef: safe, diffSpec: `${safe}^!`, singleCommit: true };
  }
  return { userRef: safe, diffSpec: safe, singleCommit: false };
}
