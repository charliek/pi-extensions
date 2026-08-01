import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureScope, detectGitRoot, refDiffSpec } from "./capture-scope.mjs";
import { sha256Text } from "./lib/fs-safety.mjs";
import { parseScopeArgs } from "./lib/scope-args.mjs";

export const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER_BYTES,
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

function pathFilterArgs(paths) {
  if (paths.length === 0) return [];
  return ["--", ...paths];
}

/**
 * Expand --path filters so renames/copies include both destination and source paths.
 */
export function expandPathFilters(scope, paths) {
  if (paths.length === 0) return [];
  const wanted = new Set(paths.map((p) => p.replace(/^\.\//, "")));
  const expanded = new Set(paths.map((p) => p.replace(/^\.\//, "")));
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
    return git(root, ["diff", "--cached", "--find-renames", "--find-copies", ...filters]);
  }
  if (scope.mode === "uncommitted") {
    try {
      git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
      return git(root, ["diff", "HEAD", "--find-renames", "--find-copies", ...filters]);
    } catch {
      const staged = git(root, ["diff", "--cached", "--find-renames", "--find-copies", ...filters]);
      const unstaged = git(root, ["diff", "--find-renames", "--find-copies", ...filters]);
      return [staged, unstaged].filter(Boolean).join("\n");
    }
  }
  if (scope.mode === "ref") {
    const { diffSpec } = refDiffSpec(scope.ref);
    return git(root, [
      "diff",
      "--find-renames",
      "--find-copies",
      "--end-of-options",
      diffSpec,
      ...filters,
    ]);
  }
  throw new Error(`unsupported scope mode for bundle diff: ${scope.mode}`);
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
  return { kind: "text", content: buffer.toString("utf8"), bytes: buffer.length };
}

/**
 * Build a deterministic, owner-only scope bundle outside the repository.
 * Wraps captureScope with bounded unified diff plus untracked text contents.
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

  const diffPaths = expandPathFilters(scope, paths);
  const omitted = [];
  let diffText = "";
  let diffBytes = 0;
  let diffTruncated = false;

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

    omitted.push({
      path: file.path,
      reason: slice.kind,
      bytes: slice.bytes || undefined,
    });
  }

  const lines = [
    "# pi-extensions scope bundle",
    `fingerprint: ${scope.fingerprint}`,
    `mode: ${scope.mode}`,
    `ref: ${scope.ref ?? ""}`,
    `focus: ${focus ?? ""}`,
    `repository: ${root}`,
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
  };
}

const scriptPath = fileURLToPath(import.meta.url);
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const options = parseScopeArgs(process.argv.slice(2));
    if (options.help) {
      console.log(`Usage: node scripts/build-scope-bundle.mjs [--staged] [--ref REV] [--path FILE]... [--focus TEXT]

Build an owner-only scope bundle (manifest + unified diff + untracked text) outside the repo.
Binary and oversized files are listed under Omissions. Positional args are rejected.
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
