import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureScope } from "./capture-scope.mjs";
import { detectGitRoot, git, refDiffSpec } from "./lib/git.mjs";
import { isValidUtf8, sha256Text } from "./lib/fs-safety.mjs";
import { literalPathspecs } from "./lib/path-filters.mjs";
import { parseScopeArgs } from "./lib/scope-args.mjs";

export const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

function pathFilterArgs(paths) {
  if (paths.length === 0) return [];
  return ["--", ...literalPathspecs(paths)];
}

/**
 * Expand --path filters so renames/copies include both destination and source paths.
 */
export function expandPathFilters(scope, paths) {
  if (paths.length === 0) return [];
  const wanted = new Set(paths);
  const expanded = new Set(paths);
  for (const file of scope.files) {
    if (!file.oldPath) continue;
    if (wanted.has(file.path) || wanted.has(file.oldPath)) {
      expanded.add(file.path);
      expanded.add(file.oldPath);
    }
  }
  return [...expanded];
}

function truncateUtf8(text, maxBytes) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return { text, truncated: false, originalBytes: buffer.length };
  }
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return {
    text: buffer.subarray(0, end).toString("utf8"),
    truncated: true,
    originalBytes: buffer.length,
  };
}

function collectUnifiedDiff(root, scope, paths) {
  const filters = pathFilterArgs(paths);
  if (scope.mode === "staged") {
    return git(root, ["diff", "--cached", "--binary", "--find-renames", "--find-copies", ...filters]);
  }
  if (scope.mode === "uncommitted") {
    try {
      git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
      return git(root, ["diff", "HEAD", "--binary", "--find-renames", "--find-copies", ...filters]);
    } catch {
      const staged = git(root, [
        "diff",
        "--cached",
        "--binary",
        "--find-renames",
        "--find-copies",
        ...filters,
      ]);
      const unstaged = git(root, ["diff", "--binary", "--find-renames", "--find-copies", ...filters]);
      return [staged, unstaged].filter(Boolean).join("\n");
    }
  }
  if (scope.mode === "ref") {
    const { diffSpec } = refDiffSpec(scope.ref);
    return git(root, [
      "diff",
      "--binary",
      "--find-renames",
      "--find-copies",
      "--end-of-options",
      diffSpec,
      ...filters,
    ]);
  }
  throw new Error(`unsupported scope mode for bundle diff: ${scope.mode}`);
}

/**
 * Inventory tracked binary changes via numstat (`-	-	path` lines).
 */
export function inventoryTrackedBinaryChanges(root, scope, paths) {
  const filters = pathFilterArgs(paths);
  const argsByMode = [];
  if (scope.mode === "staged") {
    argsByMode.push(["diff", "--cached", "--numstat", "--find-renames", "--find-copies", ...filters]);
  } else if (scope.mode === "uncommitted") {
    try {
      git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
      argsByMode.push(["diff", "HEAD", "--numstat", "--find-renames", "--find-copies", ...filters]);
    } catch {
      argsByMode.push(["diff", "--cached", "--numstat", "--find-renames", "--find-copies", ...filters]);
      argsByMode.push(["diff", "--numstat", "--find-renames", "--find-copies", ...filters]);
    }
  } else if (scope.mode === "ref") {
    const { diffSpec } = refDiffSpec(scope.ref);
    argsByMode.push([
      "diff",
      "--numstat",
      "--find-renames",
      "--find-copies",
      "--end-of-options",
      diffSpec,
      ...filters,
    ]);
  }

  const found = new Map();
  for (const args of argsByMode) {
    let stdout = "";
    try {
      stdout = git(root, args);
    } catch (error) {
      if (error.code === "GIT_MAXBUFFER") {
        found.set("(numstat)", { path: "(numstat)", reason: "git-maxbuffer", detail: error.message });
        continue;
      }
      throw error;
    }
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const [added, removed, ...pathParts] = parts;
      if (added !== "-" || removed !== "-") continue;
      // renames appear as "old => new" in numstat path column sometimes
      const pathCol = pathParts.join("\t");
      const path = pathCol.includes(" => ") ? pathCol.split(" => ").pop() : pathCol;
      found.set(path, { path, reason: "binary", detail: "tracked binary change (numstat)" });
    }
  }
  return [...found.values()];
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

