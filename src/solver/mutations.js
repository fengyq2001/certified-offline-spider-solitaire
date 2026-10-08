import { clone, sha256 } from "./canonical.js";

function resign(certificate) {
  const { certificateHash: ignored, ...payload } = certificate;
  certificate.certificateHash = sha256(payload);
  return certificate;
}

export function createCertificateMutations(certificate) {
  if (!certificate.steps.length) throw new RangeError("cannot mutate an empty solution");
  const mutations = [];
  const deleted = clone(certificate);
  deleted.steps.splice(Math.floor(deleted.steps.length / 2), 1);
  deleted.solutionLength = deleted.steps.length;
  mutations.push({ name: "deleted-step", certificate: resign(deleted) });

  const duplicated = clone(certificate);
  duplicated.steps.splice(1, 0, clone(duplicated.steps[0]));
  duplicated.solutionLength = duplicated.steps.length;
  mutations.push({ name: "duplicated-step", certificate: resign(duplicated) });

  if (certificate.steps.length > 1) {
    const swapped = clone(certificate);
    [swapped.steps[0], swapped.steps[1]] = [swapped.steps[1], swapped.steps[0]];
    mutations.push({ name: "swapped-steps", certificate: resign(swapped) });
  }

  const illegal = clone(certificate);
  illegal.steps[0].move = { type: "move", from: 0, to: 0, count: 1 };
  mutations.push({ name: "illegal-move", certificate: resign(illegal) });

  const illegalMulti = clone(certificate);
  illegalMulti.steps[0].move = { type: "move", from: 0, to: 8, count: 14 };
  mutations.push({ name: "illegal-multi-card-move", certificate: resign(illegalMulti) });

  const unknown = clone(certificate);
  unknown.steps[0].move = { type: "teleport", from: 0, to: 8, count: 1 };
  mutations.push({ name: "unknown-operation", certificate: resign(unknown) });

  const outOfRange = clone(certificate);
  outOfRange.steps[0].move = { type: "move", from: Number.MAX_SAFE_INTEGER + 1, to: -1, count: 1 };
  mutations.push({ name: "out-of-range-values", certificate: resign(outOfRange) });

  const flipped = clone(certificate);
  flipped.steps[0].effects.flipped.push("forged-card-id");
  mutations.push({ name: "wrong-flip-effect", certificate: resign(flipped) });

  if (certificate.steps.some((step) => step.effects.completed.length > 0)) {
    const completion = clone(certificate);
    const step = completion.steps.find((candidate) => candidate.effects.completed.length > 0);
    step.effects.completed.pop();
    mutations.push({ name: "wrong-completion-effect", certificate: resign(completion) });
  }

  const truncated = clone(certificate);
  truncated.steps.pop();
  truncated.solutionLength = truncated.steps.length;
  mutations.push({ name: "truncated-solution", certificate: resign(truncated) });

  const forgedWin = clone(certificate);
  forgedWin.steps = [];
  forgedWin.solutionLength = 0;
  mutations.push({ name: "forged-win", certificate: resign(forgedWin) });

  const identity = clone(certificate);
  identity.canonicalSeed = "u64:ffffffffffffffff";
  mutations.push({ name: "identity-mismatch", certificate: resign(identity) });

  const initialHash = clone(certificate);
  initialHash.initialDealHash = "0".repeat(64);
  mutations.push({ name: "initial-hash-mismatch", certificate: resign(initialHash) });

  const badVersion = clone(certificate);
  badVersion.validatorVersion = "999";
  mutations.push({ name: "bad-version", certificate: resign(badVersion) });
  return mutations;
}
