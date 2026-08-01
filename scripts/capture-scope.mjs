import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describePathKind, sha256Text } from "./lib/fs-safety.mjs";

const UNMERGED_XY = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

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

/**
 * Parse `git status --porcelain=v1 -z` into structured entries.
 * Handles renames, copies, deletions, unmerged XY codes, and paths with spaces via NUL separators.
 */
export function parsePorcelainZ(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
  const parts = text.split("\0").filter((part) => part.length > 0);
  const entries = [];

  for (let i = 0; i < parts.length; i += 1) {
    const record = parts[i];
    if (record.length < 3) continue;
    const xy = record.slice(0, 2);
    const pathPart = record.slice(3);
    const entry = {
      x: xy[0],
      y: xy[1],
      path: pathPart,
      oldPath: null,
      status: null,
    };

    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
      // git status -z emits destination first, then source for renames/copies.
      entry.path = pathPart;
      entry.oldPath = parts[++i] ?? null;
    }

    entry.status = classifyStatus(entry.x, entry.y);
    entries.push(entry);
  }

  return entries;
}

export function classifyStatus(x, y) {
  const xy = `${x}${y}`;
  if (xy === "??") return "untracked";
  if (xy === "!!") return "ignored";
  if (UNMERGED_XY.has(xy) || x === "U" || y === "U") return `unmerged:${xy}`;
  if (x === "R" || y === "R") return "renamed";
  if (x === "C" || y === "C") return "copied";
  if (x === "D" || y === "D") return "deleted";
  if (x === "A" || y === "A") return "added";
  if (x === "M" || y === "M") return "modified";
  if (x === "T" || y === "T") return "typechange";
  return xy.trim() || "unknown";
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    const left = `${a.oldPath ?? ""}\0${a.path}`;
    const right = `${b.oldPath ?? ""}\0${b.path}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function filterEntries(entries, { stagedOnly = false, includeUntracked = true } = {}) {
  return entries.filter((entry) => {
    if (entry.status === "untracked") return includeUntracked && !stagedOnly;
    if (entry.status === "ignored") return false;
    if (stagedOnly) return entry.x !== " " && entry.x !== "?";
    return true;
  });
}

function hashIndexBlob(root, path) {
  try {
    const stdout = git(root, ["show", `:0:${path}`]);
    return sha256Text(stdout);
  } catch {
    return null;
  }
}

function hashStagedDiff(root, path) {
  try {
    return sha256Text(git(root, ["diff", "--cached", "--", path]));
  } catch {
    return null;
  }
}

function hashUnstagedDiff(root, path) {
  try {
    return sha256Text(git(root, ["diff", "--", path]));
  } catch {
    return null;
  }
}

function describeWorktree(root, path) {
  const abs = join(root, path);
  const info = describePathKind(abs);
  return {
    kind: info.kind,
    target: info.target,
    sha256: info.sha256,
  };
}

function fingerprintEntry(root, entry, mode) {
  const parts = [
    entry.status,
    entry.oldPath ?? "",
    entry.path,
    entry.x ?? "",
    entry.y ?? "",
  ];

  if (mode === "ref" || mode === "range") {
    // Range fingerprints include the name-status identity; patch content is hashed separately.
    return parts.join("\t");
  }

  const stagedTouched = entry.x && entry.x !== " " && entry.x !== "?";
  const unstagedTouched = entry.y && entry.y !== " " && entry.y !== "?";
  const untracked = entry.status === "untracked";

  if (stagedTouched) {
    if (entry.x === "D") {
      parts.push("index:deleted");
    } else {
      const blob = hashIndexBlob(root, entry.path);
      const diff = hashStagedDiff(root, entry.path);
      parts.push(`index:${blob ?? "missing"}`);
      parts.push(`indexDiff:${diff ?? "missing"}`);
    }
  } else {
    parts.push("index:-");
    parts.push("indexDiff:-");
  }

  if (untracked || unstagedTouched || entry.status?.startsWith("unmerged:")) {
    if (entry.y === "D" || (entry.status === "deleted" && !existsSync(join(root, entry.path)))) {
      parts.push("wt:deleted");
    } else {
      const wt = describeWorktree(root, entry.path);
      parts.push(`wt:${wt.kind}`);
      parts.push(`wtTarget:${wt.target ?? ""}`);
      parts.push(`wtHash:${wt.sha256 ?? ""}`);
      if (!untracked && entry.y !== " " && entry.y !== "?") {
        parts.push(`wtDiff:${hashUnstagedDiff(root, entry.path) ?? "missing"}`);
      }
    }
  } else {
    parts.push("wt:-");
  }

  return parts.join("\t");
}

export function captureScope({
  cwd = process.cwd(),
  mode = "uncommitted",
  ref,
  paths = [],
} = {}) {
  const root = detectGitRoot(cwd);
  if (!root) throw new Error(`not a git repository: ${cwd}`);

  let entries = [];
  let baseRef = null;
  let rangePatchHash = null;

  if (mode === "uncommitted" || mode === "staged") {
    const stdout = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    entries = filterEntries(parsePorcelainZ(stdout), {
      stagedOnly: mode === "staged",
      includeUntracked: mode === "uncommitted",
    });
  } else if (mode === "ref" || mode === "range") {
    if (!ref) throw new Error("ref/range mode requires ref");
    baseRef = assertSafeGitRevision(ref);
    // Validate each concrete side when present; full ranges are validated via diff.
    const sides = baseRef.includes("...")
      ? baseRef.split("...")
      : baseRef.includes("..")
        ? baseRef.split("..")
        : [baseRef];
    for (const side of sides) {
      if (!side) continue;
      validateGitRevision(root, side);
    }

    const stdout = git(root, [
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      "--find-copies",
      "--end-of-options",
      baseRef,
    ]);
    entries = parseNameStatusZ(stdout);
    rangePatchHash = sha256Text(
      git(root, ["diff", "--binary", "--find-renames", "--find-copies", "--end-of-options", baseRef]),
    );
  } else {
    throw new Error(`unsupported scope mode: ${mode}`);
  }

  if (paths.length > 0) {
    const wanted = new Set(paths.map((p) => p.replace(/^\.\//, "")));
    entries = entries.filter(
      (entry) => wanted.has(entry.path) || (entry.oldPath && wanted.has(entry.oldPath)),
    );
  }

  entries = sortEntries(entries);

  const files = entries.map((entry) => ({
    path: entry.path,
    oldPath: entry.oldPath,
    status: entry.status,
    indexStatus: entry.x ?? null,
    worktreeStatus: entry.y ?? null,
    contentFingerprint: fingerprintEntry(root, entry, mode),
  }));

  const canonical = files.map((file) => file.contentFingerprint).join("\n");
  const fingerprint = sha256Text(
    `${mode}\n${baseRef ?? ""}\n${rangePatchHash ?? ""}\n${canonical}\n`,
  );

  return {
    cwd: resolve(cwd),
    root,
    mode,
    ref: baseRef,
    files,
    fingerprint,
    capturedAt: new Date().toISOString(),
  };
}

export function parseNameStatusZ(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
  const parts = text.split("\0").filter((part) => part.length > 0);
  const entries = [];

  for (let i = 0; i < parts.length; i += 1) {
    const statusToken = parts[i];
    const code = statusToken[0];
    if (code === "R" || code === "C") {
      const oldPath = parts[++i];
      const path = parts[++i];
      entries.push({
        x: code,
        y: " ",
        path,
        oldPath,
        status: code === "R" ? "renamed" : "copied",
      });
      continue;
    }
    const path = parts[++i];
    const status =
      code === "D"
        ? "deleted"
        : code === "A"
          ? "added"
          : code === "M"
            ? "modified"
            : code === "T"
              ? "typechange"
              : code === "U"
                ? "unmerged:U"
                : code;
    entries.push({
      x: code,
      y: " ",
      path,
      oldPath: null,
      status,
    });
  }

  return entries;
}

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    mode: "uncommitted",
    ref: null,
    paths: [],
    json: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--staged") options.mode = "staged";
    else if (arg === "--ref") {
      options.mode = "ref";
      const value = argv[++i];
      if (value == null) throw new Error("--ref requires a revision or range");
      options.ref = assertSafeGitRevision(value);
    } else if (arg === "--cwd") options.cwd = argv[++i];
    else if (arg === "--path") options.paths.push(argv[++i]);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const scriptPath = fileURLToPath(import.meta.url);
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(`Usage: node scripts/capture-scope.mjs [--staged] [--ref REF] [--path FILE]

Capture a deterministic change-scope manifest for simplify/review workflows.
`);
      process.exit(0);
    }
    const scope = captureScope(options);
    console.log(JSON.stringify(scope, null, 2));
  } catch (error) {
    console.error(error.message ?? error);
    process.exit(1);
  }
}
