import { CompatibilityError } from "./errors.js";

const VERSION_RE = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*|x|\*))?(?:\.(0|[1-9]\d*|x|\*))?(?:[-+].*)?$/;

export function parseVersion(value, label = "version") {
  const match = VERSION_RE.exec(String(value ?? ""));
  if (!match) {
    throw new CompatibilityError("INVALID_VERSION", `${label} is not a supported numeric version`, { value });
  }
  const parts = [match[1], match[2] ?? "0", match[3] ?? "0"];
  const wildcard = parts.findIndex((part) => part === "x" || part === "*");
  if (wildcard >= 0 && parts.slice(wildcard).some((part) => part !== "x" && part !== "*" && part !== "0")) {
    throw new CompatibilityError("INVALID_VERSION", `${label} has a non-trailing wildcard`, { value });
  }
  return parts.map((part) => (part === "x" || part === "*" ? Number.MAX_SAFE_INTEGER : Number(part)));
}

export function compareVersions(left, right) {
  const a = parseVersion(left, "left version");
  const b = parseVersion(right, "right version");
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function assertVersionInRange(runtimeVersion, minVersion, maxVersion) {
  if (minVersion != null && compareVersions(runtimeVersion, minVersion) < 0) {
    throw new CompatibilityError("RUNTIME_TOO_OLD", `Runtime ${runtimeVersion} is older than required ${minVersion}`);
  }
  if (maxVersion != null && compareVersions(runtimeVersion, maxVersion) > 0) {
    throw new CompatibilityError("RUNTIME_TOO_NEW", `Runtime ${runtimeVersion} is newer than supported ${maxVersion}`);
  }
  return true;
}

export function assessVersionCompatibility({ runtimeVersion, minRuntimeVersion, maxRuntimeVersion }) {
  try {
    assertVersionInRange(runtimeVersion, minRuntimeVersion, maxRuntimeVersion);
    return { compatible: true, mode: "read-write", reason: null };
  } catch (error) {
    if (error?.code === "RUNTIME_TOO_OLD") {
      return { compatible: false, mode: "export-only", reason: error.code };
    }
    return { compatible: false, mode: "reject", reason: error?.code ?? "INVALID_VERSION" };
  }
}
