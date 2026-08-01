import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { buildScopeBundle, DEFAULT_MAX_FILE_BYTES, expandPathFilters } from "../scripts/build-scope-bundle.mjs";
import { captureScope, refDiffSpec } from "../scripts/capture-scope.mjs";
import { parseScopeArgs } from "../scripts/lib/scope-args.mjs";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function initRepo() {
  const root = mkdtempSync(join(tmpdir(), "px-bundle-"));
  git(root, ["init"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  writeFileSync(join(root, "tracked.txt"), "one\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-m", "init"]);
  return root;
}

test("parseScopeArgs rejects positional path/focus inference", () => {
  assert.throws(() => parseScopeArgs(["src/foo.ts"]), /positional argument rejected/);
  assert.throws(() => parseScopeArgs(["focus text"]), /positional argument rejected/);
  const parsed = parseScopeArgs(["--path", "src/foo.ts", "--focus", "edge cases"]);
  assert.deepEqual(parsed.paths, ["src/foo.ts"]);
  assert.equal(parsed.focus, "edge cases");
});

test("parseScopeArgs rejects --staged with --ref and duplicate mode flags", () => {
  assert.throws(() => parseScopeArgs(["--staged", "--ref", "HEAD"]), /cannot be combined/);
  assert.throws(() => parseScopeArgs(["--ref", "HEAD", "--staged"]), /cannot be combined/);
  assert.throws(() => parseScopeArgs(["--staged", "--staged"]), /duplicate --staged/);
  assert.throws(() => parseScopeArgs(["--ref", "HEAD", "--ref", "HEAD~1"]), /duplicate --ref/);
});

test("expandPathFilters includes rename and copy source paths", () => {
  const scope = {
    files: [
      { path: "new.txt", oldPath: "old.txt", status: "renamed" },
      { path: "copy.txt", oldPath: "src.txt", status: "copied" },
      { path: "plain.txt", oldPath: null, status: "modified" },
    ],
  };
  assert.deepEqual(new Set(expandPathFilters(scope, ["old.txt"])), new Set(["old.txt", "new.txt"]));
  assert.deepEqual(new Set(expandPathFilters(scope, ["copy.txt"])), new Set(["copy.txt", "src.txt"]));
  assert.deepEqual(expandPathFilters(scope, ["plain.txt"]), ["plain.txt"]);
});

test("refDiffSpec uses REV^! for single revisions and preserves ranges", () => {
  assert.deepEqual(refDiffSpec("abc123"), {
    userRef: "abc123",
    diffSpec: "abc123^!",
    singleCommit: true,
  });
  assert.deepEqual(refDiffSpec("HEAD~2..HEAD"), {
    userRef: "HEAD~2..HEAD",
    diffSpec: "HEAD~2..HEAD",
    singleCommit: false,
  });
  assert.deepEqual(refDiffSpec("main...feature"), {
    userRef: "main...feature",
    diffSpec: "main...feature",
    singleCommit: false,
  });
});

test("buildScopeBundle includes staged, unstaged, untracked, rename, deletion, and spaces", () => {
  const root = initRepo();

  writeFileSync(join(root, "tracked.txt"), "changed\n");
  writeFileSync(join(root, "file with spaces.txt"), "spaces\n");
  writeFileSync(join(root, "to-rename.txt"), "rename-me\n");
  writeFileSync(join(root, "to-delete.txt"), "delete-me\n");
  git(root, ["add", "to-rename.txt", "to-delete.txt"]);
  git(root, ["commit", "-m", "add files"]);

  git(root, ["mv", "to-rename.txt", "renamed file.txt"]);
  git(root, ["rm", "to-delete.txt"]);
  writeFileSync(join(root, "tracked.txt"), "unstaged-change\n");
  writeFileSync(join(root, "staged-new.txt"), "staged\n");
  git(root, ["add", "staged-new.txt"]);
  writeFileSync(join(root, "file with spaces.txt"), "untracked spaces\n");
  writeFileSync(join(root, "new untracked.txt"), "brand new\n");

  const bundleDir = mkdtempSync(join(tmpdir(), "px-bundle-out-"));
  const result = buildScopeBundle({ cwd: root, outputDir: bundleDir });
  const body = readFileSync(result.bundlePath, "utf8");

  assert.equal(result.scope.fingerprint, captureScope({ cwd: root }).fingerprint);
  assert.match(body, /tracked\.txt/);
  assert.match(body, /staged-new\.txt/);
  assert.match(body, /renamed file\.txt/);
  assert.match(body, /to-delete\.txt/);
  assert.match(body, /## Untracked text files/);
  assert.match(body, /new untracked\.txt/);
  assert.match(body, /file with spaces\.txt/);
  assert.equal(statSync(result.bundlePath).mode & 0o777, 0o600);

  const again = buildScopeBundle({ cwd: root, outputDir: bundleDir });
  assert.equal(again.bundleSha256, result.bundleSha256);
});

test("buildScopeBundle omits binary and oversized untracked files explicitly", () => {
  const root = initRepo();
  writeFileSync(join(root, "notes.txt"), "hello\n");
  writeFileSync(join(root, "blob.bin"), Buffer.from([0, 1, 2, 3]));
  const big = Buffer.alloc(DEFAULT_MAX_FILE_BYTES + 1, 97);
  writeFileSync(join(root, "huge.txt"), big);

  const result = buildScopeBundle({ cwd: root, maxFileBytes: DEFAULT_MAX_FILE_BYTES });
  const body = readFileSync(result.bundlePath, "utf8");

  assert.match(body, /notes\.txt/);
  assert.match(body, /blob\.bin: binary/);
  assert.match(body, /huge\.txt: oversized/);
  assert.ok(result.omitted.some((item) => item.path === "blob.bin" && item.reason === "binary"));
  assert.ok(result.omitted.some((item) => item.path === "huge.txt" && item.reason === "oversized"));
});

test("buildScopeBundle single --ref diffs that commit only", () => {
  const root = initRepo();
  writeFileSync(join(root, "old.txt"), "a\n");
  git(root, ["add", "old.txt"]);
  git(root, ["commit", "-m", "add old"]);
  const first = git(root, ["rev-parse", "HEAD"]).trim();

  git(root, ["mv", "old.txt", "new name.txt"]);
  writeFileSync(join(root, "extra.txt"), "b\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "move and add"]);

  const single = buildScopeBundle({ cwd: root, mode: "ref", ref: first });
  const singleBody = readFileSync(single.bundlePath, "utf8");
  assert.match(singleBody, /old\.txt/);
  assert.doesNotMatch(singleBody, /new name\.txt/);
  assert.doesNotMatch(singleBody, /extra\.txt/);

  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const headBundle = buildScopeBundle({ cwd: root, mode: "ref", ref: head });
  const headBody = readFileSync(headBundle.bundlePath, "utf8");
  assert.match(headBody, /new name\.txt/);
  assert.match(headBody, /extra\.txt/);

  const range = buildScopeBundle({ cwd: root, mode: "ref", ref: `${first}..HEAD` });
  const rangeBody = readFileSync(range.bundlePath, "utf8");
  assert.match(rangeBody, /old\.txt/);
  assert.match(rangeBody, /new name\.txt/);
});

test("buildScopeBundle staged mode limits diff to index", () => {
  const root = initRepo();
  writeFileSync(join(root, "tracked.txt"), "staged-only\n");
  git(root, ["add", "tracked.txt"]);
  writeFileSync(join(root, "tracked.txt"), "also unstaged\n");

  const result = buildScopeBundle({ cwd: root, mode: "staged" });
  const body = readFileSync(result.bundlePath, "utf8");
  assert.match(body, /staged-only/);
  assert.doesNotMatch(body, /also unstaged/);
});

test("buildScopeBundle respects --path filters", () => {
  const root = initRepo();
  writeFileSync(join(root, "keep.txt"), "keep\n");
  writeFileSync(join(root, "skip.txt"), "skip\n");
  git(root, ["add", "keep.txt", "skip.txt"]);
  git(root, ["commit", "-m", "two files"]);
  writeFileSync(join(root, "keep.txt"), "keep changed\n");
  writeFileSync(join(root, "skip.txt"), "skip changed\n");

  const result = buildScopeBundle({ cwd: root, paths: ["keep.txt"] });
  const body = readFileSync(result.bundlePath, "utf8");
  assert.match(body, /keep changed/);
  assert.doesNotMatch(body, /skip changed/);
});

test("buildScopeBundle filtered rename includes both old and new paths", () => {
  const root = initRepo();
  writeFileSync(join(root, "before.txt"), "rename-me\n");
  git(root, ["add", "before.txt"]);
  git(root, ["commit", "-m", "add before"]);
  git(root, ["mv", "before.txt", "after.txt"]);
  writeFileSync(join(root, "other.txt"), "leave alone\n");

  const byOld = buildScopeBundle({ cwd: root, paths: ["before.txt"] });
  const oldBody = readFileSync(byOld.bundlePath, "utf8");
  assert.match(oldBody, /before\.txt/);
  assert.match(oldBody, /after\.txt/);
  assert.doesNotMatch(oldBody, /leave alone/);

  const byNew = buildScopeBundle({ cwd: root, paths: ["after.txt"] });
  const newBody = readFileSync(byNew.bundlePath, "utf8");
  assert.match(newBody, /before\.txt/);
  assert.match(newBody, /after\.txt/);
});

test("buildScopeBundle truncates oversized unified diff within total limit", () => {
  const root = initRepo();
  const bigLine = `${"x".repeat(200)}\n`;
  writeFileSync(join(root, "big.txt"), bigLine.repeat(4000));
  git(root, ["add", "big.txt"]);
  git(root, ["commit", "-m", "add big"]);

  writeFileSync(join(root, "big.txt"), `${"y".repeat(200)}\n`.repeat(4000));

  const maxTotalBytes = 50_000;
  const result = buildScopeBundle({ cwd: root, maxTotalBytes });
  const body = readFileSync(result.bundlePath, "utf8");

  assert.equal(result.truncated, true);
  assert.equal(result.complete, false);
  assert.ok(result.omitted.some((item) => item.path === "(unified diff)" && item.reason === "truncated"));
  assert.match(body, /\(unified diff\): truncated/);
  assert.match(body, /truncated to total byte limit/);
  assert.match(body, /complete: false/);
  assert.ok(result.diffBytes > maxTotalBytes);
});

test("buildScopeBundle sets complete:false for invalid UTF-8 without NUL bytes", () => {
  const root = initRepo();
  const invalid = Buffer.from([0xc3, 0x28, 0x61, 0x0a]);
  writeFileSync(join(root, "bad-utf8.txt"), invalid);
  writeFileSync(join(root, "tracked.txt"), "changed\n");

  const result = buildScopeBundle({ cwd: root });
  assert.equal(result.complete, false);
  assert.ok(result.omitted.some((item) => item.path === "bad-utf8.txt" && item.reason === "invalid-utf8"));
  const body = readFileSync(result.bundlePath, "utf8");
  assert.match(body, /bad-utf8\.txt: invalid-utf8/);
  assert.match(body, /complete: false/);
});

test("buildScopeBundle sets complete:false for binary/oversized omissions including tracked binaries", () => {
  const root = initRepo();
  writeFileSync(join(root, "notes.txt"), "hello\n");
  writeFileSync(join(root, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 9]));
  git(root, ["add", "blob.bin"]);
  git(root, ["commit", "-m", "add binary"]);
  writeFileSync(join(root, "blob.bin"), Buffer.from([9, 0, 8, 0]));
  writeFileSync(join(root, "untracked.bin"), Buffer.from([0, 7]));

  const result = buildScopeBundle({ cwd: root });
  assert.equal(result.complete, false);
  assert.ok(result.omitted.some((item) => item.path === "blob.bin" && item.reason === "binary"));
  assert.ok(result.omitted.some((item) => item.path === "untracked.bin" && item.reason === "binary"));
  const body = readFileSync(result.bundlePath, "utf8");
  assert.match(body, /complete: false/);
});

test("buildScopeBundle rejects unmatched path filters and uses literal pathspecs for renames", () => {
  const root = initRepo();
  writeFileSync(join(root, "before.txt"), "rename-me\n");
  git(root, ["add", "before.txt"]);
  git(root, ["commit", "-m", "add before"]);
  git(root, ["mv", "before.txt", "after.txt"]);

  assert.throws(() => buildScopeBundle({ cwd: root, paths: ["nope.txt"] }), /unmatched/);
  const byOld = buildScopeBundle({ cwd: root, paths: ["before.txt"] });
  assert.equal(byOld.complete, true);
  assert.ok(byOld.scope.files.some((file) => file.oldPath === "before.txt"));
});

test("parseScopeArgs rejects path magic at CLI boundary", () => {
  assert.throws(() => parseScopeArgs(["--path", "src/*.ts"]), /glob/);
  assert.throws(() => parseScopeArgs(["--path", "/abs/path"]), /repository-relative/);
  assert.throws(() => parseScopeArgs(["--path", ":(exclude)foo"]), /pathspec magic/);
});
