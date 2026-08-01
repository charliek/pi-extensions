import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome, readJsonIfExists } from "./fs-safety.mjs";

export const MANIFEST_BASENAME = "pi-extensions-managed-agents.json";

export function defaultAgentHome(env = process.env) {
  const override = env.PI_CODING_AGENT_DIR;
  if (override) return resolve(expandHome(override));
  return resolve(expandHome("~/.pi/agent"));
}

export function managedManifestPath(agentHome = defaultAgentHome()) {
  return join(resolve(agentHome), MANIFEST_BASENAME);
}

/**
 * Resolve the pi-extensions package root for script invocation.
 * Precedence: PI_EXTENSIONS_ROOT env, managed manifest packageRoot (under PI_CODING_AGENT_DIR),
 * dev checkout fallback.
 */
export function resolvePackageRoot({ agentHome, env = process.env } = {}) {
  const home = agentHome ?? defaultAgentHome(env);
  if (env.PI_EXTENSIONS_ROOT) {
    const fromEnv = resolve(expandHome(env.PI_EXTENSIONS_ROOT));
    assertPackageRoot(fromEnv);
    return fromEnv;
  }

  const manifest = readJsonIfExists(managedManifestPath(home), null);
  if (manifest?.packageRoot) {
    const fromManifest = resolve(String(manifest.packageRoot));
    assertPackageRoot(fromManifest);
    return fromManifest;
  }

  const devRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  if (existsSync(join(devRoot, "package.json"))) {
    const pkg = readJsonIfExists(join(devRoot, "package.json"), null);
    if (pkg?.name === "pi-extensions") return devRoot;
  }

  throw new Error(
    "pi-extensions package root unknown; set PI_EXTENSIONS_ROOT or run npm run sync-agents from a checkout",
  );
}

export function scriptPath(scriptName, options = {}) {
  const env = options.env ?? process.env;
  const home = options.agentHome ?? defaultAgentHome(env);
  return join(resolvePackageRoot({ agentHome: home, env }), "scripts", scriptName);
}

function assertPackageRoot(root) {
  if (!isAbsolute(root)) {
    throw new Error(`package root must be absolute: ${root}`);
  }
  if (!existsSync(join(root, "package.json"))) {
    throw new Error(`package root missing package.json: ${root}`);
  }
}
