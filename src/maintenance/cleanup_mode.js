export const CLEANUP_EXECUTION_MODES = Object.freeze([
  "manual",
  "quarantine",
  "delete",
  "both"
]);

export function parseCleanupExecutionMode(value, label = "CLEANUP_EXECUTION_MODE") {
  const normalized = String(value ?? "manual").trim().toLowerCase();
  if (CLEANUP_EXECUTION_MODES.includes(normalized)) return normalized;
  throw new Error(`${label} must be one of: ${CLEANUP_EXECUTION_MODES.join(", ")}`);
}
