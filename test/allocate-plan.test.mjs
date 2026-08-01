import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import test from "node:test";

import {
  allocatePlan,
  formatPlanNumber,
  sanitizeRepositoryName,
  sanitizeSlug,
} from "../scripts/allocate-plan.mjs";

function initRepo() {
  const root = mkdtempSync(join(tmpdir(), "px-repo-"));
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git(["init"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(root, "README.md"), "test\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "init"]);
  return root;
}

function runAllocateProcess({ repo, plansDir, slug }) {
  const script = resolve(import.meta.dirname, "../scripts/allocate-plan.mjs");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [script, "--cwd", repo, "--plans-dir", plansDir, "--slug", slug],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr || `allocate-plan exited ${code}`));
      else resolvePromise(stdout);
    });
  });
}

test("sanitizeSlug collapses unsafe characters", () => {
  assert.equal(sanitizeSlug(" Hello World!! "), "hello-world");
  assert.equal(sanitizeSlug("a__b"), "a-b");
  assert.throws(() => sanitizeSlug("***"), /alphanumeric/);
});

test("sanitizeRepositoryName is cross-platform safe", () => {
  assert.equal(sanitizeRepositoryName("my-repo"), "my-repo");
  assert.throws(() => sanitizeRepositoryName("../escape"), /invalid repository name/);
  assert.throws(() => sanitizeRepositoryName("foo/bar"), /invalid repository name/);
  assert.throws(() => sanitizeRepositoryName("foo\\bar"), /invalid repository name/);
  assert.throws(() => sanitizeRepositoryName("CON"), /reserved/);
  assert.throws(() => sanitizeRepositoryName("aux.txt"), /reserved/);
  assert.throws(() => sanitizeRepositoryName("bad:name"), /invalid repository name/);
  assert.throws(() => sanitizeRepositoryName("trailing."), /invalid repository name/);
});

test("allocatePlan numbers plans deterministically with portable path assertions", () => {
  const repo = initRepo();
  const plansDir = mkdtempSync(join(tmpdir(), "px-plans-"));
  const first = allocatePlan({ cwd: repo, slug: "portable-workflow", plansDir });
  assert.equal(basename(first.planPath), "001-portable-workflow.md");
  assert.equal(basename(first.artifactsDir), "001-portable-workflow");
  assert.ok(first.planPath.includes(`${sep}${basename(repo)}${sep}`));
  assert.equal(existsSync(first.planPath), true);
  assert.equal(existsSync(first.artifactsDir), true);
  assert.equal(first.number, 1);

  const second = allocatePlan({ cwd: repo, slug: "follow-up", plansDir });
  assert.equal(basename(second.planPath), "002-follow-up.md");
  assert.equal(second.number, 2);
  assert.equal(formatPlanNumber(second.number), "002");
});

test("allocatePlan supports explicit repository outside a git checkout", () => {
  const plansDir = mkdtempSync(join(tmpdir(), "px-plans-"));
  const outside = mkdtempSync(join(tmpdir(), "px-outside-"));
  assert.throws(() => allocatePlan({ cwd: outside, slug: "x", plansDir }), /not inside a git repository/);

  const allocated = allocatePlan({
    cwd: outside,
    slug: "manual",
    plansDir,
    repository: "custom-repo",
  });
  assert.equal(basename(allocated.planPath), "001-manual.md");
  assert.ok(allocated.planPath.endsWith(join("custom-repo", "001-manual.md")));
});

test("allocatePlan serializes concurrent number selection with a lock", async () => {
  const repo = initRepo();
  const plansDir = mkdtempSync(join(tmpdir(), "px-plans-"));
  const outputs = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      runAllocateProcess({ repo, plansDir, slug: `concurrent-${index}` }),
    ),
  );

  const repoName = basename(repo);
  const files = readdirSync(join(plansDir, repoName))
    .filter((name) => name.endsWith(".md"))
    .sort();
  assert.equal(files.length, 5);
  assert.deepEqual(
    files.map((name) => name.slice(0, 3)),
    ["001", "002", "003", "004", "005"],
  );
  assert.equal(outputs.length, 5);
});
