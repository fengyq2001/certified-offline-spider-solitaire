export class RuntimeDataError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "RuntimeDataError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class CompatibilityError extends RuntimeDataError {
  constructor(code, message, details = undefined) {
    super(code, message, details);
    this.name = "CompatibilityError";
  }
}

export class SeedSelectionError extends RuntimeDataError {
  constructor(code, message, details = undefined) {
    super(code, message, details);
    this.name = "SeedSelectionError";
  }
}

export class StorageError extends RuntimeDataError {
  constructor(code, message, details = undefined) {
    super(code, message, details);
    this.name = "StorageError";
  }
}

