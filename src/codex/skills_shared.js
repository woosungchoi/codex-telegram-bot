import path from "node:path";

export const STATUS_ORDER = ["local/system", "local/custom", "plugin enabled", "plugin cached", "plugin disabled"];

const FILE_URL_PATH_PATTERN = /\bfile:\/\/([^/\s]*)(\/[^/\s<>"'`|=,:;?&]+(?:\/[^/\s<>"'`|=,:;?&]+)*(?:\s+[^/\s<>"'`|=,.:;?&]+(?:\s+[^/\s<>"'`|=,.:;?&]+)*\/[^/\s<>"'`|=,:;?&]+(?:\/[^/\s<>"'`|=,:;?&]+)*)*)/gu;
const ABSOLUTE_POSIX_PATH_PATTERN = /(^|[^A-Za-z0-9/<])(\/[^/\s<>"'`|=,:;?&]+(?:\/[^/\s<>"'`|=,:;?&]+)*(?:\s+[^/\s<>"'`|=,.:;?&]+(?:\s+[^/\s<>"'`|=,.:;?&]+)*\/[^/\s<>"'`|=,:;?&]+(?:\/[^/\s<>"'`|=,:;?&]+)*)*)/gu;

export function addWarning(warnings, message, targetPath, codexHome) {
  warnings.push({ message: sanitizeDisplayText(message), target: sanitizeDisplayText(relativeCodexPath(codexHome, targetPath)) });
}

export function relativeCodexPath(codexHome, targetPath) {
  const relative = path.relative(codexHome, targetPath);
  return !relative || relative.startsWith("..") || path.isAbsolute(relative) ? "CODEX_HOME" : `CODEX_HOME/${relative.split(path.sep).join("/")}`;
}

export function sanitizeDisplayText(value) {
  return String(value).replace(FILE_URL_PATH_PATTERN, (_match, authority, token) => `file://${authority}${redactedPath(token)}`).replace(ABSOLUTE_POSIX_PATH_PATTERN, (_match, prefix, token) => `${prefix}${redactedPath(token)}`);
}

export function countByStatus(skills) {
  const counts = Object.fromEntries(STATUS_ORDER.map((status) => [status, 0]));
  for (const skill of skills)
    counts[skill.status] = (counts[skill.status] || 0) + 1;
  return counts;
}

export function isInsidePath(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function redactedPath(token) { return `[path]${token.match(/[),.;:!?]+$/u)?.[0] || ""}`; }
