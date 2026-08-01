import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  DOCTOR_COMMAND,
  SYNC_COMMAND,
  discoverPackageRoot,
  scriptPathFor,
} from "../extensions/lib/setup-contract.mjs";
import { createPiExtensionsSetup } from "../extensions/setup.js";

const repositoryRoot = resolve(import.meta.dirname, "..");

function createFakePi(execImpl) {
  const commands = {};
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (execImpl) return execImpl(cmd, args, opts);
    return { code: 0, stdout: "ok\n", stderr: "", killed: false };
  };

  const pi = {
    commands,
    execCalls: () => calls.length,
    exec,
    registerCommand(name, def) {
      commands[name] = def;
    },
  };
  return pi;
}

function fakeCtx({ hasUI = true, confirmResult = true } = {}) {
  const notifications = [];
  return {
    hasUI,
    notifications,
    ui: {
      confirm: async () => confirmResult,
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };
}

function registerWithRoot(packageRoot, execImpl) {
  const pi = createFakePi(execImpl);
  const discoverRoot = () => packageRoot;
  createPiExtensionsSetup({ exec: pi.exec, discoverRoot })(pi);
  return pi;
}

test("sync handler rejects unknown flags without executing scripts", async () => {
  const pi = registerWithRoot(repositoryRoot);
  const ctx = fakeCtx();
  await pi.commands[SYNC_COMMAND].handler("--agent-home /tmp", ctx);
  assert.equal(pi.execCalls(), 0);
  assert.ok(ctx.notifications.some((n) => /Unknown flag/.test(n.message)));
});

test("sync handler refuses mutating operations without UI", async () => {
  const pi = registerWithRoot(repositoryRoot);
  const ctx = fakeCtx({ hasUI: false });
  let stderr = "";
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    stderr += String(chunk);
    return originalWrite(chunk, ...args);
  };
  try {
    await pi.commands[SYNC_COMMAND].handler("", ctx);
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(pi.execCalls(), 0);
  assert.match(stderr, /Refusing mutating agent sync/);
});

test("sync handler allows --check without UI and passes exact argv", async () => {
  let captured = null;
  const pi = registerWithRoot(repositoryRoot, async (cmd, args, opts) => {
    captured = { cmd, args, opts };
    return { code: 0, stdout: "Agent sync check passed (8 managed agents).\n", stderr: "", killed: false };
  });
  const ctx = fakeCtx({ hasUI: true });
  await pi.commands[SYNC_COMMAND].handler("--check", ctx);
  assert.equal(pi.execCalls(), 1);
  assert.equal(captured.cmd, process.execPath);
  assert.deepEqual(captured.args, [
    scriptPathFor(repositoryRoot, "sync-agents.mjs"),
    "--check",
  ]);
  assert.ok(ctx.notifications.some((n) => /Agent sync check passed/.test(n.message)));
});

test("sync handler requires confirmation for mutating sync and skips exec when cancelled", async () => {
  let executed = false;
  const pi = registerWithRoot(repositoryRoot, async () => {
    executed = true;
    return { code: 0, stdout: "", stderr: "", killed: false };
  });
  const ctx = fakeCtx({ confirmResult: false });
  await pi.commands[SYNC_COMMAND].handler("--force", ctx);
  assert.equal(executed, false);
  assert.ok(ctx.notifications.some((n) => n.message === "Agent sync cancelled"));
});

test("sync handler executes mutating sync after confirmation with exact argv", async () => {
  let captured = null;
  const pi = registerWithRoot(repositoryRoot, async (cmd, args) => {
    captured = { cmd, args };
    return { code: 0, stdout: "Synchronized 8 managed agent(s); 0 filesystem change(s).\n", stderr: "", killed: false };
  });
  const ctx = fakeCtx({ confirmResult: true });
  await pi.commands[SYNC_COMMAND].handler("--force --remove", ctx);
  assert.deepEqual(captured.args, [
    scriptPathFor(repositoryRoot, "sync-agents.mjs"),
    "--force",
    "--remove",
  ]);
});

test("sync handler reports stderr and non-zero exit as errors", async () => {
  const pi = registerWithRoot(repositoryRoot, async () => ({
    code: 1,
    stdout: "",
    stderr: "Agent sync check failed.\n",
    killed: false,
  }));
  const ctx = fakeCtx({ hasUI: true });
  await pi.commands[SYNC_COMMAND].handler("--check", ctx);
  assert.ok(ctx.notifications.some((n) => n.level === "error" && /Agent sync check failed/.test(n.message)));
});

test("sync handler reports killed exec as error", async () => {
  const pi = registerWithRoot(repositoryRoot, async () => ({
    code: null,
    stdout: "",
    stderr: "",
    killed: true,
  }));
  const ctx = fakeCtx();
  await pi.commands[SYNC_COMMAND].handler("--check", ctx);
  assert.ok(ctx.notifications.some((n) => /timed out or was killed/.test(n.message)));
});

test("doctor handler rejects unknown flags without executing scripts", async () => {
  const pi = registerWithRoot(repositoryRoot);
  const ctx = fakeCtx();
  await pi.commands[DOCTOR_COMMAND].handler("--force", ctx);
  assert.equal(pi.execCalls(), 0);
  assert.ok(ctx.notifications.some((n) => /Unknown flag/.test(n.message)));
});

test("doctor handler passes --skip-models argv to doctor script", async () => {
  let captured = null;
  const pi = registerWithRoot(repositoryRoot, async (_cmd, args) => {
    captured = args;
    return { code: 0, stdout: "Doctor checks passed.\n", stderr: "", killed: false };
  });
  const ctx = fakeCtx();
  await pi.commands[DOCTOR_COMMAND].handler("--skip-models", ctx);
  assert.deepEqual(captured, [scriptPathFor(repositoryRoot, "doctor.mjs"), "--skip-models"]);
});

test("discoverPackageRoot honors PI_EXTENSIONS_ROOT override", () => {
  const overrideRoot = mkdtempSync(join(tmpdir(), "px-root-override-"));
  writeFileSync(
    join(overrideRoot, "package.json"),
    JSON.stringify({ name: "pi-extensions", version: "0.1.0" }),
  );
  const nested = join(overrideRoot, "extensions", "setup.js");
  const resolved = discoverPackageRoot(pathToFileURL(nested).href, {
    ...process.env,
    PI_EXTENSIONS_ROOT: overrideRoot,
  });
  assert.equal(resolved, resolve(overrideRoot));
});
