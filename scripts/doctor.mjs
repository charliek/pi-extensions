import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  defaultAgentHome,
  listManagedSourceAgents,
  manifestPathFor,
  packageInfo,
  syncAgents,
} from "./sync-agents.mjs";
import { expandHome, readJsonIfExists } from "./lib/fs-safety.mjs";

export const REQUIRED_PI_PACKAGES = ["@tintinweb/pi-subagents", "pi-cursor-sdk"];

export const REQUIRED_MODELS = [
  "cursor/grok-4.5",
  "openai-codex/gpt-5.6-sol",
  "zai-coding-cn/glm-5.2",
  "cursor/composer-2-5",
  "cursor/kimi-k3",
];

function run(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
  });
}

export function detectPiBinary() {
  const result = run(process.platform === "win32" ? "where" : "which", ["pi"]);
  if (result.status !== 0) return null;
  return result.stdout.trim().split(/\r?\n/)[0] || null;
}

export function listInstalledPiPackages(agentHome = defaultAgentHome()) {
  const packageJsonPath = join(agentHome, "npm", "package.json");
  const manifest = readJsonIfExists(packageJsonPath, null);
  const deps = {
    ...(manifest?.dependencies ?? {}),
    ...(manifest?.devDependencies ?? {}),
  };
  const installed = {};
  for (const name of Object.keys(deps)) {
    const pkgPath = join(agentHome, "npm", "node_modules", ...name.split("/"), "package.json");
    if (!existsSync(pkgPath)) {
      installed[name] = { declared: deps[name], installed: null, path: pkgPath };
      continue;
    }
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    installed[name] = { declared: deps[name], installed: pkg.version ?? null, path: pkgPath };
  }
  return { path: packageJsonPath, installed };
}

function normalizeModelId(id) {
  return String(id).trim().toLowerCase();
}

function addModel(models, raw) {
  if (typeof raw !== "string" || !raw.trim()) return;
  const id = raw.trim();
  models.add(normalizeModelId(id.includes("/") ? id : `cursor/${id}`));
}

/**
 * Parse `pi --list-models` provider/model table output.
 * Accepts headered tables and bare "provider model ..." rows.
 */
export function parsePiModelTable(text) {
  const models = new Set();
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^provider\s+model\b/i.test(trimmed)) continue;
    if (trimmed.endsWith(":") && !trimmed.includes(" ")) continue;

    // Table rows: provider  model  context  max-out  ...
    const tableMatch = trimmed.match(/^(\S+)\s+(\S+)(?:\s+\S+)*$/);
    if (tableMatch) {
      const provider = tableMatch[1];
      const model = tableMatch[2];
      if (/^provider$/i.test(provider) || /^model$/i.test(model)) continue;
      if (provider.includes("/") || model.includes("/")) {
        // Already-qualified first token
        if (provider.includes("/")) addModel(models, provider);
        else addModel(models, `${provider}/${model}`);
      } else {
        addModel(models, `${provider}/${model}`);
      }
      continue;
    }

    const token = trimmed.split(/\s+/)[0];
    if (token.includes("/")) addModel(models, token);
  }
  return models;
}

/**
 * Collect model ids and aliases from cursor-sdk-model-list.json shapes.
 */
export function collectCursorModelIds(cursorData) {
  const models = new Set();
  if (cursorData == null) return models;

  const addEntry = (entry) => {
    if (typeof entry === "string") {
      addModel(models, entry);
      return;
    }
    if (!entry || typeof entry !== "object") return;
    addModel(models, entry.id ?? entry.model ?? entry.name);
    if (Array.isArray(entry.aliases)) {
      for (const alias of entry.aliases) addModel(models, alias);
    }
    if (Array.isArray(entry.variants)) {
      for (const variant of entry.variants) {
        if (typeof variant === "string") addModel(models, variant);
        else if (variant && typeof variant === "object") {
          addModel(models, variant.id ?? variant.model ?? variant.name ?? variant.displayName);
        }
      }
    }
  };

  if (Array.isArray(cursorData)) {
    for (const entry of cursorData) addEntry(entry);
    return models;
  }

  if (typeof cursorData === "object") {
    const list = cursorData.models ?? cursorData.data;
    if (Array.isArray(list)) {
      for (const entry of list) addEntry(entry);
    } else {
      for (const key of Object.keys(cursorData)) {
        if (key.includes("/")) addModel(models, key);
      }
    }
  }
  return models;
}

export function collectAvailableModels({
  agentHome = defaultAgentHome(),
  piBinary = detectPiBinary(),
  listModelsOutput = null,
} = {}) {
  const models = new Set();

  const cursorList = join(agentHome, "cursor-sdk-model-list.json");
  const cursorData = readJsonIfExists(cursorList, null);
  for (const id of collectCursorModelIds(cursorData)) models.add(id);

  if (listModelsOutput != null) {
    for (const id of parsePiModelTable(listModelsOutput)) models.add(id);
  } else if (piBinary) {
    const listed = run(piBinary, ["--list-models"]);
    if (listed.status === 0 && listed.stdout) {
      for (const id of parsePiModelTable(listed.stdout)) models.add(id);
    }
  }

  return models;
}

