import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describePathKind, sha256Text } from "./lib/fs-safety.mjs";
import {
  detectGitRoot,
  git,
  refDiffSpec,
  validateGitRevision,
} from "./lib/git.mjs";

const UNMERGED_XY = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export {
  assertSafeGitRevision,
  detectGitRoot,
  isSingleRevision,
  refDiffSpec,
  validateGitRevision,
} from "./lib/git.mjs";

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
  } else if (mode === "ref") {
    if (!ref) throw new Error("ref mode requires ref");
    const { userRef, diffSpec } = refDiffSpec(ref);
    baseRef = userRef;
    // Validate each concrete side when present; full ranges are validated via diff.
    const sides = userRef.includes("...")
      ? userRef.split("...")
      : userRef.includes("..")
        ? userRef.split("..")
        : [userRef];
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
      diffSpec,
    ]);
    entries = parseNameStatusZ(stdout);
    rangePatchHash = sha256Text(
      git(root, [
        "diff",
        "--binary",
        "--find-renames",
        "--find-copies",
        "--end-of-options",
        diffSpec,
      ]),
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

import { parseScopeArgs } from "./lib/scope-args.mjs";

const scriptPath = fileURLToPath(import.meta.url);
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const options = parseScopeArgs(process.argv.slice(2));
    if (options.help) {
      console.log(`Usage: node scripts/capture-scope.mjs [--staged] [--ref REV] [--path FILE]... [--focus TEXT]

Capture a deterministic change-scope manifest for simplify/review workflows.
Use explicit --path and --focus; positional arguments are rejected.
Single --ref revisions diff that commit only (REV^!); ranges stay ranges.
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
