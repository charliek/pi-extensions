import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REQUIRED_DIRECTORIES = ["agents", "extensions", "prompts", "skills"];

function markdownFiles(directory, recursive = false) {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return recursive ? markdownFiles(path, true) : [];
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

function frontmatter(path) {
  const content = readFileSync(path, "utf8");
  if (!content.startsWith("---\n")) throw new Error(`${path}: missing YAML frontmatter`);

  const end = content.indexOf("\n---", 4);
  if (end === -1) throw new Error(`${path}: unterminated YAML frontmatter`);

  const values = {};
  for (const line of content.slice(4, end).split("\n")) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "").trim();
  }
  return values;
}

function requireFrontmatter(path, keys) {
  const values = frontmatter(path);
  for (const key of keys) {
    if (!values[key]) throw new Error(`${path}: frontmatter field '${key}' is required`);
  }
}

export function validateRepository(root) {
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath)) throw new Error(`${packagePath}: missing`);

  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  if (!manifest.pi) throw new Error("package.json: missing pi manifest");

  for (const directory of REQUIRED_DIRECTORIES) {
    const path = join(root, directory);
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new Error(`${path}: required resource directory is missing`);
    }
  }

  for (const resource of ["extensions", "skills", "prompts"]) {
    const entries = manifest.pi[resource];
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`package.json: pi.${resource} must be a non-empty array`);
    }
    for (const entry of entries) {
      const path = resolve(root, entry);
      if (!existsSync(path)) throw new Error(`package.json: pi.${resource} path does not exist: ${entry}`);
    }
  }

  for (const path of markdownFiles(join(root, "agents"))) {
    requireFrontmatter(path, ["description"]);
  }
  for (const path of markdownFiles(join(root, "prompts"))) {
    requireFrontmatter(path, ["description"]);
  }
  for (const path of markdownFiles(join(root, "skills"), true).filter((path) => path.endsWith("/SKILL.md"))) {
    requireFrontmatter(path, ["name", "description"]);
  }

  return true;
}

const scriptPath = fileURLToPath(import.meta.url);
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = resolve(dirname(scriptPath), "..");
  validateRepository(root);
  console.log("Pi resource validation passed.");
}
