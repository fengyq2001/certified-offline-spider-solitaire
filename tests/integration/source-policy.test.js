import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { exists, projectPath } from "./test-support.js";

const hasSource = await exists("src");

test("deal generation and runtime seed selection never use Math.random", {
  skip: hasSource ? false : "source tree does not exist yet",
}, async () => {
  const candidateFiles = [
    projectPath("src", "core", "generator.js"),
    projectPath("src", "runtime", "random.js"),
    projectPath("src", "runtime", "seed-library.js"),
  ];
  const files = [];
  for (const file of candidateFiles) {
    try {
      await readFile(file, "utf8");
      files.push(file);
    } catch {
      // A missing optional runtime module is covered by its capability test.
    }
  }
  const violations = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (/\bMath\.random\s*\(/.test(text)) violations.push(file.slice(projectPath().length + 1));
  }
  assert.deepEqual(violations, [], `Math.random is forbidden: ${violations.join(", ")}`);
});
