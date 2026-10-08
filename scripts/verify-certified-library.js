#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { computeDealId, computeInitialDealHash, generateDeal } from "../src/core/generator.js";
import { validateSolutionCertificate } from "../src/solver/validator.js";
import { sha256Canonical, validateSeedArtifacts } from "./build-single.js";

const ROOT = path.resolve(import.meta.dirname, "..");

function parseArgs(argv) {
  const options = {
    config: path.join(ROOT, "src/config/seed-pool-config.json"),
    manifest: path.join(ROOT, "src/data/resolved-seed-manifest.json"),
    payload: path.join(ROOT, "src/data/certified-seeds.json"),
    catalog: path.join(ROOT, "artifacts/seed-factory/native/certificate-catalog.json"),
    certificates: path.join(ROOT, "artifacts/seed-factory/native/certificates.json"),
    classifications: path.join(ROOT, "artifacts/seed-factory/native/classification-records.json"),
    report: path.join(ROOT, "artifacts/release/certified-library-regression.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = flag.startsWith("--") ? flag.slice(2) : "";
    if (!Object.hasOwn(options, key)) throw new Error(`Unknown option: ${flag}`);
    const value = argv[++index];
    if (!value) throw new Error(`${flag} requires a path`);
    options[key] = path.resolve(value);
  }
  return options;
}

async function loadJson(file, label) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot load ${label} at ${file}: ${error.message}`);
  }
}

function duplicateCount(values) {
  return values.length - new Set(values).size;
}

async function verify(options) {
  const [config, manifest, payload, catalog, certificateRecords, classificationRecords] = await Promise.all([
    loadJson(options.config, "SeedPoolConfig"),
    loadJson(options.manifest, "resolved manifest"),
    loadJson(options.payload, "certified payload"),
    loadJson(options.catalog, "certificate catalog"),
    loadJson(options.certificates, "solution certificates"),
    loadJson(options.classifications, "classification records"),
  ]);
  validateSeedArtifacts(config, manifest, payload, { requirePublishable: true });
  if (!Array.isArray(catalog) || !Array.isArray(certificateRecords) || !Array.isArray(classificationRecords)) throw new Error("Certificate and classification files must contain arrays");
  if (sha256Canonical(catalog) !== manifest.certificateCatalogHash) throw new Error("Certificate catalog hash mismatch");
  if (sha256Canonical(classificationRecords) !== manifest.classificationCatalogHash) throw new Error("Classification catalog hash mismatch");

  const duplicateDealIdCount = duplicateCount(payload.deals.map((deal) => deal.dealId));
  const duplicateInitialDealHashCount = duplicateCount(payload.deals.map((deal) => deal.initialDealHash));
  if (duplicateDealIdCount || duplicateInitialDealHashCount) throw new Error("Runtime payload contains duplicate deal identities");

  const catalogByDeal = new Map(catalog.map((entry) => [entry.dealId, entry]));
  const certificateByDeal = new Map(certificateRecords.map((entry) => [entry.dealId, entry]));
  const classificationByDeal = new Map(classificationRecords.map((entry) => [entry.dealId, entry]));
  if (catalogByDeal.size !== catalog.length || certificateByDeal.size !== certificateRecords.length || classificationByDeal.size !== classificationRecords.length) {
    throw new Error("Certificate evidence contains duplicate dealId entries");
  }

  const results = [];
  for (const deal of payload.deals) {
    const catalogEntry = catalogByDeal.get(deal.dealId);
    const certificateRecord = certificateByDeal.get(deal.dealId);
    const classification = classificationByDeal.get(deal.dealId);
    if (!catalogEntry || !certificateRecord || !classification) throw new Error(`Missing certificate or classification evidence for ${deal.dealId}`);
    if (catalogEntry.certificateHash !== certificateRecord.certificateHash
      || certificateRecord.certificateHash !== certificateRecord.certificate?.certificateHash) {
      throw new Error(`Certificate hash linkage mismatch for ${deal.dealId}`);
    }
    if (certificateRecord.certificate.solverVersion !== manifest.solverVersion
      || certificateRecord.certificate.solverConfigHash !== manifest.solverConfigHash
      || classification.solverVersion !== manifest.solverVersion
      || classification.solverConfigHash !== manifest.solverConfigHash
      || classification.validatorVersion !== manifest.validatorVersion
      || classification.classifierVersion !== manifest.classifierVersion
      || classification.calibrationDatasetHash !== manifest.calibrationDatasetHash
      || classification.certificateHash !== certificateRecord.certificateHash
      || classification.suitMode !== deal.suitMode
      || classification.difficulty !== deal.difficulty
      || classification.classificationStatus !== manifest.classificationStatus) {
      throw new Error(`Versioned evidence linkage mismatch for ${deal.dealId}`);
    }
    const initialState = generateDeal(deal.canonicalSeed, deal.suitMode);
    const [dealId, initialDealHash] = await Promise.all([
      computeDealId(deal.canonicalSeed, deal.suitMode, config.ruleVersion, config.generatorVersion),
      computeInitialDealHash(initialState),
    ]);
    if (dealId !== deal.dealId || initialDealHash !== deal.initialDealHash) {
      throw new Error(`Regenerated identity mismatch for ${deal.dealId}`);
    }
    const validation = await validateSolutionCertificate(initialState, certificateRecord.certificate);
    if (!validation.pass) throw new Error(`Validator rejected ${deal.dealId}: ${validation.errorCode} at step ${validation.stepIndex}`);
    results.push({
      dealId: deal.dealId,
      bucketId: `${deal.suitMode}s.${deal.difficulty}`,
      certificateHash: certificateRecord.certificateHash,
      solutionLength: validation.solutionLength,
      validatorVersion: validation.validatorVersion,
      result: "PASS",
    });
  }

  const runtimeDealIds = new Set(payload.deals.map((deal) => deal.dealId));
  const orphanCatalogCount = catalog.filter((entry) => !runtimeDealIds.has(entry.dealId)).length;
  const orphanCertificateCount = certificateRecords.filter((entry) => !runtimeDealIds.has(entry.dealId)).length;
  const orphanClassificationCount = classificationRecords.filter((entry) => !runtimeDealIds.has(entry.dealId)).length;
  if (orphanCatalogCount || orphanCertificateCount || orphanClassificationCount) throw new Error("Development evidence contains entries outside the runtime payload");

  const bucketResults = Object.fromEntries(Object.entries(manifest.buckets).map(([bucketId, bucket]) => {
    const validatedCount = results.filter((entry) => entry.bucketId === bucketId).length;
    if (validatedCount !== bucket.embeddedCount) throw new Error(`${bucketId} validated count does not match embeddedCount`);
    return [bucketId, { enabled: bucket.enabled, embeddedCount: bucket.embeddedCount, validatedCount, result: "PASS" }];
  }));

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    libraryHash: manifest.libraryHash,
    payloadHash: manifest.payloadHash,
    certificateCatalogHash: manifest.certificateCatalogHash,
    classificationStatus: manifest.classificationStatus,
    validatedCount: results.length,
    totalEmbeddedCount: manifest.totalEmbeddedCount,
    failedCount: 0,
    duplicateDealIdCount,
    duplicateInitialDealHashCount,
    tombstonedEntrySelectedCount: 0,
    orphanCatalogCount,
    orphanCertificateCount,
    orphanClassificationCount,
    bucketResults,
    deals: results,
    result: "PASS",
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await verify(options);
  await mkdir(path.dirname(options.report), { recursive: true });
  await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Certified library regression PASS (${report.validatedCount}/${report.totalEmbeddedCount} deals)\n`);
}

main().catch((error) => {
  process.stderr.write(`Certified library regression FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
