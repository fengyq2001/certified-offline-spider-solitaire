import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyThirdPartyLicenses } from "../../scripts/verify-licenses.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const COMMIT = "1".repeat(40);

async function write(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

async function walk(directory, base = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(file, base));
    else if (entry.isFile()) files.push(path.relative(base, file).split(path.sep).join("/"));
  }
  return files.sort();
}

async function treeHash(directory) {
  const hash = createHash("sha256");
  const files = await walk(directory);
  for (const relative of files) {
    const fileHash = createHash("sha256").update(await readFile(path.join(directory, relative))).digest("hex");
    hash.update(`${relative}\0${fileHash}\n`);
  }
  return { fileCount: files.length, treeSha256: hash.digest("hex") };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "spider-license-test-"));
  const tool = path.join(root, "tools", "demo");
  await write(path.join(root, "package.json"), '{"name":"fixture","private":true}\n');
  await write(path.join(root, "THIRD_PARTY_LICENSES.md"), `# Third-party license register\n\n| Project | License | Use |\n|---|---|---|\n| \`acme/demo\` | Apache-2.0 | Vendored at \`tools/demo\` commit \`${COMMIT}\`. |\n`);
  await write(path.join(tool, "LICENSE"), "Apache License\nVersion 2.0\n");
  await write(path.join(tool, "SOURCE.md"), `# Source record\n\n- Upstream: \`https://github.com/acme/demo\`\n- Locked commit: \`${COMMIT}\`\n- License: Apache-2.0; see \`LICENSE\`\n- Included scope: \`source\`\n- Local modification: \`source/adapter.rs\` adds the project adapter.\n`);
  await write(path.join(tool, "source", "lib.rs"), "pub fn answer() -> u8 { 42 }\n");
  await write(path.join(tool, "source", "adapter.rs"), "pub fn adapt() {}\n");
  const digest = await treeHash(tool);
  const locks = {
    "tools/demo": {
      project: "acme/demo",
      upstream: "https://github.com/acme/demo",
      commit: COMMIT,
      license: "Apache-2.0",
      licenseMarker: "Apache License",
      includedScope: "source",
      localModifications: ["source/adapter.rs"],
      ...digest,
    },
  };
  return { root, tool, locks };
}

test("repository third-party register and SolverLab source lock pass", async () => {
  const result = await verifyThirdPartyLicenses({ root: REPOSITORY_ROOT });
  assert.equal(result.vendoredTools.length, 1);
  assert.equal(result.vendoredTools[0].project, "jsgrrchg/SolverLab");
});

test("a complete custom license and source lock passes", async () => {
  const { root, locks } = await fixture();
  const result = await verifyThirdPartyLicenses({ root, locks });
  assert.equal(result.vendoredTools[0].fileCount, 4);
});

test("vendored source modification fails the locked tree digest", async () => {
  const { root, tool, locks } = await fixture();
  await write(path.join(tool, "source", "lib.rs"), "pub fn answer() -> u8 { 7 }\n");
  await assert.rejects(verifyThirdPartyLicenses({ root, locks }), /source tree hash differs from source lock/);
});

test("an unregistered vendored directory fails closed", async () => {
  const { root } = await fixture();
  await write(path.join(root, "tools", "unknown", "source.js"), "export default 1;\n");
  await assert.rejects(verifyThirdPartyLicenses({ root, locks: {} }), /missing from THIRD_PARTY_LICENSES/);
});

test("package dependencies fail until a package license lock format exists", async () => {
  const { root, locks } = await fixture();
  await write(path.join(root, "package.json"), '{"name":"fixture","dependencies":{"left-pad":"1.3.0"}}\n');
  await assert.rejects(verifyThirdPartyLicenses({ root, locks }), /dependencies contains third-party packages/);
});
