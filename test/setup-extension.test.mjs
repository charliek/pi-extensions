import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  DOCTOR_COMMAND,
  SETUP_EXTENSION_CONTRACT,
  SYNC_COMMAND,
  discoverPackageRoot,
  isMutatingSyncOperation,
  parseDoctorArgs,
  parseSyncArgs,
  requiresInteractiveConfirmation,
  scriptPathFor,
} from "../extensions/lib/setup-contract.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

test("discoverPackageRoot resolves from extensions/setup.js", () => {
  const moduleUrl = pathToFileURL(join(repositoryRoot, "extensions/setup.js")).href;
  const root = discoverPackageRoot(moduleUrl);
  assert.equal(root, repositoryRoot);
});

test("discoverPackageRoot resolves from a nested installed clone layout", () => {
  const installRoot = mkdtempSync(join(tmpdir(), "px-install-"));
  writeFileSync(
    join(installRoot, "package.json"),
    JSON.stringify({ name: "pi-extensions", version: "0.1.0" }),
  );
  const nested = join(installRoot, "extensions", "lib", "setup-contract.mjs");
  mkdirSync(dirname(nested), { recursive: true });
  writeFileSync(nested, "// fixture\n");
  assert.equal(discoverPackageRoot(pathToFileURL(nested).href), resolve(installRoot));
});

test("discoverPackageRoot throws when package name does not match", () => {
  const other = mkdtempSync(join(tmpdir(), "px-other-pkg-"));
  writeFileSync(join(other, "package.json"), JSON.stringify({ name: "other-package" }));
  const modulePath = join(other, "extensions/setup.js");
  mkdirSync(dirname(modulePath), { recursive: true });
  writeFileSync(modulePath, "// fixture\n");
  assert.throws(() => discoverPackageRoot(pathToFileURL(modulePath).href), /package root not found/);
});

test("discoverPackageRoot validates PI_EXTENSIONS_ROOT override", () => {
  const badRoot = mkdtempSync(join(tmpdir(), "px-bad-root-"));
  assert.throws(
    () =>
      discoverPackageRoot(pathToFileURL(join(repositoryRoot, "extensions/setup.js")).href, {
        ...process.env,
        PI_EXTENSIONS_ROOT: badRoot,
      }),
    /missing package\.json/,
  );

  writeFileSync(join(badRoot, "package.json"), JSON.stringify({ name: "other-package" }));
  assert.throws(
    () =>
      discoverPackageRoot(pathToFileURL(join(repositoryRoot, "extensions/setup.js")).href, {
        ...process.env,
        PI_EXTENSIONS_ROOT: badRoot,
      }),
    /must point at pi-extensions/,
  );
});

test("scriptPathFor resolves package-root-relative scripts", () => {
  const path = scriptPathFor(repositoryRoot, "sync-agents.mjs");
  assert.equal(path, join(repositoryRoot, "scripts", "sync-agents.mjs"));
  assert.equal(existsSync(path), true);
});

test("parseSyncArgs enforces strict allowlist and mutual exclusion", () => {
  assert.deepEqual(parseSyncArgs(""), {
    ok: true,
    check: false,
    force: false,
    remove: false,
    argv: [],
  });
  assert.deepEqual(parseSyncArgs("--check"), {
    ok: true,
    check: true,
    force: false,
    remove: false,
    argv: ["--check"],
  });
  assert.deepEqual(parseSyncArgs("--force --remove"), {
    ok: true,
    check: false,
    force: true,
    remove: true,
    argv: ["--force", "--remove"],
  });

  assert.match(parseSyncArgs("--agent-home /tmp").error, /Unknown flag/);
  assert.match(parseSyncArgs("--package-root /tmp").error, /Unknown flag/);
  assert.match(parseSyncArgs("--check --remove").error, /mutually exclusive/);
  assert.match(parseSyncArgs("--check --check").error, /Duplicate flag/);
});

test("parseDoctorArgs enforces strict allowlist", () => {
  assert.deepEqual(parseDoctorArgs(""), {
    ok: true,
    skipModels: false,
    argv: [],
  });
  assert.deepEqual(parseDoctorArgs("--skip-models"), {
    ok: true,
    skipModels: true,
    argv: ["--skip-models"],
  });
  assert.match(parseDoctorArgs("--force").error, /Unknown flag/);
});

test("mutating sync operations require interactive confirmation", () => {
  assert.equal(isMutatingSyncOperation(parseSyncArgs("")), true);
  assert.equal(isMutatingSyncOperation(parseSyncArgs("--force")), true);
  assert.equal(isMutatingSyncOperation(parseSyncArgs("--remove")), true);
  assert.equal(isMutatingSyncOperation(parseSyncArgs("--check")), false);
  assert.equal(requiresInteractiveConfirmation(parseSyncArgs("--check")), false);
  assert.equal(requiresInteractiveConfirmation(parseSyncArgs("--check --force")), false);
});

test("setup extension contract declares commands and safety rules", () => {
  assert.equal(SETUP_EXTENSION_CONTRACT.importNeverWritesGlobally, true);
  assert.equal(SETUP_EXTENSION_CONTRACT.nonUiMutationsFailClosed, true);

  const sync = SETUP_EXTENSION_CONTRACT.commands.find((cmd) => cmd.name === SYNC_COMMAND);
  const doctor = SETUP_EXTENSION_CONTRACT.commands.find((cmd) => cmd.name === DOCTOR_COMMAND);
  assert.ok(sync);
  assert.ok(doctor);
  assert.deepEqual(sync.allowedFlags, ["--check", "--force", "--remove"]);
  assert.deepEqual(doctor.allowedFlags, ["--skip-models"]);
  assert.equal(doctor.mutatingByDefault, false);
});

test("setup.js registers both setup commands and imports contract helpers", () => {
  const source = readFixture("extensions/setup.js");
  assert.match(source, /registerCommand\(\s*SYNC_COMMAND/);
  assert.match(source, /registerCommand\(\s*DOCTOR_COMMAND/);
  assert.match(source, /SYNC_COMMAND|pi-extensions-sync/);
  assert.match(source, /DOCTOR_COMMAND|pi-extensions-doctor/);
  assert.match(source, /parseSyncArgs/);
  assert.match(source, /parseDoctorArgs/);
  assert.match(source, /isMutatingSyncOperation/);
  assert.match(source, /ctx\.hasUI/);
  assert.match(source, /ctx\.ui\.confirm/);
  assert.match(source, /discoverPackageRoot/);
  assert.match(source, /runPackageScript/);
  assert.match(source, /await runPackageScript/);
  assert.doesNotMatch(source, /spawnSync/);
  assert.doesNotMatch(source, /syncAgents\s*\(/);
  assert.doesNotMatch(source, /writeFileSync|mkdirSync|unlinkSync/);

  const executorSource = readFixture("extensions/lib/script-executor.mjs");
  assert.match(executorSource, /scriptPathFor/);
});

function readFixture(relative) {
  return readFileSync(join(repositoryRoot, relative), "utf8");
}
