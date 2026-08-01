import { scriptPathFor } from "./setup-contract.mjs";

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Run a package script via an injectable exec (defaults to pi.exec in setup.js).
 * Returns normalized { code, stdout, stderr, killed, error }.
 */
export async function runPackageScript(exec, scriptName, argv, packageRoot, options = {}) {
  const scriptPath = scriptPathFor(packageRoot, scriptName);
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

  try {
    const result = await exec(process.execPath, [scriptPath, ...argv], { timeout });
    return normalizeExecResult(result);
  } catch (error) {
    return {
      code: null,
      stdout: "",
      stderr: "",
      killed: false,
      error,
    };
  }
}

export function normalizeExecResult(result) {
  return {
    code: result?.code ?? result?.status ?? null,
    stdout: String(result?.stdout ?? ""),
    stderr: String(result?.stderr ?? ""),
    killed: Boolean(result?.killed),
    error: result?.error ?? null,
  };
}

export function reportScriptResult(ctx, result, label) {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();

  if (stdout) {
    for (const line of stdout.split(/\r?\n/)) {
      notify(ctx, line, result.code === 0 ? "info" : "error");
    }
  }
  if (stderr) {
    for (const line of stderr.split(/\r?\n/)) {
      notify(ctx, line, "error");
    }
  }

  if (result.code === 0) {
    if (!stdout) notify(ctx, `${label} checks passed.`, "info");
  } else if (result.killed) {
    notify(ctx, `${label} timed out or was killed.`, "error");
  } else if (result.error) {
    notify(ctx, `${label} failed: ${result.error.message ?? result.error}`, "error");
  } else if (!stderr && !stdout) {
    notify(ctx, `${label} failed (exit ${result.code ?? "unknown"}).`, "error");
  }
}

export function notify(ctx, message, level) {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  } else {
    const stream = level === "error" ? process.stderr : process.stdout;
    stream.write(`${message}\n`);
  }
}
