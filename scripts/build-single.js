#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rm,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from "node:zlib";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SEED_PATTERN = /^u64:[0-9a-f]{16}$/;
const DIFFICULTIES = new Set(["easy", "medium", "hard", "demon"]);
const SUIT_MODES = new Set([1, 2, 4]);

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("Canonical JSON cannot encode a non-finite number");
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("Canonical JSON cannot encode undefined");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function compressedByteSizes(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return {
    rawBytes: bytes.byteLength,
    gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
    brotliBytes: brotliCompressSync(bytes, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength,
  };
}

function percentile(sortedSamples, quantile) {
  if (sortedSamples.length === 0) return 0;
  return sortedSamples[Math.ceil(sortedSamples.length * quantile) - 1] ?? sortedSamples[0];
}

export function benchmarkJsonParse(jsonTexts, { iterations = 25, warmupIterations = 5 } = {}) {
  invariant(Array.isArray(jsonTexts) && jsonTexts.length > 0, "JSON parse benchmark needs at least one input");
  invariant(Number.isSafeInteger(iterations) && iterations > 0, "JSON parse benchmark iterations must be positive");
  invariant(Number.isSafeInteger(warmupIterations) && warmupIterations >= 0, "JSON parse benchmark warmupIterations must be non-negative");
  for (const text of jsonTexts) invariant(typeof text === "string", "JSON parse benchmark inputs must be strings");
  const parseAll = () => {
    let parsedValueCount = 0;
    for (const text of jsonTexts) {
      const value = JSON.parse(text);
      parsedValueCount += value !== null && typeof value === "object" ? Object.keys(value).length : 1;
    }
    return parsedValueCount;
  };
  let parsedValueCount = 0;
  for (let index = 0; index < warmupIterations; index += 1) parsedValueCount += parseAll();
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    parsedValueCount += parseAll();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  const rounded = (value) => Number(value.toFixed(6));
  return {
    environment: "node-build-process",
    nodeVersion: process.version,
    inputCount: jsonTexts.length,
    inputBytes: jsonTexts.reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0),
    iterations,
    warmupIterations,
    p50Ms: rounded(percentile(samples, 0.5)),
    p95Ms: rounded(percentile(samples, 0.95)),
    maxMs: rounded(samples.at(-1) ?? 0),
    parsedValueCount,
  };
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function assertPlainObject(value, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
}

function assertNonNegativeInteger(value, label) {
  invariant(Number.isSafeInteger(value) && value >= 0, `${label} must be a non-negative safe integer`);
}

function assertHash(value, label) {
  invariant(typeof value === "string" && HASH_PATTERN.test(value), `${label} must be a lowercase SHA-256 hex digest`);
}

export function validateSeedPoolConfig(config) {
  assertPlainObject(config, "SeedPoolConfig");
  assertNonNegativeInteger(config.configVersion, "configVersion");
  invariant(config.configVersion > 0, "configVersion must be positive");
  invariant(typeof config.ruleVersion === "string" && config.ruleVersion.length > 0, "ruleVersion is required");
  invariant(typeof config.generatorVersion === "string" && config.generatorVersion.length > 0, "generatorVersion is required");
  assertPlainObject(config.buckets, "buckets");
  const bucketIds = Object.keys(config.buckets);
  invariant(bucketIds.length > 0, "SeedPoolConfig must declare at least one bucket");

  let targetTotal = 0;
  for (const bucketId of bucketIds) {
    const bucket = config.buckets[bucketId];
    assertPlainObject(bucket, `buckets.${bucketId}`);
    invariant(/^[124]s\.(easy|medium|hard|demon)$/.test(bucketId), `Unsupported bucket id: ${bucketId}`);
    invariant(typeof bucket.enabled === "boolean", `${bucketId}.enabled must be boolean`);
    invariant(typeof bucket.allowEmptyBucket === "boolean", `${bucketId}.allowEmptyBucket must be boolean`);
    for (const key of ["candidateScanBudget", "certifiedTarget", "embeddedTarget", "minimumPublishableCount"]) {
      assertNonNegativeInteger(bucket[key], `${bucketId}.${key}`);
    }
    invariant(
      bucket.minimumPublishableCount <= bucket.embeddedTarget && bucket.embeddedTarget <= bucket.certifiedTarget,
      `${bucketId} must satisfy minimumPublishableCount <= embeddedTarget <= certifiedTarget`,
    );
    if (!bucket.enabled) {
      invariant(
        bucket.certifiedTarget === 0 && bucket.embeddedTarget === 0 && bucket.minimumPublishableCount === 0,
        `${bucketId} is disabled but has a non-zero target or minimum`,
      );
    } else {
      targetTotal += bucket.embeddedTarget;
    }
  }
  assertNonNegativeInteger(config.maximumEmbeddedCount, "maximumEmbeddedCount");
  assertNonNegativeInteger(config.maximumEmbeddedBytes, "maximumEmbeddedBytes");
  invariant(targetTotal <= config.maximumEmbeddedCount, "Enabled embedded targets exceed maximumEmbeddedCount");
  return true;
}

function normalizedDeal(deal) {
  return {
    dealId: deal.dealId,
    canonicalSeed: deal.canonicalSeed,
    initialDealHash: deal.initialDealHash,
    suitMode: deal.suitMode,
    difficulty: deal.difficulty,
    status: deal.status,
  };
}

const RUNTIME_DEAL_KEYS = Object.freeze([
  "canonicalSeed", "dealId", "difficulty", "initialDealHash", "status", "suitMode",
]);

function entryEncodedBytes(deal) {
  return Buffer.byteLength(canonicalJson(normalizedDeal(deal)), "utf8");
}

export function validateSeedArtifacts(config, manifest, payload, { requirePublishable = true } = {}) {
  validateSeedPoolConfig(config);
  assertPlainObject(manifest, "resolved manifest");
  assertPlainObject(payload, "certified payload");
  invariant(manifest.schemaVersion === 1, "Unsupported manifest schemaVersion");
  invariant(manifest.payloadSchemaVersion === 1, "Unsupported manifest payloadSchemaVersion");
  invariant(payload.payloadSchemaVersion === 1, "Unsupported payloadSchemaVersion");
  invariant(manifest.configVersion === config.configVersion, "Manifest configVersion does not match config");
  invariant(typeof manifest.createdAt === "string" && Number.isFinite(Date.parse(manifest.createdAt)), "Manifest createdAt must be an ISO timestamp");
  assertHash(manifest.solverConfigHash, "solverConfigHash");
  assertHash(manifest.calibrationDatasetHash, "calibrationDatasetHash");
  assertHash(manifest.classificationCatalogHash, "classificationCatalogHash");
  invariant(manifest.seedLibraryVersion === payload.seedLibraryVersion, "Seed library versions do not match");
  invariant(manifest.ruleVersion === config.ruleVersion, "Manifest ruleVersion does not match config");
  invariant(manifest.generatorVersion === config.generatorVersion, "Manifest generatorVersion does not match config");
  invariant(manifest.maximumEmbeddedCount === config.maximumEmbeddedCount, "Manifest maximumEmbeddedCount does not match config");
  invariant(manifest.maximumEmbeddedBytes === config.maximumEmbeddedBytes, "Manifest maximumEmbeddedBytes does not match config");
  assertHash(manifest.configHash, "configHash");
  assertHash(manifest.payloadHash, "payloadHash");
  assertHash(manifest.libraryHash, "libraryHash");
  assertHash(manifest.certificateCatalogHash, "certificateCatalogHash");
  invariant(manifest.configHash === sha256Canonical(config), "SeedPoolConfig hash mismatch");
  invariant(manifest.payloadHash === sha256Canonical(payload), "Certified payload hash mismatch");
  invariant(Array.isArray(payload.deals), "payload.deals must be an array");
  invariant(manifest.libraryHash === sha256Canonical(payload.deals.map(normalizedDeal)), "Seed library hash mismatch");
  if (manifest.deals != null) {
    invariant(Array.isArray(manifest.deals), "manifest.deals must be an array when present");
    invariant(canonicalJson(manifest.deals) === canonicalJson(payload.deals.map(normalizedDeal)), "Manifest deal index does not match payload deals");
  }
  assertPlainObject(manifest.buckets, "manifest.buckets");
  assertPlainObject(manifest.payloadIndex, "manifest.payloadIndex");

  const seenDealIds = new Set();
  const seenSeeds = new Set();
  const seenDealHashes = new Set();
  const dealsByBucket = new Map(Object.keys(config.buckets).map((bucketId) => [bucketId, []]));
  for (const [index, deal] of payload.deals.entries()) {
    assertPlainObject(deal, `payload.deals[${index}]`);
    invariant(Object.keys(deal).sort().join(",") === RUNTIME_DEAL_KEYS.join(","), `Runtime deal ${index} contains development-only or unknown fields`);
    invariant(typeof deal.dealId === "string" && HASH_PATTERN.test(deal.dealId), `Invalid dealId at payload index ${index}`);
    invariant(typeof deal.initialDealHash === "string" && HASH_PATTERN.test(deal.initialDealHash), `Invalid initialDealHash at payload index ${index}`);
    invariant(typeof deal.canonicalSeed === "string" && SEED_PATTERN.test(deal.canonicalSeed), `Invalid canonicalSeed at payload index ${index}`);
    invariant(SUIT_MODES.has(deal.suitMode), `Invalid suitMode at payload index ${index}`);
    invariant(DIFFICULTIES.has(deal.difficulty), `Invalid difficulty at payload index ${index}`);
    invariant(deal.status === "active", `Only active certified deals may enter the runtime payload (index ${index})`);
    invariant(!seenDealIds.has(deal.dealId), `Duplicate dealId: ${deal.dealId}`);
    const seedKey = `${deal.suitMode}:${deal.canonicalSeed}`;
    invariant(!seenSeeds.has(seedKey), `Duplicate canonical seed within suit mode: ${seedKey}`);
    invariant(!seenDealHashes.has(deal.initialDealHash), `Duplicate initial deal content: ${deal.initialDealHash}`);
    seenDealIds.add(deal.dealId);
    seenSeeds.add(seedKey);
    seenDealHashes.add(deal.initialDealHash);
    const bucketId = `${deal.suitMode}s.${deal.difficulty}`;
    invariant(dealsByBucket.has(bucketId), `Payload deal references undeclared bucket ${bucketId}`);
    dealsByBucket.get(bucketId).push({ deal, index });
  }

  let expectedOffset = 0;
  let embeddedTotal = 0;
  let encodedTotal = 0;
  for (const bucketId of Object.keys(config.buckets)) {
    const sourceBucket = config.buckets[bucketId];
    const resolved = manifest.buckets[bucketId];
    const indexEntry = manifest.payloadIndex[bucketId];
    assertPlainObject(resolved, `manifest.buckets.${bucketId}`);
    assertPlainObject(indexEntry, `manifest.payloadIndex.${bucketId}`);
    invariant(resolved.enabled === sourceBucket.enabled, `${bucketId}.enabled does not match config`);
    invariant(resolved.allowEmptyBucket === sourceBucket.allowEmptyBucket, `${bucketId}.allowEmptyBucket does not match config`);
    for (const key of ["candidateScanBudget", "certifiedTarget", "embeddedTarget", "minimumPublishableCount"]) {
      invariant(resolved[key] === sourceBucket[key], `${bucketId}.${key} does not match config`);
    }
    for (const key of ["candidatesScanned", "rawCertifiedCount", "actualCount", "embeddedCount", "encodedBytes"]) {
      assertNonNegativeInteger(resolved[key], `${bucketId}.${key}`);
    }
    invariant(resolved.rawCertifiedCount >= resolved.actualCount, `${bucketId}.rawCertifiedCount is below actualCount`);
    invariant(resolved.actualCount >= resolved.embeddedCount, `${bucketId}.actualCount is below embeddedCount`);
    invariant(resolved.embeddedCount <= sourceBucket.embeddedTarget, `${bucketId}.embeddedCount exceeds embeddedTarget`);

    const entries = dealsByBucket.get(bucketId);
    const encodedBytes = entries.reduce((sum, { deal }) => sum + entryEncodedBytes(deal), 0);
    invariant(resolved.embeddedCount === entries.length, `${bucketId}.embeddedCount does not match payload`);
    invariant(resolved.encodedBytes === encodedBytes, `${bucketId}.encodedBytes does not match payload`);
    invariant(indexEntry.startOffset === expectedOffset, `${bucketId}.startOffset is not contiguous`);
    invariant(indexEntry.entryCount === entries.length, `${bucketId}.entryCount does not match payload`);
    for (let localIndex = 0; localIndex < entries.length; localIndex += 1) {
      invariant(entries[localIndex].index === expectedOffset + localIndex, `${bucketId} payload entries are not contiguous`);
    }
    if (!sourceBucket.enabled) invariant(entries.length === 0, `${bucketId} is disabled but contains payload entries`);
    if (requirePublishable && sourceBucket.enabled) {
      const publishable = entries.length === 0
        ? sourceBucket.allowEmptyBucket
        : entries.length >= sourceBucket.minimumPublishableCount;
      invariant(publishable, `${bucketId} fails the publishable bucket predicate`);
    }
    expectedOffset += entries.length;
    embeddedTotal += entries.length;
    encodedTotal += encodedBytes;
  }

  invariant(Object.keys(manifest.buckets).length === Object.keys(config.buckets).length, "Manifest contains undeclared buckets");
  invariant(Object.keys(manifest.payloadIndex).length === Object.keys(config.buckets).length, "Payload index contains undeclared buckets");
  assertNonNegativeInteger(manifest.totalEmbeddedCount, "totalEmbeddedCount");
  assertNonNegativeInteger(manifest.totalEncodedBytes, "totalEncodedBytes");
  invariant(manifest.totalEmbeddedCount === embeddedTotal, "totalEmbeddedCount does not equal the bucket sum");
  invariant(manifest.totalEncodedBytes === encodedTotal, "totalEncodedBytes does not equal the bucket sum");
  invariant(embeddedTotal === payload.deals.length, "Payload contains unindexed deals");
  invariant(embeddedTotal <= config.maximumEmbeddedCount, "Payload exceeds maximumEmbeddedCount");
  invariant(encodedTotal <= config.maximumEmbeddedBytes, "Payload exceeds maximumEmbeddedBytes");
  return { embeddedTotal, encodedTotal };
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

async function loadJson(file, label) {
  return parseJson(await readFile(file, "utf8"), label);
}

function mimeType(file) {
  const extension = path.extname(file).toLowerCase();
  return ({
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".wav": "audio/wav",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  })[extension] ?? "application/octet-stream";
}

function isRemoteSpecifier(value) {
  return /^(?:https?:|wss?:|\/\/|data:|blob:)/i.test(value);
}

function assertNoNetworkSource(text, label) {
  const prohibited = [
    /\b(?:src|href|poster|action)\s*=\s*["']\s*(?:https?:|wss?:|\/\/)/i,
    /\b(?:fetch|importScripts)\s*\(\s*["']\s*(?:https?:|\/\/)/i,
    /\bnew\s+(?:WebSocket|EventSource)\s*\(\s*["']\s*(?:wss?:|https?:|\/\/)/i,
    /@import\s+/i,
  ];
  invariant(!prohibited.some((pattern) => pattern.test(text)), `${label} contains a network or imported resource reference`);
}

async function existingResolvedFile(baseFile, specifier, sourceRoot) {
  invariant(!isRemoteSpecifier(specifier), `External module specifier is forbidden: ${specifier}`);
  invariant(specifier.startsWith(".") || specifier.startsWith("/"), `Bare module specifier is forbidden: ${specifier}`);
  const candidate = specifier.startsWith("/")
    ? path.resolve(sourceRoot, `.${specifier}`)
    : path.resolve(path.dirname(baseFile), specifier);
  const attempts = [candidate, `${candidate}.js`, `${candidate}.mjs`, `${candidate}.json`, path.join(candidate, "index.js")];
  for (const attempt of attempts) {
    try {
      const info = await stat(attempt);
      if (info.isFile()) return attempt;
    } catch {
      // Try the next supported resolution form.
    }
  }
  throw new Error(`Cannot resolve ${specifier} imported by ${baseFile}`);
}

function virtualId(file, sourceRoot) {
  const relative = path.relative(sourceRoot, file).split(path.sep).join("/");
  invariant(relative && !relative.startsWith("../"), `Module escapes source root: ${file}`);
  return `app:/${relative}`;
}

async function assertInsideRoot(file, root, label) {
  const [realFile, realRoot] = await Promise.all([realpath(file), realpath(root)]);
  invariant(realFile === realRoot || realFile.startsWith(`${realRoot}${path.sep}`), `${label} escapes its allowed root`);
  return realFile;
}

async function collectModules(entryFiles, sourceRoot) {
  const modules = new Map();
  const pending = [...entryFiles];
  const literalSpecifierPattern = /\b(?:import|export)\s+(?:[^"'();]*?\s+from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

  while (pending.length) {
    const file = path.resolve(pending.pop());
    if (modules.has(file)) continue;
    await assertInsideRoot(file, sourceRoot, "Module");
    const extension = path.extname(file).toLowerCase();
    if (extension === ".json") {
      const json = parseJson(await readFile(file, "utf8"), file);
      modules.set(file, `const value=${canonicalJson(json)};\nexport default value;\n`);
      continue;
    }
    invariant(extension === ".js" || extension === ".mjs", `Unsupported module type: ${file}`);
    let source = await readFile(file, "utf8");
    assertNoNetworkSource(source, file);
    const replacements = [];
    for (const match of source.matchAll(literalSpecifierPattern)) {
      const specifier = match[1] ?? match[2];
      const imported = await existingResolvedFile(file, specifier, sourceRoot);
      await assertInsideRoot(imported, sourceRoot, "Imported module");
      pending.push(imported);
      const relativeStart = match.index + match[0].indexOf(specifier);
      replacements.push({ start: relativeStart, end: relativeStart + specifier.length, value: virtualId(imported, sourceRoot) });
    }
    for (const replacement of replacements.reverse()) {
      source = `${source.slice(0, replacement.start)}${replacement.value}${source.slice(replacement.end)}`;
    }
    // JSON is represented as a JavaScript module in the single-file bundle.
    source = source.replace(/\s+(?:with|assert)\s*\{\s*type\s*:\s*["']json["']\s*\}/g, "");
    modules.set(file, source);
  }
  return modules;
}

async function inlineCss(cssFile, sourceRoot) {
  await assertInsideRoot(cssFile, sourceRoot, "Stylesheet");
  let css = await readFile(cssFile, "utf8");
  let assetBytes = 0;
  assertNoNetworkSource(css, cssFile);
  const matches = [...css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)];
  for (const match of matches.reverse()) {
    const reference = match[2].trim();
    if (reference.startsWith("#") || reference.startsWith("data:")) continue;
    invariant(!isRemoteSpecifier(reference), `External CSS asset is forbidden: ${reference}`);
    const asset = path.resolve(path.dirname(cssFile), reference);
    await assertInsideRoot(asset, sourceRoot, "CSS asset");
    const bytes = await readFile(asset);
    assetBytes += bytes.byteLength;
    const dataUrl = `data:${mimeType(asset)};base64,${bytes.toString("base64")}`;
    css = `${css.slice(0, match.index)}url("${dataUrl}")${css.slice(match.index + match[0].length)}`;
  }
  return { css, assetBytes };
}

async function inlineStylesheets(html, htmlFile, sourceRoot) {
  let assetBytes = 0;
  const links = [...html.matchAll(/<link\b[^>]*>/gi)];
  for (const match of links.reverse()) {
    const tag = match[0];
    if (!/\brel\s*=\s*["'][^"']*stylesheet/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    invariant(href, "Stylesheet link is missing href");
    invariant(!isRemoteSpecifier(href), `External stylesheet is forbidden: ${href}`);
    const file = await existingResolvedFile(htmlFile, href, sourceRoot);
    const inlined = await inlineCss(file, sourceRoot);
    const css = inlined.css;
    assetBytes += inlined.assetBytes;
    html = `${html.slice(0, match.index)}<style data-bundled-from="${escapeHtml(path.relative(sourceRoot, file))}">\n${css}\n</style>${html.slice(match.index + tag.length)}`;
  }
  return { html, assetBytes };
}

async function inlineHtmlAssets(html, htmlFile, sourceRoot) {
  let assetBytes = 0;
  const attributes = [...html.matchAll(/\b(src|poster)\s*=\s*(["'])([^"']+)\2/gi)];
  for (const match of attributes.reverse()) {
    const reference = match[3].trim();
    if (reference.startsWith("data:") || reference.startsWith("#")) continue;
    invariant(!isRemoteSpecifier(reference), `External HTML asset is forbidden: ${reference}`);
    const asset = path.resolve(path.dirname(htmlFile), reference);
    await assertInsideRoot(asset, sourceRoot, "HTML asset");
    const bytes = await readFile(asset);
    assetBytes += bytes.byteLength;
    const replacement = `${match[1]}=${match[2]}data:${mimeType(asset)};base64,${bytes.toString("base64")}${match[2]}`;
    html = `${html.slice(0, match.index)}${replacement}${html.slice(match.index + match[0].length)}`;
  }
  return { html, assetBytes };
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function jsonScript(value) {
  return JSON.stringify(value).replaceAll("</script", "<\\/script").replaceAll("<!--", "<\\!--");
}

async function bundleHtml({ htmlFile, sourceRoot, manifest, payload }) {
  let html = await readFile(htmlFile, "utf8");
  assertNoNetworkSource(html, htmlFile);
  const styles = await inlineStylesheets(html, htmlFile, sourceRoot);
  html = styles.html;
  let assetBytes = styles.assetBytes;

  const moduleTags = [...html.matchAll(/<script\b(?=[^>]*\btype\s*=\s*["']module["'])(?=[^>]*\bsrc\s*=\s*["']([^"']+)["'])[^>]*>\s*<\/script>/gi)];
  invariant(moduleTags.length > 0, "Source HTML must have at least one external module entry script");
  const entryFiles = [];
  for (const match of moduleTags.reverse()) {
    const specifier = match[1];
    const entry = await existingResolvedFile(htmlFile, specifier, sourceRoot);
    entryFiles.unshift(entry);
    html = `${html.slice(0, match.index)}${html.slice(match.index + match[0].length)}`;
  }
  invariant(!/<script\b[^>]*\bsrc\s*=/i.test(html), "Non-module external scripts are unsupported; inline or convert them to modules");
  const htmlAssets = await inlineHtmlAssets(html, htmlFile, sourceRoot);
  html = htmlAssets.html;
  assetBytes += htmlAssets.assetBytes;

  const modules = await collectModules(entryFiles, sourceRoot);
  const imports = {};
  let runtimeBytes = 0;
  for (const [file, source] of [...modules.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    runtimeBytes += Buffer.byteLength(source, "utf8");
    imports[virtualId(file, sourceRoot)] = `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
  }
  const bootstrap = entryFiles.map((entry) => `import ${JSON.stringify(virtualId(entry, sourceRoot))};`).join("\n");
  const injected = [
    `<script id="spider-resolved-manifest" type="application/json">${jsonScript(manifest)}</script>`,
    `<script id="spider-certified-seeds" type="application/json">${jsonScript(payload)}</script>`,
    `<script type="importmap">${jsonScript({ imports })}</script>`,
    `<script type="module">\n${bootstrap}\n</script>`,
  ].join("\n    ");
  invariant(/<\/body\s*>/i.test(html), "Source HTML is missing </body>");
  html = html.replace(/<\/body\s*>/i, `    ${injected}\n  </body>`);
  assertNoNetworkSource(html, "Bundled HTML");
  return { html, runtimeBytes, assetBytes, moduleCount: modules.size };
}

async function atomicWrite(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, contents);
  await rename(temporary, file);
}

async function loadRuntimePerformanceEvidence(root, expectedLibraryHash, fileName = "artifacts/performance/runtime-performance.json") {
  try {
    const report = JSON.parse(await readFile(path.resolve(root, fileName), "utf8"));
    const metrics = report?.metrics;
    if (report?.result !== "PASS" || report?.environment?.kind !== "node-runtime-proxy" || report?.inputs?.libraryHash !== expectedLibraryHash || !metrics) return null;
    return {
      source: path.relative(root, path.resolve(root, fileName)).split(path.sep).join("/"),
      environment: report.environment.kind,
      parseTimeMs: { p50: metrics.manifestPayloadParseMs.p50, p95: metrics.manifestPayloadParseMs.p95 },
      startupTimeMs: { p50: metrics.startupProxyMs.p50, p95: metrics.startupProxyMs.p95 },
      selectionLatencyMs: { p50: metrics.seedSelectionMs.p50, p95: metrics.seedSelectionMs.p95 },
      peakMemoryBytes: metrics.memory.nodePeakResidentSetBytes,
    };
  } catch {
    return null;
  }
}

export async function buildSingle(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const sourceRoot = path.resolve(root, options["source-root"] ?? "src");
  const htmlFile = path.resolve(root, options.input ?? "src/index.html");
  const outFile = path.resolve(root, options.out ?? "dist/index.html");
  const prototypeFile = path.resolve(root, options.prototype ?? "prototype.html");
  const reportFile = path.resolve(root, options.report ?? "artifacts/build/build-report.json");
  const configFile = path.resolve(root, options.config ?? "src/config/seed-pool-config.json");
  const manifestFile = path.resolve(root, options.manifest ?? "src/data/resolved-seed-manifest.json");
  const payloadFile = path.resolve(root, options.payload ?? "src/data/certified-seeds.json");
  const budgetFile = path.resolve(root, options.budget ?? "src/data/build-budget.json");
  const [config, manifest, payload, budget] = await Promise.all([
    loadJson(configFile, "SeedPoolConfig"),
    loadJson(manifestFile, "resolved seed manifest"),
    loadJson(payloadFile, "certified seed payload"),
    loadJson(budgetFile, "build budget"),
  ]);
  const seedStats = validateSeedArtifacts(config, manifest, payload, { requirePublishable: true });
  assertPlainObject(budget, "build budget");
  invariant(budget.schemaVersion === 1, "Unsupported build budget schemaVersion");
  assertNonNegativeInteger(budget.maximumBundleBytes, "maximumBundleBytes");
  assertNonNegativeInteger(budget.maximumRuntimeSourceBytes, "maximumRuntimeSourceBytes");
  assertNonNegativeInteger(budget.maximumAssetBytes, "maximumAssetBytes");
  assertNonNegativeInteger(budget.maximumManifestBytes, "maximumManifestBytes");

  const embeddedManifest = { ...manifest };
  delete embeddedManifest.deals;
  const { html, runtimeBytes, assetBytes, moduleCount } = await bundleHtml({ htmlFile, sourceRoot, manifest: embeddedManifest, payload });
  const htmlBuffer = Buffer.from(html, "utf8");
  const canonicalManifest = canonicalJson(embeddedManifest);
  const canonicalPayload = canonicalJson(payload);
  const bundleCompression = compressedByteSizes(htmlBuffer);
  const manifestCompression = compressedByteSizes(canonicalManifest);
  const payloadCompression = compressedByteSizes(canonicalPayload);
  const htmlBytes = bundleCompression.rawBytes;
  const manifestBytes = manifestCompression.rawBytes;
  const payloadBytes = payloadCompression.rawBytes;
  invariant(htmlBytes <= budget.maximumBundleBytes, `Bundle size ${htmlBytes} exceeds maximumBundleBytes ${budget.maximumBundleBytes}`);
  invariant(runtimeBytes <= budget.maximumRuntimeSourceBytes, `Runtime source size ${runtimeBytes} exceeds maximumRuntimeSourceBytes ${budget.maximumRuntimeSourceBytes}`);
  invariant(assetBytes <= budget.maximumAssetBytes, `Asset size ${assetBytes} exceeds maximumAssetBytes ${budget.maximumAssetBytes}`);
  invariant(manifestBytes <= budget.maximumManifestBytes, `Manifest size ${manifestBytes} exceeds maximumManifestBytes ${budget.maximumManifestBytes}`);

  const jsonParseBenchmark = benchmarkJsonParse([canonicalManifest, canonicalPayload]);
  const memorySnapshot = process.memoryUsage();
  const peakResidentSetBytes = Math.max(process.resourceUsage().maxRSS * 1024, memorySnapshot.rss);
  const performanceEvidence = await loadRuntimePerformanceEvidence(root, manifest.libraryHash, options.performance ?? "artifacts/performance/runtime-performance.json");

  const report = {
    schemaVersion: 1,
    artifact: path.relative(root, outFile).split(path.sep).join("/"),
    artifactSha256: sha256Bytes(htmlBuffer),
    prototypeArtifact: path.relative(root, prototypeFile).split(path.sep).join("/"),
    prototypeSha256: sha256Bytes(htmlBuffer),
    totalBundleBytes: htmlBytes,
    totalBundleGzipBytes: bundleCompression.gzipBytes,
    totalBundleBrotliBytes: bundleCompression.brotliBytes,
    runtimeBytes,
    assetBytes,
    moduleCount,
    manifestBytes,
    manifestGzipBytes: manifestCompression.gzipBytes,
    manifestBrotliBytes: manifestCompression.brotliBytes,
    seedPayloadBytes: payloadBytes,
    seedPayloadGzipBytes: payloadCompression.gzipBytes,
    seedPayloadBrotliBytes: payloadCompression.brotliBytes,
    totalEncodedSeedBytes: seedStats.encodedTotal,
    totalEmbeddedCount: seedStats.embeddedTotal,
    encodedBytesPerSeed: seedStats.embeddedTotal === 0 ? null : seedStats.encodedTotal / seedStats.embeddedTotal,
    parseTimeMs: performanceEvidence?.parseTimeMs ?? null,
    startupTimeMs: performanceEvidence?.startupTimeMs ?? null,
    peakMemoryBytes: performanceEvidence?.peakMemoryBytes ?? null,
    selectionLatencyMs: performanceEvidence?.selectionLatencyMs ?? null,
    performanceEvidence: performanceEvidence ?? { environment: "unavailable", source: null },
    buckets: Object.fromEntries(Object.entries(manifest.buckets).map(([bucketId, bucket]) => [bucketId, {
      enabled: bucket.enabled,
      embeddedCount: bucket.embeddedCount,
      encodedBytes: bucket.encodedBytes,
      averageEncodedBytesPerSeed: bucket.embeddedCount === 0 ? null : bucket.encodedBytes / bucket.embeddedCount,
    }])),
    jsonParseBenchmark,
    buildProcessMemory: {
      environment: "node-build-process",
      peakResidentSetBytes,
      ...Object.fromEntries(Object.entries(memorySnapshot).map(([key, value]) => [`${key}Bytes`, value])),
    },
    configHash: manifest.configHash,
    payloadHash: manifest.payloadHash,
    libraryHash: manifest.libraryHash,
    limits: {
      maximumBundleBytes: budget.maximumBundleBytes,
      maximumRuntimeSourceBytes: budget.maximumRuntimeSourceBytes,
      maximumAssetBytes: budget.maximumAssetBytes,
      maximumManifestBytes: budget.maximumManifestBytes,
      maximumEmbeddedCount: config.maximumEmbeddedCount,
      maximumEmbeddedBytes: config.maximumEmbeddedBytes,
    },
  };
  await atomicWrite(outFile, html);
  await atomicWrite(prototypeFile, html);
  await atomicWrite(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  const legacyReportFile = path.join(path.dirname(outFile), "build-report.json");
  if (legacyReportFile !== reportFile) await rm(legacyReportFile, { force: true });
  return report;
}

async function main() {
  try {
    const report = await buildSingle(parseArgs(process.argv.slice(2)));
    process.stdout.write(`Built ${report.artifact} (${report.totalBundleBytes} bytes, ${report.totalEmbeddedCount} certified deals)\n`);
  } catch (error) {
    process.stderr.write(`Build failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
