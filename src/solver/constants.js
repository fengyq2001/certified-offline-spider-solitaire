export const SOLVER_VERSION = "0.1.0";
export const VALIDATOR_VERSION = "0.1.0";
export const CLASSIFIER_VERSION = "0.1.0-provisional";
export const CERTIFICATE_SCHEMA_VERSION = 1;

export const DEFAULT_SOLVER_OPTIONS = Object.freeze({
  nodeBudget: 100_000,
  timeoutMs: 2_000,
  transpositionLimit: 250_000,
});
