#!/usr/bin/env node

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  compressedByteSizes,
  sha256Bytes,
  validateSeedArtifacts,
} from "./build-single.js";
import { verifyThirdPartyLicenses } from "./verify-licenses.js";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  const options = { root: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    invariant(key.startsWith("--"), `Unknown argument: ${key}`);
    const value = argv[index + 1];
    invariant(value && !value.startsWith("--"), `${key} requires a value`);
    options[key.slice(2)] = value;
    index += 1;
  }
  return options;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function nonNegativeFinite(value, label) {
  invariant(typeof value === "number" && Number.isFinite(value) && value >= 0, `${label} must be a non-negative finite number`);
  return value;
}

function nonNegativeInteger(value, label) {
  invariant(Number.isSafeInteger(value) && value >= 0, `${label} must be a non-negative safe integer`);
  return value;
}

function extractJsonScript(html, id) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<script\\b(?=[^>]*\\bid=["']${escapedId}["'])(?=[^>]*\\btype=["']application/json["'])[^>]*>([\\s\\S]*?)<\\/script>`, "i"));
  invariant(match, `Missing embedded JSON script #${id}`);
  return parseJson(match[1], `embedded #${id}`);
}

function decodeModuleDataUrl(url, id) {
  const match = url.match(/^data:text\/javascript;base64,([A-Za-z0-9+/=]+)$/);
  invariant(match, `Import map target for ${id} is not an embedded JavaScript data URL`);
  return Buffer.from(match[1], "base64").toString("utf8");
}

export function assertOfflineSource(source, label = "Source") {
  invariant(!/["'`]\s*(?:https?:|wss?:|\/\/)/i.test(source), `${label} contains a remote URL literal`);
  invariant(!/\bXMLHttpRequest\b/.test(source), `${label} contains XMLHttpRequest`);
  invariant(!/\bsendBeacon\s*\(/.test(source), `${label} contains sendBeacon`);
  invariant(!/\b(?:SharedWorker|Worker)\s*\(/.test(source), `${label} contains Worker or SharedWorker`);
  invariant(!/\bimportScripts\s*\(/.test(source), `${label} contains importScripts`);
  invariant(!/\b(?:WebSocket|EventSource)\s*\(/.test(source), `${label} contains WebSocket or EventSource`);

  for (const match of source.matchAll(/\bfetch\s*\(/g)) {
    const argument = source.slice(match.index + match[0].length);
    const literal = argument.match(/^\s*(["'])([^"']*)\1/);
    invariant(literal, `${label} contains fetch with a dynamic URL`);
    const url = literal[2].trim();
    invariant(!/^(?:https?:|wss?:|\/\/)/i.test(url), `${label} contains fetch with a remote URL`);
    invariant(!/^[a-z][a-z0-9+.-]*:/i.test(url) || /^(?:data:|blob:|app:)/i.test(url), `${label} contains fetch with a non-local URL scheme`);
  }
  for (const match of source.matchAll(/\bimport\s*\(/g)) {
    const argument = source.slice(match.index + match[0].length);
    const literal = argument.match(/^\s*(["'])([^"']*)\1/);
    invariant(literal, `${label} contains import() with a dynamic URL`);
    const url = literal[2].trim();
    invariant(!/^(?:https?:|wss?:|\/\/)/i.test(url), `${label} contains import() with a remote URL`);
    invariant(!/^[a-z][a-z0-9+.-]*:/i.test(url) || /^app:/i.test(url), `${label} contains import() with an unsupported URL scheme`);
  }
  return true;
}

function verifyNoExternalReferences(html, modules) {
  const attributePattern = /\b(?:src|href|poster|action)\s*=\s*["']\s*(https?:|wss?:|\/\/)/i;
  invariant(!attributePattern.test(html), "Distribution HTML contains an external resource attribute");
  invariant(!/<script\b[^>]*\bsrc\s*=/i.test(html), "Distribution HTML contains a script src");
  invariant(!/<link\b[^>]*\brel\s*=\s*["'][^"']*stylesheet/i.test(html), "Distribution HTML contains a stylesheet link");
  invariant(!/@import\s+/i.test(html), "Distribution HTML contains a CSS @import");
  invariant(!/url\(\s*["']?\s*(?:https?:|\/\/)/i.test(html), "Distribution HTML contains an external CSS URL");
  assertOfflineSource(html, "Distribution HTML");
  for (const [id, source] of modules) {
    invariant(!attributePattern.test(source), `${id} contains an external resource attribute`);
    assertOfflineSource(source, id);
  }
}

function verifyModuleGraph(imports, modules, html) {
  const bootstrap = [...html.matchAll(/<script\b(?=[^>]*\btype\s*=\s*["']module["'])[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .join("\n");
  invariant(bootstrap.trim().length > 0, "Distribution has no module bootstrap");
  const moduleSpecifierPattern = /\b(?:import|export)\s+(?:[^"'();]*?\s+from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  const roots = [...bootstrap.matchAll(moduleSpecifierPattern)].map((match) => match[1] ?? match[2]);
  invariant(roots.length > 0, "Module bootstrap imports no application entry");
  for (const root of roots) invariant(Object.hasOwn(imports, root), `Bootstrap references missing module ${root}`);
  for (const [id, source] of modules) {
    for (const match of source.matchAll(moduleSpecifierPattern)) {
      const dependency = match[1] ?? match[2];
      invariant(Object.hasOwn(imports, dependency), `${id} references missing bundled module ${dependency}`);
    }
  }
}

async function verifyJavaScriptSyntax(modules, scratchDirectory) {
  await mkdir(scratchDirectory, { recursive: true });
  try {
    let index = 0;
    for (const [id, source] of modules) {
      const file = path.join(scratchDirectory, `module-${index}.mjs`);
      await writeFile(file, source);
      const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      invariant(result.status === 0, `${id} fails JavaScript syntax validation: ${(result.stderr || result.stdout).trim()}`);
      index += 1;
    }
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true });
  }
}

export async function verifyDistribution(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  await verifyThirdPartyLicenses({ root });
  const htmlFile = path.resolve(root, options.html ?? "dist/index.html");
  const reportFile = path.resolve(root, options.report ?? "artifacts/build/build-report.json");
  const configFile = path.resolve(root, options.config ?? "src/config/seed-pool-config.json");
  const budgetFile = path.resolve(root, options.budget ?? "src/data/build-budget.json");
  const [html, reportText, configText, budgetText] = await Promise.all([
    readFile(htmlFile, "utf8"),
    readFile(reportFile, "utf8"),
    readFile(configFile, "utf8"),
    readFile(budgetFile, "utf8"),
  ]);
  const report = parseJson(reportText, "build report");
  const config = parseJson(configText, "SeedPoolConfig");
  const budget = parseJson(budgetText, "build budget");
  invariant(/^\s*<!doctype html>/i.test(html), "Distribution is missing an HTML doctype");
  invariant(/<html\b/i.test(html) && /<\/html\s*>/i.test(html), "Distribution has no complete html element");
  invariant(/<head\b/i.test(html) && /<body\b/i.test(html), "Distribution is missing head or body");

  const manifest = extractJsonScript(html, "spider-resolved-manifest");
  const payload = extractJsonScript(html, "spider-certified-seeds");
  const seedStats = validateSeedArtifacts(config, manifest, payload, { requirePublishable: true });
  const importMapMatch = html.match(/<script\b(?=[^>]*\btype\s*=\s*["']importmap["'])[^>]*>([\s\S]*?)<\/script>/i);
  invariant(importMapMatch, "Distribution is missing its import map");
  const importMap = parseJson(importMapMatch[1], "embedded import map");
  invariant(importMap && typeof importMap === "object" && importMap.imports && typeof importMap.imports === "object", "Import map has no imports object");
  const modules = new Map(Object.entries(importMap.imports).map(([id, url]) => [id, decodeModuleDataUrl(url, id)]));
  invariant(modules.size > 0, "Distribution contains no application modules");
  verifyNoExternalReferences(html, modules);
  verifyModuleGraph(importMap.imports, modules, html);
  await verifyJavaScriptSyntax(modules, path.join(path.dirname(htmlFile), `.verify-js-${process.pid}`));

  const htmlBytes = Buffer.byteLength(html, "utf8");
  const runtimeBytes = [...modules.values()].reduce((sum, source) => sum + Buffer.byteLength(source, "utf8"), 0);
  const canonicalManifest = canonicalJson(manifest);
  const canonicalPayload = canonicalJson(payload);
  const bundleCompression = compressedByteSizes(Buffer.from(html, "utf8"));
  const manifestCompression = compressedByteSizes(canonicalManifest);
  const payloadCompression = compressedByteSizes(canonicalPayload);
  const prototypeFile = path.resolve(root, report.prototypeArtifact ?? "prototype.html");
  let prototypeHtml = null;
  try { prototypeHtml = await readFile(prototypeFile, "utf8"); } catch {}
  const manifestBytes = manifestCompression.rawBytes;
  const payloadBytes = payloadCompression.rawBytes;
  invariant(report.schemaVersion === 1, "Unsupported build report schemaVersion");
  invariant(report.artifactSha256 === sha256Bytes(Buffer.from(html, "utf8")), "Distribution artifact hash does not match build report");
  if (prototypeHtml != null) {
    invariant(report.prototypeSha256 === sha256Bytes(Buffer.from(prototypeHtml, "utf8")), "Prototype artifact hash does not match build report");
    invariant(prototypeHtml === html, "Prototype artifact must match the verified distribution");
  }
  invariant(report.totalBundleBytes === htmlBytes, "Distribution byte size does not match build report");
  invariant(report.totalBundleGzipBytes === bundleCompression.gzipBytes, "Distribution gzip byte size does not match build report");
  invariant(report.totalBundleBrotliBytes === bundleCompression.brotliBytes, "Distribution Brotli byte size does not match build report");
  invariant(report.runtimeBytes === runtimeBytes, "Runtime byte size does not match build report");
  nonNegativeInteger(report.assetBytes, "assetBytes");
  invariant(report.moduleCount === modules.size, "Module count does not match build report");
  invariant(report.manifestBytes === manifestBytes, "Manifest byte size does not match build report");
  invariant(report.manifestGzipBytes === manifestCompression.gzipBytes, "Manifest gzip byte size does not match build report");
  invariant(report.manifestBrotliBytes === manifestCompression.brotliBytes, "Manifest Brotli byte size does not match build report");
  invariant(report.seedPayloadBytes === payloadBytes, "Payload byte size does not match build report");
  invariant(report.seedPayloadGzipBytes === payloadCompression.gzipBytes, "Payload gzip byte size does not match build report");
  invariant(report.seedPayloadBrotliBytes === payloadCompression.brotliBytes, "Payload Brotli byte size does not match build report");
  invariant(report.totalEncodedSeedBytes === seedStats.encodedTotal, "Encoded seed bytes do not match build report");
  invariant(report.totalEmbeddedCount === seedStats.embeddedTotal, "Embedded count does not match build report");
  invariant(report.encodedBytesPerSeed === (seedStats.embeddedTotal === 0 ? null : seedStats.encodedTotal / seedStats.embeddedTotal), "Average encoded bytes per seed do not match build report");
  for (const field of ["parseTimeMs", "startupTimeMs", "selectionLatencyMs"]) {
    const metric = report[field];
    if (metric == null) continue;
    invariant(metric && typeof metric === "object", `${field} must be an object or null`);
    nonNegativeFinite(metric.p50, `${field}.p50`);
    nonNegativeFinite(metric.p95, `${field}.p95`);
    invariant(metric.p50 <= metric.p95, `${field} percentiles are out of order`);
  }
  if (report.peakMemoryBytes != null) nonNegativeInteger(report.peakMemoryBytes, "peakMemoryBytes");
  invariant(report.performanceEvidence && typeof report.performanceEvidence === "object", "Build report is missing performanceEvidence");
  invariant(report.buckets && typeof report.buckets === "object" && !Array.isArray(report.buckets), "Build report buckets must be an object");
  invariant(Object.keys(report.buckets).length === Object.keys(manifest.buckets).length, "Build report bucket count does not match manifest");
  for (const [bucketId, bucket] of Object.entries(manifest.buckets)) {
    const reported = report.buckets[bucketId];
    invariant(reported && typeof reported === "object", `Build report is missing bucket ${bucketId}`);
    invariant(reported.enabled === bucket.enabled, `${bucketId} enabled state does not match build report`);
    invariant(reported.embeddedCount === bucket.embeddedCount, `${bucketId} embedded count does not match build report`);
    invariant(reported.encodedBytes === bucket.encodedBytes, `${bucketId} encoded bytes do not match build report`);
    invariant(
      reported.averageEncodedBytesPerSeed === (bucket.embeddedCount === 0 ? null : bucket.encodedBytes / bucket.embeddedCount),
      `${bucketId} average encoded bytes per seed do not match build report`,
    );
  }
  const benchmark = report.jsonParseBenchmark;
  invariant(benchmark && typeof benchmark === "object", "Build report is missing jsonParseBenchmark");
  invariant(benchmark.environment === "node-build-process", "JSON parse benchmark environment must be node-build-process");
  invariant(typeof benchmark.nodeVersion === "string" && /^v\d+/.test(benchmark.nodeVersion), "JSON parse benchmark is missing a Node version");
  invariant(benchmark.inputCount === 2, "JSON parse benchmark must cover manifest and payload");
  invariant(benchmark.inputBytes === manifestBytes + payloadBytes, "JSON parse benchmark input bytes do not match manifest and payload");
  nonNegativeInteger(benchmark.iterations, "jsonParseBenchmark.iterations");
  invariant(benchmark.iterations > 0, "jsonParseBenchmark.iterations must be positive");
  nonNegativeInteger(benchmark.warmupIterations, "jsonParseBenchmark.warmupIterations");
  nonNegativeInteger(benchmark.parsedValueCount, "jsonParseBenchmark.parsedValueCount");
  invariant(
    benchmark.parsedValueCount === (Object.keys(manifest).length + Object.keys(payload).length) * (benchmark.iterations + benchmark.warmupIterations),
    "JSON parse benchmark parsed value count does not match its inputs and iterations",
  );
  const parseP50 = nonNegativeFinite(benchmark.p50Ms, "jsonParseBenchmark.p50Ms");
  const parseP95 = nonNegativeFinite(benchmark.p95Ms, "jsonParseBenchmark.p95Ms");
  const parseMax = nonNegativeFinite(benchmark.maxMs, "jsonParseBenchmark.maxMs");
  invariant(parseP50 <= parseP95 && parseP95 <= parseMax, "JSON parse benchmark percentiles are out of order");
  const memory = report.buildProcessMemory;
  invariant(memory && typeof memory === "object", "Build report is missing buildProcessMemory");
  invariant(memory.environment === "node-build-process", "Build process memory environment must be node-build-process");
  for (const field of ["peakResidentSetBytes", "rssBytes", "heapTotalBytes", "heapUsedBytes", "externalBytes", "arrayBuffersBytes"]) {
    nonNegativeInteger(memory[field], `buildProcessMemory.${field}`);
  }
  invariant(memory.peakResidentSetBytes >= memory.rssBytes, "Peak resident set bytes cannot be below the current RSS snapshot");
  invariant(report.configHash === manifest.configHash, "Config hash does not match build report");
  invariant(report.payloadHash === manifest.payloadHash, "Payload hash does not match build report");
  invariant(report.libraryHash === manifest.libraryHash, "Library hash does not match build report");
  invariant(htmlBytes <= budget.maximumBundleBytes, "Distribution exceeds maximumBundleBytes");
  invariant(runtimeBytes <= budget.maximumRuntimeSourceBytes, "Distribution exceeds maximumRuntimeSourceBytes");
  invariant(report.assetBytes <= budget.maximumAssetBytes, "Distribution exceeds maximumAssetBytes");
  invariant(manifestBytes <= budget.maximumManifestBytes, "Distribution exceeds maximumManifestBytes");
  invariant(seedStats.embeddedTotal <= config.maximumEmbeddedCount, "Distribution exceeds maximumEmbeddedCount");
  invariant(seedStats.encodedTotal <= config.maximumEmbeddedBytes, "Distribution exceeds maximumEmbeddedBytes");
  return {
    artifactSha256: report.artifactSha256,
    totalBundleBytes: htmlBytes,
    moduleCount: modules.size,
    totalEmbeddedCount: seedStats.embeddedTotal,
  };
}

async function main() {
  try {
    const result = await verifyDistribution(parseArgs(process.argv.slice(2)));
    process.stdout.write(`Verified dist/index.html (${result.totalBundleBytes} bytes, ${result.moduleCount} modules, ${result.totalEmbeddedCount} certified deals)\n`);
  } catch (error) {
    process.stderr.write(`Distribution verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