function readTextSlice(absPath, maxBytes) {
  const stat = lstatSync(absPath);
  if (stat.isSymbolicLink()) {
    return { kind: "symlink", content: null, bytes: 0 };
  }
  if (stat.isDirectory()) {
    return { kind: "directory", content: null, bytes: 0 };
  }
  if (!stat.isFile()) {
    return { kind: "other", content: null, bytes: 0 };
  }
  if (stat.size > maxBytes) {
    return { kind: "oversized", content: null, bytes: stat.size };
  }
  const buffer = readFileSync(absPath);
  if (looksBinary(buffer)) {
    return { kind: "binary", content: null, bytes: buffer.length };
  }
  if (!isValidUtf8(buffer)) {
    return { kind: "invalid-utf8", content: null, bytes: buffer.length };
  }
  return { kind: "text", content: buffer.toString("utf8"), bytes: buffer.length };
}

/**
 * Build a deterministic, owner-only scope bundle outside the repository.
 * Wraps captureScope with bounded unified diff plus untracked text contents.
 * `complete` is false for any truncation/maxbuffer/binary/oversized/unreadable omission.
 */
export function buildScopeBundle({
  cwd = process.cwd(),
  mode = "uncommitted",
  ref = null,
  paths = [],
  focus = null,
  outputDir = null,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
} = {}) {
  const scope = captureScope({ cwd, mode, ref, paths });
  const root = scope.root;
  const gitRoot = detectGitRoot(cwd);
  if (!gitRoot) throw new Error(`not a git repository: ${cwd}`);

  const diffPaths = expandPathFilters(scope, scope.paths);
  const omitted = [];
  let diffText = "";
  let diffBytes = 0;
  let diffTruncated = false;

  try {
    for (const item of inventoryTrackedBinaryChanges(root, scope, diffPaths)) {
      omitted.push(item);
    }
  } catch (error) {
    if (error.code === "GIT_MAXBUFFER") {
      omitted.push({
        path: "(numstat)",
        reason: "git-maxbuffer",
        detail: error.message,
      });
    } else {
      throw error;
    }
  }

  try {
    diffText = collectUnifiedDiff(root, scope, diffPaths);
    diffBytes = Buffer.byteLength(diffText, "utf8");
  } catch (error) {
    if (error.code === "GIT_MAXBUFFER") {
      omitted.push({
        path: "(unified diff)",
        reason: "git-maxbuffer",
        detail: error.message,
      });
    } else {
      throw error;
    }
  }

  let contentBytes = 0;
  if (diffText) {
    const bounded = truncateUtf8(diffText, maxTotalBytes);
    if (bounded.truncated) {
      diffTruncated = true;
      omitted.push({
        path: "(unified diff)",
        reason: "truncated",
        bytes: bounded.originalBytes,
      });
    }
    diffText = bounded.text;
    contentBytes = Buffer.byteLength(diffText, "utf8");
  }

  const includedUntracked = [];
  const binaryOmitted = new Set(
    omitted.filter((item) => item.reason === "binary").map((item) => item.path),
  );
  const validatedTracked = new Set();

  for (const file of scope.files) {
    if (file.status === "untracked" || file.status === "deleted" || file.status === "ignored") {
      continue;
    }
    if (validatedTracked.has(file.path)) continue;
    validatedTracked.add(file.path);

    const abs = join(root, file.path);
    if (!existsSync(abs)) continue;

    let slice;
    try {
      slice = readTextSlice(abs, maxFileBytes);
    } catch (error) {
      omitted.push({ path: file.path, reason: "unreadable", detail: error.message });
      continue;
    }

    if (slice.kind === "invalid-utf8") {
      omitted.push({
        path: file.path,
        reason: "invalid-utf8",
        bytes: slice.bytes,
        detail: "NUL-free content is not valid UTF-8",
      });
    }
  }

  for (const file of scope.files) {
    if (file.status !== "untracked") continue;
    const abs = join(root, file.path);
    let slice;
    try {
      slice = readTextSlice(abs, maxFileBytes);
    } catch (error) {
      omitted.push({ path: file.path, reason: "unreadable", detail: error.message });
      continue;
    }

    if (slice.kind === "text") {
      if (contentBytes + slice.bytes > maxTotalBytes) {
        omitted.push({ path: file.path, reason: "total-limit", bytes: slice.bytes });
        continue;
      }
      includedUntracked.push({ path: file.path, content: slice.content, bytes: slice.bytes });
      contentBytes += slice.bytes;
      continue;
    }

    if (slice.kind === "invalid-utf8") {
      omitted.push({
        path: file.path,
        reason: "invalid-utf8",
        bytes: slice.bytes,
        detail: "NUL-free content is not valid UTF-8",
      });
      continue;
    }

    if (slice.kind === "binary" && binaryOmitted.has(file.path)) {
      continue;
    }

    omitted.push({
      path: file.path,
      reason: slice.kind,
      bytes: slice.bytes || undefined,
    });
  }

  const incompleteReasons = new Set([
    "truncated",
    "total-limit",
    "git-maxbuffer",
    "binary",
    "invalid-utf8",
    "oversized",
    "unreadable",
    "symlink",
    "directory",
    "other",
  ]);
  const complete = omitted.every((item) => !incompleteReasons.has(item.reason));

  const lines = [
    "# pi-extensions scope bundle",
    `fingerprint: ${scope.fingerprint}`,
    `mode: ${scope.mode}`,
    `ref: ${scope.ref ?? ""}`,
    `focus: ${focus ?? ""}`,
    `repository: ${root}`,
    `complete: ${complete ? "true" : "false"}`,
    "",
    "## Unified diff",
    diffText.trim() === "" ? "(empty diff)" : diffText.trimEnd(),
    diffTruncated ? "(truncated to total byte limit)" : null,
    "",
  ].filter((line) => line != null);

  if (includedUntracked.length > 0) {
    lines.push("## Untracked text files");
    for (const entry of includedUntracked) {
      lines.push(`### ${entry.path}`, "```", entry.content.trimEnd(), "```", "");
    }
  }

  lines.push("## Omissions");
  if (omitted.length === 0) {
    lines.push("(none)");
  } else {
    for (const item of omitted) {
      const extra = item.bytes != null ? ` (${item.bytes} bytes)` : "";
      const detail = item.detail ? ` — ${item.detail}` : "";
      lines.push(`- ${item.path}: ${item.reason}${extra}${detail}`);
    }
  }

  const bundleBody = `${lines.join("\n")}\n`;
  const bundleSha256 = sha256Text(bundleBody);

  const bundleDir = outputDir ?? mkdtempSync(join(tmpdir(), "px-scope-bundle-"));
  mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
  const bundlePath = join(bundleDir, `scope-${scope.fingerprint.slice(0, 12)}.txt`);
  writeFileSync(bundlePath, bundleBody, { mode: 0o600 });
  chmodSync(bundlePath, 0o600);

  return {
    scope,
    focus,
    bundlePath: resolve(bundlePath),
    bundleSha256,
    diffBytes,
    includedUntracked,
    omitted,
    truncated:
      diffTruncated || omitted.some((item) => item.reason === "total-limit" || item.reason === "truncated"),
    complete,
  };
}

const scriptPath = fileURLToPath(import.meta.url);
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const options = parseScopeArgs(process.argv.slice(2));
    if (options.help) {
      console.log(`Usage: node scripts/build-scope-bundle.mjs [--staged] [--ref REV] [--path FILE]... [--focus TEXT]

Build an owner-only scope bundle (manifest + unified diff + untracked text) outside the repo.
Binary and oversized files are listed under Omissions; complete:false when anything is omitted.
--path values must be literal repository-relative paths. Positional args are rejected.
`);
      process.exit(0);
    }
    const result = buildScopeBundle(options);
    console.log(
      JSON.stringify(
        {
          fingerprint: result.scope.fingerprint,
          bundlePath: result.bundlePath,
          bundleSha256: result.bundleSha256,
          mode: result.scope.mode,
          ref: result.scope.ref,
          focus: result.focus,
          fileCount: result.scope.files.length,
          omittedCount: result.omitted.length,
          truncated: result.truncated,
          complete: result.complete,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message ?? error);
    process.exit(1);
  }
}
