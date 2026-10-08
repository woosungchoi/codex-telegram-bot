import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../", import.meta.url));
async function fixture(t, mode) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "publish-security-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const mock = path.join(root, "mock.mjs"), log = path.join(root, "calls.jsonl"), body = path.join(root, "review.md");
  await fs.writeFile(body, "Untrusted review text: $(touch NEVER_EXECUTE)\n");
  await fs.writeFile(mock, `import fs from 'node:fs';
const mode=${JSON.stringify(mode)};
globalThis.fetch=async(url, options={})=>{
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({url,method:options.method||'GET',body:options.body})+'\\n');
 let result={};
 if(url.endsWith('/pulls/12')) result={state:'open',head:{sha:mode==='stale'?'old':'abc'}};
 else if(url.includes('/comments?')) result=mode==='existing'?[{id:123,user:{type:'Bot'},body:'<!-- codex-telegram-bot:pr-review -->\\nold'}]:[{id:321,user:{type:'User'},body:'<!-- codex-telegram-bot:pr-review -->\\nspoof'}];
 else if(url.includes('/git/commits/')&&!options.body)result={tree:{sha:'base-tree'}};
 else if(url.includes('/pulls?'))result=mode==='repeat'?[{number:15}]:[];
 else if(url.includes('/git/matching-refs/'))result=[];
 else result={sha:'a'.repeat(40)};
 return {ok:true,status:200,text:async()=>JSON.stringify(result),json:async()=>result};
};`);
  const env = { PATH: process.env.PATH, GITHUB_TOKEN: "fake-token", GH_TOKEN: "fake-token", GITHUB_REPOSITORY: "fixture/repo", EXPECTED_HEAD: "abc", BASE_SHA: "b".repeat(40) };
  const calls = async () => (await fs.readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse);
  return { root, body, calls, run: (script, args) => exec(process.execPath, ["--import", mock, path.join(repo, "scripts", script), ...args], { cwd: repo, env }) };
}
for (const mode of ["new", "existing"]) test(`review publication ${mode}: updates only bot comments and treats artifacts as text`, async (t) => {
  const f = await fixture(t, mode);
  await f.run("github_comment_upsert.mjs", ["12", "pr-review", f.body]);
  const calls = await f.calls(), write = calls.filter((c) => c.method !== "GET");
  assert.equal(write.length, 1); assert.equal(write[0].method, mode === "existing" ? "PATCH" : "POST");
  if (mode === "existing") assert.ok(write[0].url.endsWith("/comments/123"));
  assert.match(JSON.parse(write[0].body).body, /touch NEVER_EXECUTE/);
  await assert.rejects(fs.access(path.join(repo, "NEVER_EXECUTE")));
});
test("stale PR review is rejected before comment mutation", async (t) => {
  const f = await fixture(t, "stale");
  await assert.rejects(f.run("github_comment_upsert.mjs", ["12", "pr-review", f.body]), /Stale review/);
  assert.equal((await f.calls()).some((c) => c.method !== "GET"), false);
});
for (const mode of ["oversize", "binary", "symlink"]) test(`review publication rejects ${mode} artifact before GitHub calls`, async (t) => {
  const f = await fixture(t, mode);
  if (mode === "oversize") await fs.writeFile(f.body, "a".repeat(50001));
  if (mode === "binary") await fs.writeFile(f.body, "a\0b");
  if (mode === "symlink") { await fs.rename(f.body, `${f.body}.real`); await fs.symlink(`${f.body}.real`, f.body); }
  await assert.rejects(f.run("github_comment_upsert.mjs", ["12", "pr-review", f.body]));
  assert.equal((await f.calls()).length, 0);
});
for (const mode of ["new", "repeat"]) test(`package publisher ${mode}: trusted data API creates or reuses a normal PR`, async (t) => {
  const f = await fixture(t, mode), input = path.join(f.root, "input"); await fs.mkdir(input);
  for (const name of ["package.json", "package-lock.json"]) await fs.copyFile(path.join(repo, name), path.join(input, name));
  await f.run("publish_package_update.mjs", [input]);
  const calls = await f.calls(), writes = calls.filter((c) => c.method !== "GET");
  assert.equal(writes.some((c) => c.url.endsWith("/pulls")), mode === "new");
  if (mode === "repeat") assert.equal(writes.length, 0);
  else {
    const tree = JSON.parse(writes.find((c) => c.url.endsWith("/git/trees")).body).tree;
    assert.deepEqual(tree.map((i) => i.path).sort(), ["package-lock.json", "package.json"]);
    assert.ok(JSON.parse(writes.find((c) => c.url.endsWith("/git/refs")).body).ref.startsWith("refs/heads/automation/"));
    assert.equal(writes.some((c) => c.method === "PATCH" || c.method === "DELETE"), false);
  }
});

test("isolated package hook has no publication token or usable persisted git credential", async (t) => {
  const f = await fixture(t, "hook"), home = path.join(f.root, "home"); await fs.mkdir(home);
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  await exec("git", ["init", "--quiet", f.root], { env });
  await fs.writeFile(path.join(f.root, "package.json"), JSON.stringify({ name: "isolated-hook", version: "1.0.0", scripts: { postinstall: "node probe.mjs" } }));
  await fs.writeFile(path.join(f.root, "probe.mjs"), `import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
const keys=['GH_TOKEN','GITHUB_TOKEN','CODEX_AUTOMATION_TOKEN','CODEX_ACCESS_TOKEN','TELEGRAM_BOT_TOKEN'];
const credential=spawnSync('git',['-c','credential.helper=','credential','fill'],{input:'protocol=https\\nhost=github.com\\n\\n',encoding:'utf8'});
fs.writeFileSync('probe.json',JSON.stringify({secrets:keys.filter(k=>process.env[k]),authenticated:credential.status===0,gitConfig:fs.readFileSync('.git/config','utf8')}));`);
  await exec("npm", ["run", "postinstall", "--ignore-scripts"], { cwd: f.root, env });
  const result = JSON.parse(await fs.readFile(path.join(f.root, "probe.json"), "utf8"));
  assert.deepEqual(result.secrets, []); assert.equal(result.authenticated, false);
  assert.doesNotMatch(result.gitConfig, /extraheader|credential|token/i);
});
