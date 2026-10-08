import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { accountFixture } from "./helpers/accounts_fixture.mjs";
import { createCodexThread } from "../src/codex/thread_factory.js";
import { signInAccount } from "../src/accounts/auth.js";
import { runWorkerJob } from "../src/worker/executor.js";
import { createWorkerStore } from "../src/worker/store.js";

async function fakeCli(t) {
  const f = await accountFixture(t);
  const file = path.join(f.root, "fake-codex.mjs");
  const marker = path.join(f.root, "closed");
  await fs.writeFile(file, `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const flags = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(f.root, 'flags.json'))}, 'utf8'));
const marker = ${JSON.stringify(marker)};
const host = process.env.CODEX_HOME.endsWith('/host');
fs.appendFileSync(${JSON.stringify(path.join(f.root, 'env-audit.jsonl'))}, JSON.stringify({home:process.env.CODEX_HOME, keys:Object.keys(process.env)})+'\\n');
process.on('exit',()=>{if(host)fs.writeFileSync(marker,'exited');});
const send = (v) => process.stdout.write(JSON.stringify(v)+'\\n');
const fail = {message:'You have hit your usage limit.',codexErrorInfo:'usageLimitExceeded'};
const done = {type:'turn.completed',usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0}};
if(process.argv[2]==='exec') {
  process.stdin.resume();
  process.stdin.on('end',()=>{
    send({type:'thread.started',thread_id:host?'old-thread':'new-thread'});
    if(host) {send({type:'turn.failed',error:fail});setTimeout(()=>{fs.writeFileSync(marker,'exited');process.exit(1);},25);}
    else {if(!fs.existsSync(marker)) process.exit(3);send({type:'item.completed',item:{id:'m',type:'agent_message',text:'completed'}});send(done);}
  });
} else {
  process.on('SIGTERM',()=>{if(host)fs.writeFileSync(marker,'exited');process.exit(0);});
  readline.createInterface({input:process.stdin}).on('line',(line)=>{
    const m=JSON.parse(line);if(m.id==null)return;
    let result={};
    if(m.method==='account/login/start'){
      fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),'FAKE_AUTH_TOKEN');
      send({method:'account/login/completed',params:{loginId:'login',success:true}});
      result={type:'chatgptDeviceCode',loginId:'login',verificationUrl:'https://auth.openai.com/codex/device',userCode:'ABCD-1234'};
    }
    if(m.method==='account/read')result={account:{type:'chatgpt',planType:'plus'}};
    if(m.method==='thread/start'||m.method==='thread/resume') result={thread:{id:host?'old-thread':'new-thread'}};
    if(m.method==='turn/start') result={turn:{id:'turn',status:'inProgress'}};
    if(m.method==='turn/start'&&host&&flags.FAKE_EARLY_FAILURE==='1'){
      send({method:'error',params:{threadId:'old-thread',turnId:'turn',error:fail,willRetry:false}});
      send({id:m.id,result});return;
    }
    if(m.method==='turn/start'&&flags.FAKE_EARLY_COMPLETE==='1'){
      const threadId=host?'old-thread':'new-thread';
      send({method:'item/completed',params:{threadId,turnId:'turn',item:{type:'agentMessage',id:'m',text:'early completion'}}});
      send({method:'turn/completed',params:{threadId,turn:{id:'turn',status:'completed'}}});
      send({id:m.id,result});return;
    }
    send({id:m.id,result});
    if(m.method==='turn/start')setTimeout(()=>{
      if(flags.FAKE_UNEXPECTED_EXIT==='1')process.exit(7);
      const threadId=host?'old-thread':'new-thread';
      if(host)send({method:'error',params:{threadId,turnId:'turn',error:fail,willRetry:false}});
      else {
        if(!fs.existsSync(marker))process.exit(3);
        send({method:'error',params:{threadId,turnId:'turn',error:{message:'temporary reconnect'},willRetry:true}});
        setTimeout(()=>{
          send({method:'item/completed',params:{threadId,turnId:'turn',item:{type:'agentMessage',id:'m',text:'completed'}}});
          send({method:'turn/completed',params:{threadId,turn:{id:'turn',status:'completed'}}});
        },15);
      }
    },10);
  });
}
`, { mode: 0o700 });
  await fs.writeFile(path.join(f.root, "flags.json"), "{}");
  f.config = { ...f.config, codexPath: file, codexEnv: { ...process.env, CODEX_HOME: f.config.codexHome, EXIT_MARKER: marker } };
  return f;
}

test("device login completes over the actual subprocess JSON-RPC client", async (t) => {
  const { config, store } = await fakeCli(t);
  let code;
  const account = await signInAccount({ config, store, onCode: async (value) => { code = value.userCode; } });
  assert.equal(code, "ABCD-1234");
  assert.equal(account.status, "ready");
});

