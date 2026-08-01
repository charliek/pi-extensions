import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { validateRepository } from "../scripts/validate-resources.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

test("repository resource contract is valid", () => {
  assert.equal(validateRepository(repositoryRoot), true);
});

test("validator rejects a package without resource directories", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensions-test-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ pi: { extensions: ["./extensions"], skills: ["./skills"], prompts: ["./prompts"] } }),
  );

  assert.throws(() => validateRepository(root), /required resource directory is missing/);
});
