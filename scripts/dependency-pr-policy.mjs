import { isDeepStrictEqual } from "node:util";

export const REQUIRED_CHECKS = [
  ...[18, 20, 22, 24, 26].map((version) => `Check Node ${version}`),
  "Integration coverage",
  "Security audit",
];
const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
];
const lockRootFields = dependencyFields.filter((key) => key !== "overrides");

export function trustedUpdate(pr, repository) {
  if (
    pr.state !== "open" ||
    pr.draft ||
    pr.base?.ref !== "main" ||
    !SHA.test(pr.head?.sha || "") ||
    !SHA.test(pr.base?.sha || "")
  )
    return "";
  if (
    pr.base?.repo?.id !== repository.id ||
    pr.head?.repo?.id !== repository.id ||
    pr.head?.repo?.full_name !== repository.full_name
  )
    return "";
  const author = pr.user;
  if (
    pr.head.ref.startsWith("dependabot/") &&
    author?.login === "dependabot[bot]" &&
    author.id === 49699333 &&
    author.type === "Bot"
  )
    return "dependabot";
  if (pr.head.ref === "automation/update-codex-packages") {
    const actions =
      author?.login === "github-actions[bot]" &&
      author.id === 41898282 &&
      author.type === "Bot";
    // The existing updater uses the owner PAT when set, and github.token otherwise.
    // Git commit attribution is not PR identity.
    const owner =
      author?.login === repository.owner?.login &&
      author.id === repository.owner?.id &&
      author.type === "User";
    if (actions || owner) return "codex";
  }
  return "";
}

export function checksPassed(checks, statuses, sha) {
  const trusted = checks.filter(
    (check) => check.app?.slug === "github-actions" && check.head_sha === sha,
  );
  if (
    !REQUIRED_CHECKS.every((name) =>
      trusted.some(
        (check) =>
          check.name === name &&
          check.status === "completed" &&
          check.conclusion === "success",
      ),
    )
  )
    return false;
  if (
    checks.some(
      (check) =>
        check.head_sha !== sha ||
        check.status !== "completed" ||
        !["success", "skipped", "neutral"].includes(check.conclusion),
    )
  )
    return false;
  if (
    trusted.some(
      (check) =>
        REQUIRED_CHECKS.includes(check.name) && check.conclusion !== "success",
    )
  )
    return false;
  return statuses.every((status) => status.state === "success");
}

function without(object, fields) {
  return Object.fromEntries(
    Object.entries(object).filter(([key]) => !fields.includes(key)),
  );
}

function versionChangesOnly(before, after) {
  if (isDeepStrictEqual(before, after)) return true;
  if (typeof before === "string" && typeof after === "string")
    return VERSION.test(after);
  if (
    !before ||
    !after ||
    typeof before !== "object" ||
    typeof after !== "object" ||
    Array.isArray(before) ||
    Array.isArray(after)
  )
    return false;
  const keys = Object.keys(before).sort();
  return (
    isDeepStrictEqual(keys, Object.keys(after).sort()) &&
    keys.every((key) => versionChangesOnly(before[key], after[key]))
  );
}

export function manifestAllowed(before, after, source) {
  if (
    !isDeepStrictEqual(
      without(before, dependencyFields),
      without(after, dependencyFields),
    )
  )
    return false;
  if (
    !dependencyFields.every((key) =>
      versionChangesOnly(before[key], after[key]),
    )
  )
    return false;
  // Codex changes require an explicit maintainer decision, including Dependabot.
  if (before.dependencies?.["@openai/codex-sdk"] !== after.dependencies?.["@openai/codex-sdk"]
    || before.devDependencies?.["@openai/codex"] !== after.devDependencies?.["@openai/codex"]) return false;
  if (source !== "codex") return true;
  const stripCodex = (pkg) => ({
    ...pkg,
    dependencies: without(pkg.dependencies || {}, ["@openai/codex-sdk"]),
    devDependencies: without(pkg.devDependencies || {}, ["@openai/codex"]),
  });
  return isDeepStrictEqual(stripCodex(before), stripCodex(after));
}

export function lockfileAllowed(before, after, manifest) {
  for (const key of new Set([...Object.keys(before.packages || {}), ...Object.keys(after.packages || {})])) {
    if (/(?:^|\/)node_modules\/@openai\/codex(?:$|[-/])/.test(key)
      && !isDeepStrictEqual(before.packages?.[key], after.packages?.[key])) return false;
  }
  for (const key of new Set([...Object.keys(before.dependencies || {}), ...Object.keys(after.dependencies || {})])) {
    if (/^@openai\/codex(?:$|[-/])/.test(key)
      && !isDeepStrictEqual(before.dependencies?.[key], after.dependencies?.[key])) return false;
  }
  if (
    !isDeepStrictEqual(
      without(before, ["packages", "dependencies"]),
      without(after, ["packages", "dependencies"]),
    )
  )
    return false;
  const rootBefore = before.packages?.[""],
    rootAfter = after.packages?.[""];
  if (
    !rootBefore ||
    !rootAfter ||
    !isDeepStrictEqual(
      without(rootBefore, lockRootFields),
      without(rootAfter, lockRootFields),
    )
  )
    return false;
  if (
    !lockRootFields.every((key) =>
      isDeepStrictEqual(rootAfter[key], manifest[key]),
    )
  )
    return false;
  return Object.entries(after.packages).every(
    ([key, entry]) =>
      !key ||
      !entry.resolved ||
      entry.resolved.startsWith("https://registry.npmjs.org/"),
  );
}

export function actionRefsOnly(before, after) {
  if (/uses:\s*[\w.-]+\/[\w./-]+@(?![a-f0-9]{40}(?:\s|$))/m.test(after)) return false;
  let changes = 0;
  const normalize = (text) =>
    text.replace(
      /^(\s*(?:-\s+)?uses:\s*)([\w.-]+\/[\w./-]+)@(v\d+(?:\.\d+)*(?:-[\w.-]+)?|[0-9a-f]{40})(\s*(?:#.*)?)$/gm,
      (_line, prefix, action, _ref, suffix) => {
        changes += 1;
        return `${prefix}${action}@VERSION${suffix}`;
      },
    );
  const left = normalize(before),
    right = normalize(after);
  return changes > 0 && before !== after && left === right;
}

export function filesAllowed(files, source, content) {
  if (!files.length || files.some((file) => file.status !== "M")) return false;
  const pkgBefore = JSON.parse(content("base", "package.json"));
  const pkgAfter = JSON.parse(content("head", "package.json"));
  if (!manifestAllowed(pkgBefore, pkgAfter, source)) return false;
  return files.every(({ path }) => {
    if (path === "package.json") return true;
    if (path === "package-lock.json")
      return lockfileAllowed(
        JSON.parse(content("base", path)),
        JSON.parse(content("head", path)),
        pkgAfter,
      );
    if (
      source === "dependabot" &&
      /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)
    )
      return actionRefsOnly(content("base", path), content("head", path));
    return false;
  });
}

export function unchangedSnapshot(before, after, repository) {
  return (
    Boolean(trustedUpdate(after, repository)) &&
    after.head.sha === before.head.sha &&
    after.base.sha === before.base.sha &&
    after.user.id === before.user.id &&
    after.head.ref === before.head.ref
  );
}
