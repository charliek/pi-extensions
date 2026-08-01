import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertSafeGitRevision,
  captureScope,
  classifyStatus,
  parsePorcelainZ,
} from "../scripts/capture-scope.mjs";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function initRepo() {
  const root = mkdtempSync(join(tmpdir(), "px-scope-"));
  git(root, ["init"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  writeFileSync(join(root, "tracked.txt"), "one\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-m", "init"]);
  return root;
}

test("parsePorcelainZ handles renames, copies, and paths with spaces", () => {
  const z = ["R  new name.txt", "old name.txt", "C  copy name.txt", "source.txt", "?? untracked file.md", " D gone.txt"]
    .join("\0")
    .concat("\0");
  const entries = parsePorcelainZ(z);
  assert.equal(entries.length, 4);
  const renamed = entries.find((entry) => entry.status === "renamed");
  assert.equal(renamed.path, "new name.txt");
  assert.equal(renamed.oldPath, "old name.txt");
  const copied = entries.find((entry) => entry.status === "copied");
  assert.equal(copied.path, "copy name.txt");
  assert.equal(copied.oldPath, "source.txt");
  assert.equal(entries.find((entry) => entry.status === "untracked").path, "untracked file.md");
  assert.equal(entries.find((entry) => entry.status === "deleted").path, "gone.txt");
});

test("classifyStatus distinguishes copies, renames, and all unmerged XY codes", () => {
  assert.equal(classifyStatus("R", " "), "renamed");
  assert.equal(classifyStatus("C", " "), "copied");
  assert.equal(classifyStatus("?", "?"), "untracked");
  for (const xy of ["DD", "AU", "UD", "UA", "DU", "AA", "UU"]) {
    assert.equal(classifyStatus(xy[0], xy[1]), `unmerged:${xy}`);
  }
});

test("assertSafeGitRevision rejects option-like refs", () => {
  assert.throws(() => assertSafeGitRevision("--output=/tmp/x"), /git option/);
  assert.throws(() => assertSafeGitRevision("-Gregex"), /git option/);
  assert.throws(() => assertSafeGitRevision("HEAD\n--output"), /control characters/);
  assert.equal(assertSafeGitRevision("HEAD~1"), "HEAD~1");
  assert.equal(assertSafeGitRevision("abc123..def456"), "abc123..def456");
});

test("captureScope fingerprints uncommitted content, types, and symlink targets", () => {
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
  try {
    symlinkSync("tracked.txt", join(root, "link-to-tracked"));
  } catch (error) {
    if (error.code !== "EPERM") throw error;
  }

  const scope = captureScope({ cwd: root, mode: "uncommitted" });
  const byPath = Object.fromEntries(scope.files.map((file) => [file.path, file]));

  assert.ok(byPath["tracked.txt"]);
  assert.ok(byPath["staged-new.txt"]);
  assert.ok(byPath["file with spaces.txt"]);
  assert.ok(byPath["renamed file.txt"]);
  assert.equal(byPath["renamed file.txt"].status, "renamed");
  assert.equal(byPath["renamed file.txt"].oldPath, "to-rename.txt");
  assert.ok(scope.files.some((file) => file.path === "to-delete.txt" && file.status === "deleted"));
  assert.match(scope.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(byPath["tracked.txt"].contentFingerprint.includes("wtDiff:"));
  assert.ok(byPath["staged-new.txt"].contentFingerprint.includes("index:"));
  assert.ok(byPath["file with spaces.txt"].contentFingerprint.includes("wt:file"));

  if (byPath["link-to-tracked"]) {
    assert.match(byPath["link-to-tracked"].contentFingerprint, /wt:symlink/);
    assert.match(byPath["link-to-tracked"].contentFingerprint, /wtTarget:tracked\.txt/);
  }

  const again = captureScope({ cwd: root, mode: "uncommitted" });
  assert.equal(again.fingerprint, scope.fingerprint);

  writeFileSync(join(root, "file with spaces.txt"), "untracked spaces changed\n");
  const drifted = captureScope({ cwd: root, mode: "uncommitted" });
  assert.notEqual(drifted.fingerprint, scope.fingerprint);

  const staged = captureScope({ cwd: root, mode: "staged" });
  assert.ok(staged.files.some((file) => file.path === "staged-new.txt"));
  assert.ok(!staged.files.some((file) => file.path === "file with spaces.txt"));
});

test("normalizeLiteralRepoPath rejects magic, globs, absolute, and escapes", async () => {
  const { normalizeLiteralRepoPath } = await import("../scripts/lib/path-filters.mjs");
  assert.equal(normalizeLiteralRepoPath("./src/foo.ts"), "src/foo.ts");
  assert.throws(() => normalizeLiteralRepoPath("/tmp/x"), /repository-relative/);
  assert.throws(() => normalizeLiteralRepoPath("../escape"), /escapes/);
  assert.throws(() => normalizeLiteralRepoPath("src/*.ts"), /glob/);
  assert.throws(() => normalizeLiteralRepoPath(":(literal)foo"), /pathspec magic/);
  assert.throws(() => normalizeLiteralRepoPath("foo?"), /glob/);
});

test("captureScope path filters match exact/rename paths and reject unmatched", () => {
  const root = initRepo();
  writeFileSync(join(root, "keep.txt"), "a\n");
  writeFileSync(join(root, "skip.txt"), "b\n");
  writeFileSync(join(root, "before.txt"), "rename\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "add"]);
  writeFileSync(join(root, "keep.txt"), "changed\n");
  writeFileSync(join(root, "skip.txt"), "changed\n");
  git(root, ["mv", "before.txt", "after.txt"]);

  const filtered = captureScope({ cwd: root, paths: ["keep.txt"] });
  assert.deepEqual(
    filtered.files.map((file) => file.path),
    ["keep.txt"],
  );

  const byOld = captureScope({ cwd: root, paths: ["before.txt"] });
  assert.ok(byOld.files.some((file) => file.status === "renamed" && file.oldPath === "before.txt"));

  assert.throws(
    () => captureScope({ cwd: root, paths: ["missing.txt"] }),
    /unmatched/,
  );
});

test("captureScope fingerprint changes across branch names at the same commit", () => {
  const root = initRepo();
  writeFileSync(join(root, "tracked.txt"), "changed\n");
  git(root, ["branch", "alt"]);
  const onMain = captureScope({ cwd: root });
  git(root, ["checkout", "alt"]);
  const onAlt = captureScope({ cwd: root });
  assert.equal(onAlt.head, onMain.head);
  assert.notEqual(onAlt.branch, onMain.branch);
  assert.notEqual(onAlt.fingerprint, onMain.fingerprint);
});

test("captureScope fingerprint changes across branch and repo identity", () => {
  const root = initRepo();
  writeFileSync(join(root, "tracked.txt"), "changed\n");
  const onMain = captureScope({ cwd: root });
  git(root, ["checkout", "-b", "feature"]);
  writeFileSync(join(root, "extra.txt"), "x\n");
  git(root, ["add", "extra.txt"]);
  git(root, ["commit", "-m", "feature commit"]);
  // Same uncommitted edit to tracked.txt, but HEAD and index listing differ.
  writeFileSync(join(root, "tracked.txt"), "changed\n");
  const onFeature = captureScope({ cwd: root });
  assert.notEqual(onFeature.fingerprint, onMain.fingerprint);
  assert.notEqual(onFeature.head, onMain.head);
  assert.ok(onFeature.repoIdentity.includes(root));

  const other = initRepo();
  writeFileSync(join(other, "tracked.txt"), "changed\n");
  const otherScope = captureScope({ cwd: other });
  assert.notEqual(otherScope.fingerprint, onMain.fingerprint);
});

test("captureScope ref mode rejects option injection; single ref uses REV^!", () => {
  const root = initRepo();
  writeFileSync(join(root, "old.txt"), "a\n");
  git(root, ["add", "old.txt"]);
  git(root, ["commit", "-m", "old"]);
  const first = git(root, ["rev-parse", "HEAD"]).trim();

  git(root, ["mv", "old.txt", "new name.txt"]);
  writeFileSync(join(root, "extra.txt"), "b\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "move and add"]);
  const head = git(root, ["rev-parse", "HEAD"]).trim();

  assert.throws(
    () => captureScope({ cwd: root, mode: "ref", ref: "--output=/tmp/pwned" }),
    /git option/,
  );

  const single = captureScope({ cwd: root, mode: "ref", ref: first });
  assert.ok(single.files.some((file) => file.path === "old.txt" && file.status === "added"));
  assert.ok(!single.files.some((file) => file.path === "new name.txt"));

  const headScope = captureScope({ cwd: root, mode: "ref", ref: head });
  assert.ok(headScope.files.some((file) => file.status === "renamed" && file.path === "new name.txt"));
  assert.ok(headScope.files.some((file) => file.path === "extra.txt" && file.status === "added"));

  const rangeScope = captureScope({ cwd: root, mode: "ref", ref: `${first}..HEAD` });
  assert.ok(rangeScope.files.some((file) => file.path === "new name.txt"));
  assert.ok(rangeScope.files.length >= headScope.files.length);
});
