import test from "node:test";
import assert from "node:assert/strict";
import { validateRegistryLockUpdate, registryMetadata } from "../scripts/codex_registry_policy.mjs";

const platforms = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"];
function metadata(name, version) {
  const sdk = name.endsWith("-sdk"), platform = /-(darwin|linux|win32)-(arm64|x64)$/.exec(version);
  return { name, version, license: "Apache-2.0", engines: { node: ">=18" },
    dist: { tarball: `https://registry.npmjs.org/${name}/-/${name.split("/")[1]}-${version}.tgz`, integrity: "sha512-YQ==" },
    ...(sdk ? { dependencies: { "@openai/codex": version } } : platform ? { os: [platform[1]], cpu: [platform[2]] }
      : { bin: { codex: "bin/codex.js" }, optionalDependencies: Object.fromEntries(platforms.map(p => [`@openai/codex-${p}`, `npm:@openai/codex@${version}-${p}`])) }) };
}
function lock(version) {
  const packages = { "": { name: "test", version: "1.0.0", dependencies: { "@openai/codex-sdk": version, other: "1.0.0" }, devDependencies: { "@openai/codex": version } },
    "node_modules/other": { version: "1.0.0", resolved: "https://registry.npmjs.org/other/-/other-1.0.0.tgz", integrity: "sha512-YQ==" } };
  for (const part of ["codex-sdk", "codex", ...platforms.map(p => `codex-${p}`)]) {
    const alias = part !== "codex" && part !== "codex-sdk";
    const name = part === "codex-sdk" ? "@openai/codex-sdk" : "@openai/codex";
    const m = metadata(name, alias ? version + part.slice(5) : version);
    const { name: ignoredName, dist, ...entry } = m;
    void ignoredName;
    packages[`node_modules/@openai/${part}`] = { ...entry, resolved: dist.tarball, integrity: dist.integrity,
      ...(alias ? { name, optional: true } : {}) };
  }
  return { name: "test", version: "1.0.0", lockfileVersion: 3, packages };
}

test("automatic policy verifies SDK, CLI and every changed platform without human hashes", async () => {
  const seen = [];
  await validateRegistryLockUpdate(lock("0.163.0"), lock("0.164.0"), async (name, version) => { seen.push([name, version]); return metadata(name, version); });
  assert.equal(seen.length, 8);
  assert.ok(seen.some(([name, version]) => name === "@openai/codex" && version.endsWith("linux-arm64")));
});
for (const [name, change] of Object.entries({
  "SDK integrity": next => { next.packages["node_modules/@openai/codex-sdk"].integrity = "sha512-evil"; },
  "CLI bin": next => { next.packages["node_modules/@openai/codex"].bin.node = "evil.js"; },
  "CLI lifecycle": next => { next.packages["node_modules/@openai/codex"].hasInstallScript = true; },
  "platform identity": next => { next.packages["node_modules/@openai/codex-linux-arm64"].cpu = ["x64"]; },
  "stale platform": next => { next.packages["node_modules/@openai/codex-linux-x64"] = lock("0.163.0").packages["node_modules/@openai/codex-linux-x64"]; },
  "unrelated lock integrity": next => { next.packages["node_modules/other"].integrity = "sha512-evil"; },
  "root bin": next => { next.packages[""].bin = { node: "evil.js" }; },
  "lock metadata": next => { next.extra = "evil"; },
  "new package": next => { next.packages["node_modules/new"] = { version: "1.0.0" }; },
  "removed platform": next => { delete next.packages["node_modules/@openai/codex-win32-x64"]; }
})) test(`automatic policy rejects ${name}`, async () => {
  const next = lock("0.164.0"); change(next);
  await assert.rejects(validateRegistryLockUpdate(lock("0.163.0"), next, metadata));
});
for (const version of ["0.162.0", "1.0.0", "0.164.0-beta.1", "0.163.0"]) test(`version ${version} requires manual review`, async () => {
  await assert.rejects(validateRegistryLockUpdate(lock("0.163.0"), lock(version), metadata));
});
test("same-version CLI metadata mutation is blocked while SDK increases", async () => {
  const next = lock("0.163.0");
  next.packages[""].dependencies["@openai/codex-sdk"] = "0.164.0";
  next.packages["node_modules/@openai/codex-sdk"] = lock("0.164.0").packages["node_modules/@openai/codex-sdk"];
  next.packages["node_modules/@openai/codex"].bin = { node: "evil.js" };
  await assert.rejects(validateRegistryLockUpdate(lock("0.163.0"), next, metadata), /same-version/);
});
test("registry failure or unexpected package identity fails closed", async () => {
  for (const getMetadata of [async () => { throw new Error("network unavailable"); }, async (n,v) => ({ ...metadata(n,v), name: "attacker" }),
    async (n,v) => ({ ...metadata(n,v), scripts: { postinstall: "unexpected" } })]) {
    await assert.rejects(validateRegistryLockUpdate(lock("0.163.0"), lock("0.164.0"), getMetadata));
  }
});
test("registry requests cannot target arbitrary packages, URLs or versions", async () => {
  await assert.rejects(registryMetadata("https://evil.invalid", "0.164.0"), /Unsupported/);
  await assert.rejects(registryMetadata("@openai/codex", "../../evil"), /Unsupported/);
});
