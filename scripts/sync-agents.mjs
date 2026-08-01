import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertNotSymlink,
  assertSafeAgentFilename,
  assertSafePath,
  atomicWriteFile,
  expandHome,
  readJsonIfExists,
  resolveInside,
  sha256File,
  sha256Text,
  withExclusiveLock,
  writeJsonAtomic,
} from "./lib/fs-safety.mjs";

const MANIFEST_BASENAME = "pi-extensions-managed-agents.json";
const MANIFEST_SCHEMA_VERSION = 1;
const MANAGED_FILENAME = /^px-[a-z0-9][a-z0-9-]*\.md$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const SYNC_LOCK_BASENAME = ".pi-extensions-sync.lock";

export function defaultAgentHome() {
  const override = process.env.PI_CODING_AGENT_DIR;
  if (override) return resolve(expandHome(override));
  return resolve(expandHome("~/.pi/agent"));
}

export function manifestPathFor(agentHome) {
  return join(resolve(agentHome), MANIFEST_BASENAME);
}

export function agentsDirFor(agentHome) {
  return join(resolve(agentHome), "agents");
}

export function packageInfo(packageRoot) {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  return {
    name: manifest.name ?? "pi-extensions",
    version: manifest.version ?? "0.0.0",
  };
}

export function listManagedSourceAgents(packageRoot) {
  const dir = join(packageRoot, "agents");
  if (!existsSync(dir)) return [];
  assertSafePath(dir, { root: resolve(packageRoot), label: dir });
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .filter((name) => MANAGED_FILENAME.test(name))
    .sort()
    .map((name) => {
      assertSafeAgentFilename(name);
      const sourcePath = resolveInside(dir, name);
      assertSafePath(sourcePath, { root: resolve(packageRoot), label: sourcePath });
      const content = readFileSync(sourcePath);
      return {
        name,
        sourcePath,
        content,
        sha256: sha256Text(content.toString("utf8")),
      };
    });
}

