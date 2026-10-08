import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { exists, projectPath } from "./test-support.js";

const hasArtifact = await exists("dist", "index.html");

test("release artifact is one self-contained HTML file without remote dependencies", {
  skip: hasArtifact ? false : "dist/index.html has not been built yet",
}, async () => {
  const distEntries = (await readdir(projectPath("dist"))).filter((name) => !name.startsWith("."));
  assert.deepEqual(distEntries, ["index.html"]);

  const html = await readFile(projectPath("dist", "index.html"), "utf8");
  assert.match(html, /<!doctype html>/i);
  assert.doesNotMatch(html, /<(?:script|img|audio|video|source|link)\b[^>]*(?:src|href)\s*=\s*["'](?:https?:)?\/\//i);
  assert.doesNotMatch(html, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(\s*["']https?:\/\//i);
  assert.doesNotMatch(html, /\bimport\s*\(\s*["']https?:\/\//i);
});
