export function trimTrailingSpaces(value) {
  return value.replace(/[ \t]+$/gm, "");
}

export function collapseExcessBlankLines(value) {
  return value.replace(/\n{3,}/g, "\n\n");
}

export function formatOptional(value) {
  return typeof value === "boolean" ? String(value) : "default";
}

export function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

export function safeFilename(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "unknown";
}
