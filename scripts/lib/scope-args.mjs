import { assertSafeGitRevision } from "./git.mjs";
import { normalizeLiteralRepoPath } from "./path-filters.mjs";

/**
 * Parse scope CLI flags. Paths and focus require explicit --path / --focus;
 * trailing positional tokens are rejected to avoid ambiguous inference.
 * --path values are normalized to repository-relative literal file paths.
 */
export function parseScopeArgs(argv) {
  const options = {
    cwd: process.cwd(),
    mode: "uncommitted",
    ref: null,
    paths: [],
    focus: null,
    help: false,
  };

  let sawStaged = false;
  let sawRef = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--staged") {
      if (sawStaged) throw new Error("duplicate --staged");
      sawStaged = true;
      options.mode = "staged";
    } else if (arg === "--ref") {
      if (sawRef) throw new Error("duplicate --ref");
      sawRef = true;
      options.mode = "ref";
      const value = argv[++i];
      if (value == null) throw new Error("--ref requires a revision or range");
      options.ref = assertSafeGitRevision(value);
    } else if (arg === "--path") {
      const value = argv[++i];
      if (value == null) throw new Error("--path requires a file path");
      options.paths.push(normalizeLiteralRepoPath(value));
    } else if (arg === "--focus") {
      const value = argv[++i];
      if (value == null) throw new Error("--focus requires text");
      options.focus = value;
    } else if (arg === "--cwd") {
      options.cwd = argv[++i];
      if (options.cwd == null) throw new Error("--cwd requires a directory");
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown or positional argument rejected (use --path / --focus): ${arg}`);
    }
  }

  if (sawStaged && sawRef) {
    throw new Error("--staged cannot be combined with --ref");
  }

  return options;
}
