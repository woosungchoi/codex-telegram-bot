import { LocalizedError } from "../i18n.js";
export const CLEANUP_EXECUTION_MODES = Object.freeze([
  "manual",
  "quarantine",
  "delete",
  "both"
]);

export function parseCleanupExecutionMode(value, label = "CLEANUP_EXECUTION_MODE") {
  const normalized = String(value ?? "manual").trim().toLowerCase();
  if (CLEANUP_EXECUTION_MODES.includes(normalized)) return normalized;
  throw new LocalizedError("errors.mustBeOneOf", { value1: label, value2: CLEANUP_EXECUTION_MODES.join(", ") });
}
