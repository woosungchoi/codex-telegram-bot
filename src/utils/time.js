export function timestampForFilename(value) {
  return new Date(value).toISOString().replace(/[:.]/g, "-");
}
