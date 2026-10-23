import { isDeepStrictEqual } from "node:util";

const CODEX_ENTRY = /^node_modules\/@openai\/(codex-sdk|codex(?:-(?:darwin|linux|win32)-(?:arm64|x64))?)$/;
const METADATA = ["license", "bin", "engines", "dependencies", "optionalDependencies", "os", "cpu"];

export async function registryMetadata(name, version) {
  if (!["@openai/codex", "@openai/codex-sdk"].includes(name) || !/^\d+\.\d+\.\d+(?:-(?:darwin|linux|win32)-(?:arm64|x64))?$/.test(version)) throw new Error("Unsupported registry package.");
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
    redirect: "error", signal: globalThis.AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`Registry verification unavailable: ${response.status}`);
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error("Registry metadata too large.");
  return JSON.parse(text);
}

// This is the owner's CI-based policy, not a claim of human artifact review.
// Fetch only registry JSON; never execute candidate code with publication credentials.
export async function validateRegistryLockUpdate(before, after, getMetadata = registryMetadata) {
  const expectedRoot = globalThis.structuredClone(before.packages?.[""]);
  const root = after.packages?.[""];
  let changed = false;
  for (const [section, name] of [["dependencies", "@openai/codex-sdk"], ["devDependencies", "@openai/codex"]]) {
    const old = expectedRoot?.[section]?.[name], next = root?.[section]?.[name];
    if (!/^\d+\.\d+\.\d+$/.test(old || "") || !/^\d+\.\d+\.\d+$/.test(next || "")) throw new Error("Stable pinned Codex version required.");
    const a = old.split(".").map(Number), b = next.split(".").map(Number);
    if (a[0] !== b[0] || b[1] < a[1] || (b[1] === a[1] && b[2] < a[2])) throw new Error("Major upgrades and downgrades require manual review.");
    expectedRoot[section][name] = next;
    changed ||= old !== next;
  }
  if (!changed) throw new Error("A Codex version increase is required.");
  if (!isDeepStrictEqual(expectedRoot, root)
    || !isDeepStrictEqual({ ...before, packages: null }, { ...after, packages: null })
    || !isDeepStrictEqual(Object.keys(before.packages).sort(), Object.keys(after.packages).sort())) throw new Error("Lock structure changes require manual review.");
  for (const [entry, candidate] of Object.entries(after.packages)) {
    if (!entry) continue;
    const previous = before.packages[entry];
    const match = CODEX_ENTRY.exec(entry);
    if (!match) {
      if (!isDeepStrictEqual(previous, candidate)) throw new Error("Unrelated or same-version lock mutation.");
      continue;
    }
    const sdk = match[1] === "codex-sdk";
    const suffix = sdk ? "" : match[1].slice("codex".length);
    const expectedVersion = sdk ? root.dependencies["@openai/codex-sdk"] : root.devDependencies["@openai/codex"] + suffix;
    if (candidate.version !== expectedVersion) throw new Error("Codex platform/version mismatch.");
    if (isDeepStrictEqual(previous, candidate)) continue;
    if (candidate.version === previous.version) throw new Error("Unrelated or same-version lock mutation.");
    const name = sdk ? "@openai/codex-sdk" : "@openai/codex";
    const metadata = await getMetadata(name, expectedVersion);
    if (metadata.name !== name || metadata.version !== expectedVersion
      || !metadata.dist?.tarball?.startsWith("https://registry.npmjs.org/")
      || !/^sha512-[A-Za-z0-9+/]+=*$/.test(metadata.dist?.integrity || "")
      || metadata.scripts?.install || metadata.scripts?.preinstall || metadata.scripts?.postinstall) throw new Error("Unsupported registry metadata.");
    const expected = { ...previous, version: metadata.version, resolved: metadata.dist.tarball, integrity: metadata.dist.integrity };
    if (Object.hasOwn(previous, "name")) expected.name = metadata.name;
    for (const key of METADATA) {
      delete expected[key];
      if (metadata[key] !== undefined) expected[key] = metadata[key];
    }
    if (!isDeepStrictEqual(candidate, expected)) throw new Error("Lock bytes or executable metadata disagree with the registry.");
  }
}