for (const transport of ["sdk", "app-server-direct"]) {
  test(`${transport}: worker switches isolated subprocess credentials and waits for exit`, { timeout: 10000 }, async (t) => {
    const { config, store, root } = await fakeCli(t);
    const account = await store.create("Backup");
    await store.update(account.id, { status: "ready" });
    await store.setAutoRotate(true);
    config.codexSandboxMode = "danger-full-access";
    config.codexEnv.TELEGRAM_BOT_TOKEN = "OVERRIDE_SENTINEL";
    config.codexEnv.FUTURE_SECRET = "OVERRIDE_SENTINEL";
    const previous = process.env.FUTURE_SECRET;
    process.env.FUTURE_SECRET = "AMBIENT_SENTINEL";
    t.after(() => { if (previous === undefined) delete process.env.FUTURE_SECRET; else process.env.FUTURE_SECRET = previous; });
    const workerStore = createWorkerStore({ codexWorkerStateDir: path.join(root, "worker") });
    await workerStore.ensure();
    const result = await runWorkerJob({ job: { id: "job", chatKey: "chat", inputText: "test", transport, effectiveOptions: { sandboxMode: "danger-full-access" } }, config, store: workerStore, signal: new AbortController().signal });
    assert.equal(result.finalResponse, "completed");
    const audited = (await fs.readFile(path.join(root, "env-audit.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(new Set(audited.map((e) => e.home)).size >= 2);
    for (const entry of audited) {
      for (const secret of ["TELEGRAM_BOT_TOKEN", "FUTURE_SECRET", "GH_TOKEN"]) assert.equal(entry.keys.includes(secret), false);
      assert.equal(entry.keys.includes("PATH"), true);
    }
    const final = await workerStore.readJobState("job");
    assert.equal(final.status, "completed");
    assert.equal(final.accountId, account.id);
    assert.equal(final.threadId, "new-thread");
    assert.deepEqual(final.accountAttemptState.triedAccountIds, ["default", account.id]);
    const events = await workerStore.readJobEvents("job");
    assert.equal(events.filter((e) => e.type === "worker.job.completed").length, 1);
    assert.equal(events.some((e) => e.type === "worker.job.failed"), false);
    assert.equal(await fs.readFile(path.join(config.codexHome, "auth.json"), "utf8"), "HOST_TOKEN_SENTINEL");
  });
}

test("SDK client caches are partitioned by account", async (t) => {
  const { config, store } = await fakeCli(t);
  const account = await store.create("B");
  await store.update(account.id, { status: "ready" });
  const clients = new Map();
  const first = createCodexThread({ config, codexClients: clients });
  await assert.rejects(first.run("request"));
  const second = createCodexThread({ config, accountId: account.id, codexClients: clients });
  assert.equal((await second.run("request")).finalResponse, "completed");
  assert.equal(clients.size, 2);
});

test("unexpected app-server exit terminates the job rather than hanging", { timeout: 5000 }, async (t) => {
  const { config, store } = await fakeCli(t);
  const account = await store.create("B");
  await store.update(account.id, { status: "ready" });
  await fs.writeFile(path.join(path.dirname(config.codexPath), "flags.json"), JSON.stringify({ FAKE_UNEXPECTED_EXIT: "1" }));
  const thread = createCodexThread({ config, accountId: account.id, transport: "app-server-direct" });
  await assert.rejects(thread.run("request"), /process exited/);
  await store.remove(account.id);
});

test("app-server completion before the turn/start response finishes the stream", { timeout: 5000 }, async (t) => {
  const { config } = await fakeCli(t);
  await fs.writeFile(path.join(path.dirname(config.codexPath), "flags.json"), JSON.stringify({ FAKE_EARLY_COMPLETE: "1" }));
  const thread = createCodexThread({ config, transport: "app-server-direct" });
  assert.equal((await thread.run("request")).finalResponse, "early completion");
});

test("early app-server terminal failure preserves the quota reason for rotation", { timeout: 5000 }, async (t) => {
  const { config, store } = await fakeCli(t);
  const backup = await store.create("Backup");
  await store.update(backup.id, { status: "ready" });
  await store.setAutoRotate(true);
  await fs.writeFile(path.join(path.dirname(config.codexPath), "flags.json"), JSON.stringify({ FAKE_EARLY_FAILURE: "1" }));
  const thread = createCodexThread({ config, transport: "app-server-direct" });
  assert.equal((await thread.run("request")).finalResponse, "completed");
  assert.equal(thread.accountId, backup.id);
});
