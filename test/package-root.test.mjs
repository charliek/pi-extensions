import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { resolvePackageRoot, scriptPath } from "../scripts/lib/package-root.mjs";
import { syncAgents } from "../scripts/sync-agents.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

function makePackage() {
  const root = mkdtempSync(join(tmpdir(), "px-pkg-root-"));
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "pi-extensions", version: "0.1.0" }),
  );
  writeFileSync(
    join(root, "agents", "px-code-reviewer.md"),
    `---
description: test
tools: read
disallowed_tools: bash, edit, write
prompt_mode: append
---

Body
`,
  );
  return root;
}

test("resolvePackageRoot reads manifest from PI_CODING_AGENT_DIR before default home", () => {
  const packageRoot = makePackage();
  const customHome = mkdtempSync(join(tmpdir(), "px-custom-home-"));
  syncAgents({ packageRoot, agentHome: customHome });

  const resolved = resolvePackageRoot({
    env: (() => {
      const env = { ...process.env };
      delete env.PI_EXTENSIONS_ROOT;
      env.PI_CODING_AGENT_DIR = customHome;
      return env;
    })(),
  });
  assert.equal(resolved, resolve(packageRoot));
});

test("resolvePackageRoot prefers PI_EXTENSIONS_ROOT override", () => {
  const packageRoot = makePackage();
  const agentHome = mkdtempSync(join(tmpdir(), "px-home-root-"));
  syncAgents({ packageRoot, agentHome });

  const resolved = resolvePackageRoot({
    agentHome,
    env: { ...process.env, PI_EXTENSIONS_ROOT: packageRoot },
  });
  assert.equal(resolved, resolve(packageRoot));
});

test("resolvePackageRoot reads packageRoot from managed manifest", () => {
  const packageRoot = makePackage();
  const agentHome = mkdtempSync(join(tmpdir(), "px-home-root-"));
  syncAgents({ packageRoot, agentHome });

  const resolved = resolvePackageRoot({
    agentHome,
    env: (() => {
      const env = { ...process.env };
      delete env.PI_EXTENSIONS_ROOT;
      return env;
    })(),
  });
  assert.equal(resolved, resolve(packageRoot));
  assert.equal(scriptPath("capture-scope.mjs", { agentHome }), join(resolve(packageRoot), "scripts", "capture-scope.mjs"));
});

test("resolvePackageRoot falls back to dev checkout when manifest absent", () => {
  const agentHome = mkdtempSync(join(tmpdir(), "px-home-root-"));
  const resolved = resolvePackageRoot({
    agentHome,
    env: (() => {
      const env = { ...process.env };
      delete env.PI_EXTENSIONS_ROOT;
      return env;
    })(),
  });
  assert.equal(resolved, repositoryRoot);
});

test("sync manifest records absolute packageRoot", () => {
  const packageRoot = makePackage();
  const agentHome = mkdtempSync(join(tmpdir(), "px-home-root-"));
  const result = syncAgents({ packageRoot, agentHome });
  assert.equal(result.manifest.packageRoot, resolve(packageRoot));
});
