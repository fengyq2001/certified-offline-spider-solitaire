export function seedArtifacts() {
  const hash = (value) => value.toString(16).padStart(64, "0");
  const deals = [
    { dealId: hash(1), canonicalSeed: "u64:0000000000000001", initialDealHash: hash(101), suitMode: "1s", difficulty: "easy", status: "certified" },
    { dealId: hash(2), canonicalSeed: "u64:0000000000000002", initialDealHash: hash(102), suitMode: "1s", difficulty: "easy", status: "certified" },
    { dealId: hash(3), canonicalSeed: "u64:0000000000000003", initialDealHash: hash(103), suitMode: "1s", difficulty: "easy", status: "disabled" },
  ];
  return {
    manifest: {
      schemaVersion: 1,
      configVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      configHash: hash(201),
      payloadHash: hash(202),
      libraryHash: hash(203),
      certificateCatalogHash: hash(204),
      solverConfigHash: hash(205),
      calibrationDatasetHash: hash(206),
      classificationCatalogHash: hash(207),
      seedLibraryVersion: "1.0.0",
      minRuntimeVersion: "1.0.0",
      maxRuntimeVersion: "1.9.9",
      ruleVersion: "1.0",
      generatorVersion: "1",
      payloadSchemaVersion: 1,
      buckets: {
        "1s.easy": { enabled: true, allowEmptyBucket: false, candidatesScanned: 2, candidateScanScope: "bucket", certifiedTarget: 2, actualCount: 2, embeddedTarget: 2, embeddedCount: 2, minimumPublishableCount: 1, encodedBytes: 200 },
        "1s.medium": { enabled: true, allowEmptyBucket: true, candidatesScanned: 0, candidateScanScope: "bucket", certifiedTarget: 0, actualCount: 0, embeddedTarget: 0, embeddedCount: 0, minimumPublishableCount: 0, encodedBytes: 0 },
        "4s.demon": { enabled: false, allowEmptyBucket: false, candidatesScanned: 0, candidateScanScope: "disabled", certifiedTarget: 0, actualCount: 0, embeddedTarget: 0, embeddedCount: 0, minimumPublishableCount: 0, encodedBytes: 0 },
      },
      maximumEmbeddedCount: 10,
      maximumEmbeddedBytes: 1000,
      totalEmbeddedCount: 2,
      totalEncodedBytes: 200,
      payloadIndex: [
        { bucketId: "1s.easy", startOffset: 0, entryCount: 3 },
        { bucketId: "1s.medium", startOffset: 3, entryCount: 0 },
        { bucketId: "4s.demon", startOffset: 3, entryCount: 0 },
      ],
    },
    payload: { schemaVersion: 1, deals },
  };
}

export function seedArtifactsV2() {
  const hash = (value) => value.toString(16).padStart(64, "0");
  const fixture = seedArtifacts();
  fixture.manifest.payloadSchemaVersion = 2;
  fixture.manifest.seedLibraryVersion = "2.0.0";
  fixture.manifest.parentLibraryVersion = "1.0.0";
  fixture.manifest.buckets["1s.easy"] = {
    ...fixture.manifest.buckets["1s.easy"],
    candidatesScanned: 4,
    certifiedTarget: 3,
    actualCount: 2,
    embeddedTarget: 2,
    embeddedCount: 2,
  };
  fixture.manifest.buckets["1s.medium"] = {
    ...fixture.manifest.buckets["1s.medium"],
    allowEmptyBucket: false,
    candidatesScanned: 1,
    certifiedTarget: 1,
    actualCount: 1,
    embeddedTarget: 1,
    embeddedCount: 1,
    minimumPublishableCount: 1,
    encodedBytes: 100,
  };
  fixture.manifest.totalEmbeddedCount = 3;
  fixture.manifest.totalEncodedBytes = 300;
  fixture.payload.schemaVersion = 2;
  fixture.payload.deals[2].status = "certified";
  fixture.payload.deals.push({
    dealId: hash(4),
    canonicalSeed: "u64:0000000000000004",
    initialDealHash: hash(104),
    suitMode: "1s",
    difficulty: "easy",
    status: "certified",
  });
  fixture.payload.tombstones = [
    {
      dealId: hash(2),
      status: "active",
      reasonCode: "RECALIBRATED",
      classificationOverride: "medium",
      effectiveLibraryVersion: "2.0.0",
    },
    {
      dealId: hash(3),
      status: "superseded",
      reasonCode: "DUPLICATE_CONTENT",
      disabledAt: "2026-10-05T00:00:00.000Z",
      supersededBy: hash(4),
      effectiveLibraryVersion: "2.0.0",
    },
  ];
  fixture.manifest.payloadIndex = [
    { bucketId: "1s.easy", startOffset: 0, entryCount: 4 },
    { bucketId: "1s.medium", startOffset: 4, entryCount: 0 },
    { bucketId: "4s.demon", startOffset: 4, entryCount: 0 },
  ];
  return fixture;
}
