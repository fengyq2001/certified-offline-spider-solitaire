#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export const DEFAULT_SOURCE_LOCKS = Object.freeze({
  "tools/solverlab": Object.freeze({
    project: "jsgrrchg/SolverLab",
    upstream: "https://github.com/jsgrrchg/SolverLab",
    commit: "cc21d7e9345cce0506fad5c64ddfe7f833f0c51f",
    license: "Apache-2.0",
    licenseMarker: "Apache License",
    includedScope: "solver-core-rs",
    localModifications: Object.freeze(["solver-core-rs/src/bin/spider_cli.rs"]),
    fileCount: 39,
    treeSha256: "5340a91e1c2b2d9ba66dcc24f50234dd0c7a14fa18eea819b6bdb4d1ff7e7b0f",
  }),
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function readableFile(file, label) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} is missing: ${file}`);
    throw error;
  }
  invariant(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular file: ${file}`);
  const contents = await readFile(file, "utf8");
  invariant(contents.trim().length > 0, `${label} must not be empty: ${file}`);
  return contents;
}

async function directoriesAt(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function lockedFiles(directory, base = directory) {
  const result = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const file = path.join(directory, entry.name);
    invariant(!entry.isSymbolicLink(), `Vendored source locks do not allow symbolic links: ${file}`);
    if (entry.isDirectory()) result.push(...await lockedFiles(file, base));
    else if (entry.isFile()) result.push(path.relative(base, file).split(path.sep).join("/"));
    else throw new Error(`Unsupported vendored source entry: ${file}`);
  }
  return result;
}

async function sourceTreeDigest(directory) {
  const files = (await lockedFiles(directory)).sort();
  const treeHash = createHash("sha256");
  for (const relative of files) {
    const bytes = await readFile(path.join(directory, relative));
    const fileHash = createHash("sha256").update(bytes).digest("hex");
    treeHash.update(`${relative}\0${fileHash}\n`, "utf8");
  }
  return { files, treeSha256: treeHash.digest("hex") };
}

function sourceField(sourceRecord, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return sourceRecord.match(new RegExp(`^- ${escaped}:\\s*(?:\`([^\`]+)\`|([^\\n]+))\\s*$`, "mi"))?.slice(1).find(Boolean)?.trim();
}

function registeredToolPaths(register) {
  return new Set([...register.matchAll(/`(tools\/[a-z0-9._-]+)(?:\/[^`]*)?`/gi)].map((match) => match[1]));
}

function assertNoUnregisteredPackageDependencies(packageJson) {
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bundledDependencies"]) {
    const dependencies = packageJson[field];
    if (dependencies == null) continue;
    const count = Array.isArray(dependencies) ? dependencies.length : Object.keys(dependencies).length;
    invariant(count === 0, `package.json ${field} contains third-party packages but no package license lock format is defined`);
  }
}

export async function verifyThirdPartyLicenses(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const locks = options.locks ?? DEFAULT_SOURCE_LOCKS;
  const registerFile = path.resolve(root, options.register ?? "THIRD_PARTY_LICENSES.md");
  const packageFile = path.resolve(root, options.package ?? "package.json");
  const [register, packageText] = await Promise.all([
    readableFile(registerFile, "Third-party license register"),
    readableFile(packageFile, "package.json"),
  ]);
  let packageJson;
  try {
    packageJson = JSON.parse(packageText);
  } catch (error) {
    throw new Error(`package.json is invalid: ${error.message}`);
  }
  assertNoUnregisteredPackageDependencies(packageJson);
  invariant(!/\b(?:TODO|TBD|UNKNOWN)\b/i.test(register), "Third-party license register contains unresolved placeholders");

  const actualTools = (await directoriesAt(path.join(root, "tools"))).map((name) => `tools/${name}`);
  const declaredTools = registeredToolPaths(register);
  for (const toolPath of actualTools) invariant(declaredTools.has(toolPath), `Vendored tool is missing from THIRD_PARTY_LICENSES.md: ${toolPath}`);
  for (const toolPath of declaredTools) invariant(actualTools.includes(toolPath), `THIRD_PARTY_LICENSES.md declares a missing vendored tool: ${toolPath}`);

  const verified = [];
  for (const toolPath of actualTools) {
    const lock = locks[toolPath];
    invariant(lock, `Vendored tool has no machine-enforced source lock: ${toolPath}`);
    invariant(COMMIT_PATTERN.test(lock.commit), `Source lock commit is not a full lowercase Git SHA: ${toolPath}`);
    invariant(/^[0-9a-f]{64}$/.test(lock.treeSha256), `Source lock treeSha256 is invalid: ${toolPath}`);
    const directory = path.join(root, toolPath);
    const [sourceRecord, licenseText] = await Promise.all([
      readableFile(path.join(directory, "SOURCE.md"), `${toolPath} source record`),
      readableFile(path.join(directory, "LICENSE"), `${toolPath} license text`),
    ]);
    invariant(sourceField(sourceRecord, "Upstream") === lock.upstream, `${toolPath} upstream does not match its source lock`);
    invariant(sourceField(sourceRecord, "Locked commit") === lock.commit, `${toolPath} commit does not match its source lock`);
    invariant(sourceField(sourceRecord, "License")?.startsWith(lock.license), `${toolPath} license id does not match its source lock`);
    invariant(sourceField(sourceRecord, "Included scope") === lock.includedScope, `${toolPath} included scope does not match its source lock`);
    invariant(licenseText.includes(lock.licenseMarker), `${toolPath} LICENSE does not contain the expected ${lock.license} text`);
    invariant(register.includes(lock.project), `${toolPath} project is missing from THIRD_PARTY_LICENSES.md`);
    invariant(register.includes(lock.commit), `${toolPath} locked commit is missing from THIRD_PARTY_LICENSES.md`);
    invariant(register.includes(lock.license), `${toolPath} license id is missing from THIRD_PARTY_LICENSES.md`);
    for (const modifiedFile of lock.localModifications) {
      invariant(sourceRecord.includes(modifiedFile), `${toolPath} source record omits local modification ${modifiedFile}`);
      await readableFile(path.join(directory, modifiedFile), `${toolPath} locally modified file`);
    }
    const tree = await sourceTreeDigest(directory);
    invariant(tree.files.length === lock.fileCount, `${toolPath} file count differs from source lock`);
    invariant(tree.treeSha256 === lock.treeSha256, `${toolPath} source tree hash differs from source lock`);
    verified.push({ toolPath, project: lock.project, commit: lock.commit, license: lock.license, fileCount: tree.files.length, treeSha256: tree.treeSha256 });
  }
  return { register: path.relative(root, registerFile), vendoredTools: verified };
}

async function main() {
  try {
    const result = await verifyThirdPartyLicenses({ root: process.cwd() });
    process.stdout.write(`Verified third-party licenses and source locks (${result.vendoredTools.length} vendored tool${result.vendoredTools.length === 1 ? "" : "s"})\n`);
  } catch (error) {
    process.stderr.write(`License verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
