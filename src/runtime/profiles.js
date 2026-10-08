import { RuntimeDataError } from "./errors.js";
import { createRuntimeId } from "./random.js";

export const GUEST_PROFILE_ID = "guest";

function cleanName(name) {
  const result = String(name ?? "").trim();
  if (!result || result.length > 64) throw new RuntimeDataError("INVALID_PROFILE_NAME", "Profile name must contain 1 to 64 characters");
  return result;
}

export function createGuestProfile(now = Date.now()) {
  return Object.freeze({ profileId: GUEST_PROFILE_ID, name: "Guest", guest: true, createdAt: now, updatedAt: now });
}

export function createLocalProfile(name, options = {}) {
  const now = options.now ?? Date.now();
  return Object.freeze({
    profileId: options.profileId ?? createRuntimeId("profile", options.crypto),
    name: cleanName(name),
    guest: false,
    createdAt: now,
    updatedAt: now,
  });
}

export function renameProfile(profile, name, now = Date.now()) {
  if (!profile?.profileId) throw new RuntimeDataError("INVALID_PROFILE", "Cannot rename an invalid profile");
  return Object.freeze({ ...profile, name: cleanName(name), updatedAt: now });
}

