import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { isLockStale, sha256Text, withExclusiveLock } from "../scripts/lib/fs-safety.mjs";
import {
  agentsDirFor,
  manifestPathFor,
  migrateManagedManifest,
  syncAgents,
  validateManagedManifest,
} from "../scripts/sync-agents.mjs";

function makePackage(agents) {
  const root = mkdtempSync(join(tmpdir(), "px-pkg-"));
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "pi-extensions", version: "0.1.0" }),
  );
  for (const [name, body] of Object.entries(agents)) {
    writeFileSync(join(root, "agents", name), body);
  }
  return root;
}

function agentDoc(description = "test agent") {
  return `---
description: ${description}
tools: read, grep, find, ls
disallowed_tools: bash, edit, write
prompt_mode: append
---

Body.
`;
}

function existsGone(path) {
  try {
    readFileSync(path);
    return false;
  } catch {
    return true;
  }
}

test("sync migrates legacy schema-v1 manifest missing packageRoot", () => {
  const packageRoot = makePackage({
    "px-code-reviewer.md": agentDoc("code review"),
  });
  const agentHome = mkdtempSync(join(tmpdir(), "px-home-"));
  const manifestPath = manifestPathFor(agentHome);
  mkdirSync(agentHome, { recursive: true });
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        packageName: "pi-extensions",
        packageVersion: "0.1.0",
        updatedAt: new Date().toISOString(),
        files: {
          "px-code-reviewer.md": {
            sha256: sha256Text(agentDoc("code review")),
            source: "agents/px-code-reviewer.md",
          },
        },
      },
      null,
      2,
    ),
  );

  const result = syncAgents({ packageRoot, agentHome });
  assert.equal(result.ok, true);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.packageRoot, resolve(packageRoot));
  assert.doesNotThrow(() => validateManagedManifest(manifest, manifestPath));
});

test("migrateManagedManifest adds packageRoot for legacy schema-v1 manifests", () => {
  const packageRoot = makePackage({});
  const { manifest, migrated } = migrateManagedManifest(
    {
      schemaVersion: 1,
      packageName: "pi-extensions",
      packageVersion: "0.1.0",
      files: {},
    },
    { packageRoot },
  );
  assert.equal(migrated, true);
  assert.equal(manifest.packageRoot, resolve(packageRoot));
});

test("sync installs managed agents idempotently with manifest outside agents/", () => {
  const packageRoot = makePackage({
    "px-code-reviewer.md": agentDoc("code review"),
  });
  const agentHome = mkdtempSync(join(tmpdir(), "px-home-"));

  const first = syncAgents({ packageRoot, agentHome });
  assert.equal(first.ok, true);
  assert.equal(first.actions.filter((a) => a.op === "create").length, 1);
  assert.equal(first.rewritten, true);

  const dest = join(agentsDirFor(agentHome), "px-code-reviewer.md");
  const manifestPath = manifestPathFor(agentHome);
  assert.equal(readFileSync(dest, "utf8"), agentDoc("code review"));
  assert.ok(!manifestPath.startsWith(agentsDirFor(agentHome)));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.packageVersion, "0.1.0");
  assert.equal(manifest.packageRoot, resolve(packageRoot));
  assert.equal(manifest.files["px-code-reviewer.md"].sha256, sha256Text(agentDoc("code review")));

  const before = readFileSync(manifestPath, "utf8");
  const second = syncAgents({ packageRoot, agentHome });
  assert.equal(second.actions.every((a) => a.op === "unchanged"), true);
  assert.equal(second.rewritten, false);
  assert.equal(readFileSync(manifestPath, "utf8"), before);

  const check = syncAgents({ packageRoot, agentHome, check: true });
  assert.equal(check.ok, true);
});

test("sync refuses locally modified managed files without --force", () => {
  const packageRoot = makePackage({
    "px-code-reviewer.md": agentDoc("code review"),
  });
  const agentHome = mkdtempSync(join(tmpdir(), "px-home-"));
  syncAgents({ packageRoot, agentHome });

  const dest = join(agentsDirFor(agentHome), "px-code-reviewer.md");
  writeFileSync(dest, "locally changed\n");

  assert.throws(() => syncAgents({ packageRoot, agentHome }), /modified locally/);

  const forced = syncAgents({ packageRoot, agentHome, force: true });
  assert.equal(forced.ok, true);
  assert.equal(readFileSync(dest, "utf8"), agentDoc("code review"));
});

test("sync refuses unmanaged destination without --force", () => {
  const packageRoot = makePackage({
    "px-code-reviewer.md": agentDoc("code review"),
  });
  const agentHome = mkdtempSync(join(tmpdir(), "px-home-"));
  mkdirSync(agentsDirFor(agentHome), { recursive: true });
  writeFileSync(join(agentsDirFor(agentHome), "px-code-reviewer.md"), "unmanaged\n");

  assert.throws(() => syncAgents({ packageRoot, agentHome }), /not managed/);
  syncAgents({ packageRoot, agentHome, force: true });
  assert.equal(readFileSync(join(agentsDirFor(agentHome), "px-code-reviewer.md"), "utf8"), agentDoc("code review"));
});

