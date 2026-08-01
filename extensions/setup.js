import {
  DOCTOR_COMMAND,
  SYNC_COMMAND,
  discoverPackageRoot,
  isMutatingSyncOperation,
  parseDoctorArgs,
  parseSyncArgs,
} from "./lib/setup-contract.mjs";
import { notify, reportScriptResult, runPackageScript } from "./lib/script-executor.mjs";

/**
 * Pi setup extension: explicit /pi-extensions-sync and /pi-extensions-doctor commands.
 * Importing this package never writes globally; only these commands (or npm scripts) mutate agent files.
 */
export default function piExtensionsSetup(pi) {
  return createPiExtensionsSetup({ exec: (cmd, args, opts) => pi.exec(cmd, args, opts) })(pi);
}

/** Factory for handler tests with injectable exec and package root discovery. */
export function createPiExtensionsSetup({ exec, discoverRoot = discoverPackageRoot } = {}) {
  if (!exec) {
    throw new Error("createPiExtensionsSetup requires an exec function");
  }

  return function registerSetupCommands(pi) {
    const packageRoot = discoverRoot(import.meta.url);

    pi.registerCommand(SYNC_COMMAND, {
      description: "Synchronize px-* agents from pi-extensions into ~/.pi/agent/agents",
      handler: async (args, ctx) => {
        const parsed = parseSyncArgs(args);
        if (!parsed.ok) {
          notify(ctx, parsed.error, "error");
          return;
        }

        if (isMutatingSyncOperation(parsed)) {
          if (!ctx.hasUI) {
            notify(
              ctx,
              "Refusing mutating agent sync without interactive UI. Run: npm run sync-agents (from the pi-extensions checkout) or use /pi-extensions-sync --check in headless mode.",
              "error",
            );
            return;
          }

          const title = parsed.remove ? "Remove managed agents?" : "Synchronize managed agents?";
          const detail = parsed.remove
            ? "Removes only manifest-owned px-* files whose hashes still match."
            : parsed.force
              ? "May overwrite unmanaged or locally modified agent files (--force)."
              : "Copies repository-managed px-* agents to your Pi agent home.";
          const confirmed = await ctx.ui.confirm(title, detail);
          if (!confirmed) {
            ctx.ui.notify("Agent sync cancelled", "info");
            return;
          }
        }

        const result = await runPackageScript(exec, "sync-agents.mjs", parsed.argv, packageRoot);
        reportScriptResult(ctx, result, "Agent sync");
      },
    });

    pi.registerCommand(DOCTOR_COMMAND, {
      description: "Check pi-extensions prerequisites, agent sync state, and required models",
      handler: async (args, ctx) => {
        const parsed = parseDoctorArgs(args);
        if (!parsed.ok) {
          notify(ctx, parsed.error, "error");
          return;
        }

        const result = await runPackageScript(exec, "doctor.mjs", parsed.argv, packageRoot);
        reportScriptResult(ctx, result, "Doctor");
      },
    });
  };
}