export function validateManagedManifest(data, path = "<manifest>") {
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${path}: invalid managed-agent manifest`);
  }
  if (data.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `${path}: unsupported manifest schemaVersion ${data.schemaVersion}; expected ${MANIFEST_SCHEMA_VERSION}`,
    );
  }
  if (typeof data.packageName !== "string" || !data.packageName.trim()) {
    throw new Error(`${path}: packageName must be a non-empty string`);
  }
  if (typeof data.packageVersion !== "string" || !data.packageVersion.trim()) {
    throw new Error(`${path}: packageVersion must be a non-empty string`);
  }
  if (data.files == null || typeof data.files !== "object" || Array.isArray(data.files)) {
    throw new Error(`${path}: files must be an object`);
  }
  for (const [name, meta] of Object.entries(data.files)) {
    if (!MANAGED_FILENAME.test(name)) {
      throw new Error(`${path}: unexpected filename in manifest: ${name}`);
    }
    if (meta == null || typeof meta !== "object" || Array.isArray(meta)) {
      throw new Error(`${path}: invalid file metadata for ${name}`);
    }
    if (typeof meta.sha256 !== "string" || !SHA256_HEX.test(meta.sha256)) {
      throw new Error(`${path}: invalid sha256 for ${name}`);
    }
    if (typeof meta.source !== "string" || !meta.source.trim()) {
      throw new Error(`${path}: source must be a non-empty string for ${name}`);
    }
  }
  return data;
}

function loadManifest(agentHome) {
  const path = manifestPathFor(agentHome);
  const data = readJsonIfExists(path, null);
  if (!data) return { path, data: null };
  return { path, data: validateManagedManifest(data, path) };
}

function currentDestinationHash(destPath, home) {
  if (!existsSync(destPath)) return null;
  assertSafePath(destPath, { root: home, label: destPath });
  return sha256File(destPath);
}

function conflictMessage(name, reason) {
  return `refusing to modify ${name}: ${reason}`;
}

function manifestsEquivalent(existing, next) {
  if (!existing) return false;
  if (existing.schemaVersion !== next.schemaVersion) return false;
  if (existing.packageName !== next.packageName) return false;
  if (existing.packageVersion !== next.packageVersion) return false;
  const left = existing.files ?? {};
  const right = next.files ?? {};
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let i = 0; i < leftKeys.length; i += 1) {
    if (leftKeys[i] !== rightKeys[i]) return false;
    const a = left[leftKeys[i]];
    const b = right[rightKeys[i]];
    if (a.sha256 !== b.sha256 || a.source !== b.source) return false;
  }
  return true;
}

function planSyncActions({ sources, agentsDir, existing, force, home }) {
  const plannedFiles = Object.fromEntries(
    sources.map((source) => [
      source.name,
      {
        sha256: source.sha256,
        source: `agents/${source.name}`,
      },
    ]),
  );

  const actions = [];
  const errors = [];

  for (const source of sources) {
    const destPath = resolveInside(agentsDir, source.name);
    const currentHash = currentDestinationHash(destPath, home);
    const previous = existing?.files?.[source.name];

    if (currentHash == null) {
      actions.push({
        op: "create",
        name: source.name,
        destPath,
        content: source.content,
        expectedHash: null,
        sourceSha256: source.sha256,
      });
      continue;
    }

    if (previous && previous.sha256 === currentHash && currentHash === source.sha256) {
      actions.push({ op: "unchanged", name: source.name, destPath, expectedHash: currentHash });
      continue;
    }

    if (previous && previous.sha256 === currentHash && currentHash !== source.sha256) {
      actions.push({
        op: "update",
        name: source.name,
        destPath,
        content: source.content,
        expectedHash: currentHash,
        sourceSha256: source.sha256,
      });
      continue;
    }

    if (!previous) {
      const message = conflictMessage(source.name, "destination exists and is not managed");
      if (force) {
        actions.push({
          op: "update",
          name: source.name,
          destPath,
          content: source.content,
          expectedHash: currentHash,
          sourceSha256: source.sha256,
          forced: true,
        });
      } else {
        errors.push(`${message} (use --force to overwrite unmanaged targets)`);
      }
      continue;
    }

    if (previous.sha256 !== currentHash) {
      const message = conflictMessage(source.name, "destination was modified locally");
      if (force) {
        actions.push({
          op: "update",
          name: source.name,
          destPath,
          content: source.content,
          expectedHash: currentHash,
          sourceSha256: source.sha256,
          forced: true,
        });
      } else {
        errors.push(`${message} (use --force to overwrite managed targets)`);
      }
      continue;
    }

    actions.push({
      op: "update",
      name: source.name,
      destPath,
      content: source.content,
      expectedHash: currentHash,
      sourceSha256: source.sha256,
    });
  }

  for (const name of Object.keys(existing?.files ?? {})) {
    if (plannedFiles[name]) continue;
    const destPath = resolveInside(agentsDir, name);
    const currentHash = currentDestinationHash(destPath, home);
    const previous = existing.files[name];
    if (currentHash == null) {
      actions.push({ op: "stale-missing", name, destPath });
      continue;
    }
    if (previous.sha256 !== currentHash) {
      // Never delete hash-modified leftovers during sync without force overwrite path;
      // force updates managed set by deleting only when hashes still match OR force for stale managed.
      if (!force) {
        errors.push(
          conflictMessage(name, "stale managed file was modified locally; not removing"),
        );
        continue;
      }
    }
    actions.push({
      op: "delete",
      name,
      destPath,
      expectedHash: currentHash,
    });
  }

  return { plannedFiles, actions, errors };
}

function revalidateBeforeMutation(action, home) {
  if (action.op === "create") {
    if (existsSync(action.destPath)) {
      throw new Error(
        conflictMessage(action.name, "destination appeared before create; re-run sync"),
      );
    }
    assertSafePath(dirname(action.destPath), { root: home, label: dirname(action.destPath) });
    return;
  }
  if (action.op === "update" || action.op === "delete") {
    const currentHash = currentDestinationHash(action.destPath, home);
    if (currentHash !== action.expectedHash) {
      throw new Error(
        conflictMessage(
          action.name,
          "destination changed during sync; refusing mutation (re-run sync)",
        ),
      );
    }
  }
}

export function syncAgents({
  packageRoot,
  agentHome = defaultAgentHome(),
  force = false,
  check = false,
  remove = false,
} = {}) {
  const root = resolve(packageRoot);
  const home = resolve(agentHome);
  mkdirSync(home, { recursive: true });
  assertNotSymlink(home);

  const lockPath = join(home, SYNC_LOCK_BASENAME);

  return withExclusiveLock(lockPath, () => {
    const pkg = packageInfo(root);
    const sources = listManagedSourceAgents(root);
    const agentsDir = agentsDirFor(home);
    const { path: manifestPath, data: existing } = loadManifest(home);

    if (existsSync(agentsDir)) assertSafePath(agentsDir, { root: home, label: agentsDir });
    if (existsSync(manifestPath)) assertSafePath(manifestPath, { root: home, label: manifestPath });

    if (remove) {
      return removeManagedAgents({ home, agentsDir, manifestPath, existing, check });
    }

    const { plannedFiles, actions, errors } = planSyncActions({
      sources,
      agentsDir,
      existing,
      force,
      home,
    });

    const versionSkew =
      existing && existing.packageVersion && existing.packageVersion !== pkg.version
        ? {
            manifestVersion: existing.packageVersion,
            packageVersion: pkg.version,
          }
        : null;

    if (errors.length > 0) {
      const error = new Error(errors.join("\n"));
      error.code = "SYNC_CONFLICT";
      error.errors = errors;
      error.versionSkew = versionSkew;
      throw error;
    }

    if (check) {
      const pending = actions.filter((action) => action.op !== "unchanged");
      return {
        ok: pending.length === 0 && !versionSkew,
        check: true,
        actions,
        versionSkew,
        package: pkg,
        agentHome: home,
        manifestPath,
        managedCount: sources.length,
      };
    }

    const mutating = actions.filter(
      (action) => action.op === "create" || action.op === "update" || action.op === "delete",
    );
    const nextManifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      packageName: pkg.name,
      packageVersion: pkg.version,
      updatedAt: new Date().toISOString(),
      files: plannedFiles,
    };
    const manifestChanged = !manifestsEquivalent(existing, nextManifest);

    if (mutating.length === 0 && !manifestChanged) {
      return {
        ok: true,
        check: false,
        actions,
        versionSkew: null,
        package: pkg,
        agentHome: home,
        manifestPath,
        managedCount: sources.length,
        manifest: existing,
        rewritten: false,
      };
    }

    if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true });
    assertSafePath(agentsDir, { root: home, label: agentsDir });

    for (const action of mutating) {
      revalidateBeforeMutation(action, home);
      if (action.op === "create" || action.op === "update") {
        atomicWriteFile(action.destPath, action.content, { root: home });
      } else if (action.op === "delete") {
        unlinkSync(action.destPath);
      }
    }

    if (manifestChanged || mutating.length > 0) {
      writeJsonAtomic(manifestPath, nextManifest, { root: home });
    }

    return {
      ok: true,
      check: false,
      actions,
      versionSkew: null,
      package: pkg,
      agentHome: home,
      manifestPath,
      managedCount: sources.length,
      manifest: nextManifest,
      rewritten: true,
    };
  });
}

function removeManagedAgents({ home, agentsDir, manifestPath, existing, check }) {
  if (!existing) {
    return {
      ok: true,
      removed: [],
      check,
      agentHome: home,
      manifestPath,
      message: "no managed-agent manifest present",
    };
  }

  const actions = [];
  const errors = [];
  const skippedModified = [];

  for (const [name, meta] of Object.entries(existing.files ?? {})) {
    if (!MANAGED_FILENAME.test(name)) {
      errors.push(`manifest contains unexpected filename: ${name}`);
      continue;
    }
    const destPath = resolveInside(agentsDir, name);
    const currentHash = currentDestinationHash(destPath, home);
    if (currentHash == null) {
      actions.push({ op: "missing", name, destPath });
      continue;
    }
    if (meta.sha256 !== currentHash) {
      // --remove never deletes hash-modified files, even with --force.
      skippedModified.push(name);
      errors.push(
        conflictMessage(
          name,
          "managed file was modified locally; not removing (even with --force)",
        ),
      );
      continue;
    }
    actions.push({ op: "delete", name, destPath, expectedHash: currentHash });
  }

  if (errors.length > 0) {
    const error = new Error(errors.join("\n"));
    error.code = "SYNC_CONFLICT";
    error.errors = errors;
    error.skippedModified = skippedModified;
    throw error;
  }

  if (check) {
    return {
      ok: actions.every((action) => action.op === "missing"),
      check: true,
      actions,
      agentHome: home,
      manifestPath,
      wouldRemove: actions.filter((a) => a.op === "delete").map((a) => a.name),
    };
  }

  for (const action of actions) {
    if (action.op === "delete") {
      revalidateBeforeMutation(action, home);
      unlinkSync(action.destPath);
    }
  }
  if (existsSync(manifestPath)) {
    assertSafePath(manifestPath, { root: home, label: manifestPath });
    unlinkSync(manifestPath);
  }

  return {
    ok: true,
    check: false,
    actions,
    removed: actions.filter((a) => a.op === "delete").map((a) => a.name),
    agentHome: home,
    manifestPath,
  };
}

function parseArgs(argv) {
  const options = {
    force: false,
    check: false,
    remove: false,
    agentHome: defaultAgentHome(),
    packageRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--force") options.force = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--remove") options.remove = true;
    else if (arg === "--agent-home") {
      options.agentHome = resolve(expandHome(argv[++i] ?? ""));
    } else if (arg === "--package-root") {
      options.packageRoot = resolve(argv[++i] ?? "");
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/sync-agents.mjs [--check] [--remove] [--force] [--agent-home DIR]

Copy repository-managed px-*.md agents into $PI_CODING_AGENT_DIR/agents
(default ~/.pi/agent/agents), tracking hashes in a manifest outside agents/.

  --check     Report whether destinations match the package (no writes)
  --remove    Remove only manifest-owned files whose hashes still match
              (never deletes hash-modified files, even with --force)
  --force     Overwrite unmanaged or locally modified destinations on install/update
  --agent-home DIR   Override PI_CODING_AGENT_DIR for this run
`);
}

const scriptPath = fileURLToPath(import.meta.url);
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      process.exit(0);
    }
    const result = syncAgents(options);
    if (options.check) {
      if (!result.ok) {
        console.error("Agent sync check failed.");
        if (result.versionSkew) {
          console.error(
            `Version skew: manifest ${result.versionSkew.manifestVersion} vs package ${result.versionSkew.packageVersion}`,
          );
        }
        for (const action of result.actions.filter((a) => a.op !== "unchanged")) {
          console.error(`- ${action.op}: ${action.name}`);
        }
        process.exit(1);
      }
      console.log(`Agent sync check passed (${result.managedCount} managed agents).`);
      process.exit(0);
    }
    if (options.remove) {
      console.log(`Removed ${result.removed?.length ?? 0} managed agent file(s).`);
      process.exit(0);
    }
    const written = result.actions.filter(
      (a) => a.op === "create" || a.op === "update" || a.op === "delete",
    );
    console.log(
      `Synchronized ${result.managedCount} managed agent(s); ${written.length} filesystem change(s).`,
    );
  } catch (error) {
    console.error(error.message ?? error);
    process.exit(1);
  }
}
