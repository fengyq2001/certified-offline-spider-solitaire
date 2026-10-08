import test from "node:test";
import assert from "node:assert/strict";
import { assessVersionCompatibility, compareVersions } from "../../src/runtime/version.js";

test("numeric versions compare and expose safe compatibility modes", () => {
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.equal(compareVersions("1.2.1", "1.2.0"), 1);
  assert.deepEqual(assessVersionCompatibility({ runtimeVersion: "1.0.0", minRuntimeVersion: "2.0.0" }), { compatible: false, mode: "export-only", reason: "RUNTIME_TOO_OLD" });
  assert.deepEqual(assessVersionCompatibility({ runtimeVersion: "3.0.0", maxRuntimeVersion: "2.0.0" }), { compatible: false, mode: "reject", reason: "RUNTIME_TOO_NEW" });
});