export function runDoctor({
  packageRoot,
  agentHome = defaultAgentHome(),
  requiredPackages = REQUIRED_PI_PACKAGES,
  requiredModels = REQUIRED_MODELS,
  skipModelProbe = false,
  listModelsOutput = null,
} = {}) {
  const root = resolve(packageRoot);
  const home = resolve(expandHome(agentHome));
  const pkg = packageInfo(root);
  const diagnostics = [];
  let ok = true;

  const piBinary = detectPiBinary();
  if (!piBinary) {
    ok = false;
    diagnostics.push({
      level: "error",
      code: "pi-missing",
      message:
        "pi CLI not found on PATH. Install @earendil-works/pi-coding-agent and ensure `pi` is available.",
    });
  } else {
    const version = run(piBinary, ["--version"]);
    diagnostics.push({
      level: "info",
      code: "pi-present",
      message: `pi found at ${piBinary}${version.status === 0 ? ` (${version.stdout.trim()})` : ""}`,
    });
  }

  const { path: npmManifestPath, installed } = listInstalledPiPackages(home);
  if (!existsSync(npmManifestPath)) {
    ok = false;
    diagnostics.push({
      level: "error",
      code: "pi-packages-missing",
      message: `Pi package manifest missing at ${npmManifestPath}. Install prerequisites with: pi install npm:@tintinweb/pi-subagents && pi install npm:pi-cursor-sdk`,
    });
  }

  for (const name of requiredPackages) {
    const info = installed[name];
    if (!info?.installed) {
      ok = false;
      diagnostics.push({
        level: "error",
        code: "prerequisite-missing",
        message: `Required Pi package ${name} is not installed under ${home}/npm. Install separately with: pi install npm:${name}`,
      });
    } else {
      diagnostics.push({
        level: "info",
        code: "prerequisite-present",
        message: `${name}@${info.installed} present`,
      });
    }
  }

  const sources = listManagedSourceAgents(root);
  const manifestPath = manifestPathFor(home);
  const manifest = readJsonIfExists(manifestPath, null);

  if (sources.length === 0) {
    diagnostics.push({
      level: "info",
      code: "no-managed-agents",
      message: "No px-*.md agents in package agents/ yet; sync has nothing to install.",
    });
  } else if (!manifest) {
    ok = false;
    diagnostics.push({
      level: "error",
      code: "agents-not-synced",
      message: `Managed agents are not synchronized. Run: npm run sync-agents (manifest missing at ${manifestPath})`,
    });
  } else {
    if (manifest.packageVersion !== pkg.version) {
      ok = false;
      diagnostics.push({
        level: "error",
        code: "agent-version-skew",
        message: `Synchronized agent manifest version ${manifest.packageVersion} does not match package ${pkg.version}. Re-run: npm run sync-agents`,
      });
    } else {
      diagnostics.push({
        level: "info",
        code: "agent-version-ok",
        message: `Synchronized agents match package version ${pkg.version}`,
      });
    }

    try {
      const check = syncAgents({ packageRoot: root, agentHome: home, check: true });
      if (!check.ok) {
        ok = false;
        diagnostics.push({
          level: "error",
          code: "agent-sync-drift",
          message: "Managed agent files are out of sync with the package. Run: npm run sync-agents",
        });
      } else {
        diagnostics.push({
          level: "info",
          code: "agent-sync-ok",
          message: `Agent sync check passed (${check.managedCount} file(s))`,
        });
      }
    } catch (error) {
      ok = false;
      diagnostics.push({
        level: "error",
        code: "agent-sync-conflict",
        message: error.message,
      });
    }
  }

  if (!skipModelProbe) {
    const available = collectAvailableModels({
      agentHome: home,
      piBinary,
      listModelsOutput,
    });
    for (const model of requiredModels) {
      if (available.has(normalizeModelId(model))) {
        diagnostics.push({
          level: "info",
          code: "model-present",
          message: `Model available: ${model}`,
        });
      } else {
        ok = false;
        diagnostics.push({
          level: "error",
          code: "model-missing",
          message: `Required model not detected: ${model}. Authenticate the provider / install pi-cursor-sdk and verify with: pi --list-models`,
        });
      }
    }
  }

  return {
    ok,
    package: pkg,
    agentHome: home,
    diagnostics,
  };
}

const scriptPath = fileURLToPath(import.meta.url);
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const packageRoot = resolve(dirname(scriptPath), "..");
  const agentHome = process.env.PI_CODING_AGENT_DIR
    ? resolve(expandHome(process.env.PI_CODING_AGENT_DIR))
    : defaultAgentHome();
  const skipModelProbe = process.argv.includes("--skip-models");
  const result = runDoctor({ packageRoot, agentHome, skipModelProbe });
  for (const item of result.diagnostics) {
    const prefix = item.level === "error" ? "ERROR" : "INFO";
    console.log(`${prefix}: ${item.message}`);
  }
  if (!result.ok) {
    console.error("Doctor found issues.");
    process.exit(1);
  }
  console.log("Doctor checks passed.");
}
