export function mergeAdditionalDirectories(configuredDirectories = [], uploadDir = "") {
  return [...new Set([...configuredDirectories, uploadDir].filter(Boolean))];
}