test("sync --remove never deletes hash-modified files even with --force", () => {
  const packageRoot = makePackage({
    "px-code-reviewer.md": agentDoc("code review"),
    "px-simplify-reuse.md": agentDoc("reuse"),
  });
  const agentHome = mkdtempSync(join(tmpdir(), "px-home-"));
  syncAgents({ packageRoot, agentHome });

  const keepPath = join(agentsDirFor(agentHome), "px-simplify-reuse.md");
  writeFileSync(keepPath, "tampered\n");

  assert.throws(() => syncAgents({ packageRoot, agentHome, remove: true }), /modified locally/);
  assert.throws(
    () => syncAgents({ packageRoot, agentHome, remove: true, force: true }),
    /even with --force/,
  );
  assert.equal(readFileSync(keepPath, "utf8"), "tampered\n");
  assert.equal(existsGone(manifestPathFor(agentHome)), false);

  writeFileSync(keepPath, agentDoc("reuse"));
  const removed = syncAgents({ packageRoot, agentHome, remove: true });
  assert.deepEqual(
    new Set(removed.removed),
    new Set(["px-code-reviewer.md", "px-simplify-reuse.md"]),
  );
  assert.equal(existsGone(manifestPathFor(agentHome)), true);
});

test("sync --check fails for stale missing destinations", () => {
  const packageRoot = makePackage({
    "px-code-reviewer.md": agentDoc("code review"),
  });
  const agentHome = mkdtempSync(join(tmpdir(), "px-home-"));
  syncAgents({ packageRoot, agentHome });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "pi-extensions", version: "0.1.0" }),
  );
  // Remove the agent from package sources and leave a stale manifest entry by editing package agents away.
  writeFileSync(join(packageRoot, "agents", "px-code-reviewer.md"), agentDoc("code review"));
  const staleHome = mkdtempSync(join(tmpdir(), "px-home-"));
  syncAgents({ packageRoot, agentHome: staleHome });
  writeFileSync(
    join(staleHome, "pi-extensions-managed-agents.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        packageName: "pi-extensions",
        packageVersion: "0.1.0",
        packageRoot: packageRoot,
        updatedAt: new Date().toISOString(),
        files: {
          "px-code-reviewer.md": {
            sha256: sha256Text(agentDoc("code review")),
            source: "agents/px-code-reviewer.md",
          },
          "px-gone.md": {
            sha256: sha256Text("gone\n"),
            source: "agents/px-gone.md",
          },
        },
      },
      null,
      2,
    ),
  );

  const check = syncAgents({ packageRoot, agentHome: staleHome, check: true });
  assert.equal(check.ok, false);
  assert.ok(check.actions.some((action) => action.op === "stale-missing" && action.name === "px-gone.md"));
});

test("validateManagedManifest rejects bad package/schema/filenames/hashes", () => {
  assert.throws(
    () => validateManagedManifest({ packageName: "x", packageVersion: "1", files: {} }),
    /schemaVersion/,
  );
  assert.throws(
    () =>
      validateManagedManifest({
        schemaVersion: 1,
        packageName: "x",
        packageVersion: "1",
        packageRoot: "/tmp/pi-extensions",
        files: { "evil.md": { sha256: "a".repeat(64), source: "agents/evil.md" } },
      }),
    /unexpected filename/,
  );
  assert.throws(
    () =>
      validateManagedManifest({
        schemaVersion: 1,
        packageName: "x",
        packageVersion: "1",
        packageRoot: "/tmp/pi-extensions",
        files: { "px-a.md": { sha256: "nope", source: "agents/px-a.md" } },
      }),
    /invalid sha256/,
  );
});

test("sync rejects symlink destinations and unexpected filenames", () => {
  const packageRoot = makePackage({
    "px-code-reviewer.md": agentDoc("code review"),
  });
  const agentHome = mkdtempSync(join(tmpdir(), "px-home-"));
  const agentsDir = agentsDirFor(agentHome);
  mkdirSync(agentsDir, { recursive: true });
  const outside = join(agentHome, "outside.md");
  writeFileSync(outside, "x\n");
  try {
    symlinkSync(outside, join(agentsDir, "px-code-reviewer.md"));
  } catch (error) {
    if (error.code === "EPERM") {
      // Some CI sandboxes disallow symlinks; skip assertion in that environment.
      return;
    }
    throw error;
  }

  assert.throws(() => syncAgents({ packageRoot, agentHome, force: true }), /symlink/);

  writeFileSync(join(packageRoot, "agents", "not-prefixed.md"), agentDoc("bad"));
  const home2 = mkdtempSync(join(tmpdir(), "px-home-"));
  const result = syncAgents({ packageRoot, agentHome: home2 });
  assert.equal(result.managedCount, 1);
});

test("sync updates when package content changes and previous hash matches", () => {
  const packageRoot = makePackage({
    "px-code-reviewer.md": agentDoc("v1"),
  });
  const agentHome = mkdtempSync(join(tmpdir(), "px-home-"));
  syncAgents({ packageRoot, agentHome });
  writeFileSync(join(packageRoot, "agents", "px-code-reviewer.md"), agentDoc("v2"));
  const updated = syncAgents({ packageRoot, agentHome });
  assert.equal(updated.actions.some((a) => a.op === "update"), true);
  assert.equal(
    readFileSync(join(agentsDirFor(agentHome), "px-code-reviewer.md"), "utf8"),
    agentDoc("v2"),
  );
});

test("stale locks are recovered using pid and age", () => {
  const dir = mkdtempSync(join(tmpdir(), "px-lock-"));
  const lockPath = join(dir, ".lock");
  writeFileSync(lockPath, "999999\n2000-01-01T00:00:00.000Z\n");
  assert.equal(isLockStale(lockPath, { staleMs: 1000 }), true);

  let ran = false;
  withExclusiveLock(lockPath, () => {
    ran = true;
  }, { staleMs: 1000, retries: 5, delayMs: 1 });
  assert.equal(ran, true);

  writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`);
  assert.equal(isLockStale(lockPath, { staleMs: 30_000 }), false);
});
