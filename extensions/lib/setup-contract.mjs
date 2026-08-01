import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function expandHome(path) {
  if (path === "~") return process.env.HOME ?? process.env.USERPROFILE ?? path;
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (!home) return path;
    return join(home, path.slice(2));
  }
  return path;
}

function assertPackageRoot(root) {
  if (!isAbsolute(root)) {
    throw new Error(`PI_EXTENSIONS_ROOT must be absolute: ${root}`);
  }
  const manifestPath = join(root, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`PI_EXTENSIONS_ROOT missing package.json: ${root}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`PI_EXTENSIONS_ROOT has invalid package.json: ${root}`);
  }
  if (manifest?.name !== "pi-extensions") {
    throw new Error(
      `PI_EXTENSIONS_ROOT must point at pi-extensions (found ${manifest?.name ?? "unknown"}): ${root}`,
    );
  }
}

export const SYNC_COMMAND = "pi-extensions-sync";
export const DOCTOR_COMMAND = "pi-extensions-doctor";

export const SYNC_ALLOWED_FLAGS = ["--check", "--force", "--remove"];
export const DOCTOR_ALLOWED_FLAGS = ["--skip-models"];

const SYNC_ALLOWED = new Set(SYNC_ALLOWED_FLAGS);
const DOCTOR_ALLOWED = new Set(DOCTOR_ALLOWED_FLAGS);

export function tokenizeArgs(argsString) {
  const trimmed = String(argsString ?? "").trim();
  return trimmed ? trimmed.split(/\s+/).filter(Boolean) : [];
}

export function parseSyncArgs(argsString) {
  const tokens = tokenizeArgs(argsString);
  const flags = [];

  for (const token of tokens) {
    if (!SYNC_ALLOWED.has(token)) {
      return {
        ok: false,
        error: `Unknown flag: ${token}. Allowed: ${SYNC_ALLOWED_FLAGS.join(", ")}`,
      };
    }
    if (flags.includes(token)) {
      return { ok: false, error: `Duplicate flag: ${token}` };
    }
    flags.push(token);
  }

  if (flags.includes("--check") && flags.includes("--remove")) {
    return { ok: false, error: "--check and --remove are mutually exclusive" };
  }

  return {
    ok: true,
    check: flags.includes("--check"),
    force: flags.includes("--force"),
    remove: flags.includes("--remove"),
    argv: flags,
  };
}

export function parseDoctorArgs(argsString) {
  const tokens = tokenizeArgs(argsString);
  const flags = [];

  for (const token of tokens) {
    if (!DOCTOR_ALLOWED.has(token)) {
      return {
        ok: false,
        error: `Unknown flag: ${token}. Allowed: ${DOCTOR_ALLOWED_FLAGS.join(", ")}`,
      };
    }
    if (flags.includes(token)) {
      return { ok: false, error: `Duplicate flag: ${token}` };
    }
    flags.push(token);
  }

  return {
    ok: true,
    skipModels: flags.includes("--skip-models"),
    argv: flags,
  };
}

/** Default sync, --force sync, and --remove mutate global agent files; --check does not. */
export function isMutatingSyncOperation(parsed) {
  if (!parsed?.ok) return false;
  return !parsed.check;
}

export function requiresInteractiveConfirmation(parsed) {
  return isMutatingSyncOperation(parsed);
}

/**
 * Resolve the pi-extensions package root from an extension module URL.
 * Honors PI_EXTENSIONS_ROOT when set; otherwise walks upward until it finds
 * package.json with name "pi-extensions".
 */
export function discoverPackageRoot(moduleUrl, env = process.env) {
  if (env.PI_EXTENSIONS_ROOT) {
    const fromEnv = resolve(expandHome(env.PI_EXTENSIONS_ROOT));
    assertPackageRoot(fromEnv);
    return fromEnv;
  }

  let current = resolve(dirname(fileURLToPath(moduleUrl)));
  const seen = new Set();

  while (!seen.has(current)) {
    seen.add(current);
    const manifestPath = join(current, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (manifest?.name === "pi-extensions") {
          return current;
        }
      } catch {
        // keep walking
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(
    "pi-extensions package root not found from extension module; reinstall the package or set PI_EXTENSIONS_ROOT",
  );
}

export function scriptPathFor(packageRoot, scriptName) {
  return join(resolve(packageRoot), "scripts", scriptName);
}

/** Static registration contract checked by tests (command names and allowlists). */
export const SETUP_EXTENSION_CONTRACT = {
  commands: [
    {
      name: SYNC_COMMAND,
      allowedFlags: SYNC_ALLOWED_FLAGS,
      mutatingByDefault: true,
      readOnlyFlags: ["--check"],
    },
    {
      name: DOCTOR_COMMAND,
      allowedFlags: DOCTOR_ALLOWED_FLAGS,
      mutatingByDefault: false,
      readOnlyFlags: DOCTOR_ALLOWED_FLAGS,
    },
  ],
  importNeverWritesGlobally: true,
  nonUiMutationsFailClosed: true,
};
