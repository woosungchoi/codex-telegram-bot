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
const host = process.env.CODEX_HOME.endsWith('/host');
process.on('exit',()=>{if(host)fs.writeFileSync(process.env.EXIT_MARKER,'exited');});
const send = (v) => process.stdout.write(JSON.stringify(v)+'\\n');
const fail = {message:'You have hit your usage limit.',codexErrorInfo:'usageLimitExceeded'};
const done = {type:'turn.completed',usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0}};
if(process.argv[2]==='exec') {
  process.stdin.resume();
  process.stdin.on('end',()=>{
    send({type:'thread.started',thread_id:host?'old-thread':'new-thread'});
    if(host) {send({type:'turn.failed',error:fail});setTimeout(()=>{fs.writeFileSync(process.env.EXIT_MARKER,'exited');process.exit(1);},25);}
    else {if(!fs.existsSync(process.env.EXIT_MARKER)) process.exit(3);send({type:'item.completed',item:{id:'m',type:'agent_message',text:'completed'}});send(done);}
  });
} else {
  process.on('SIGTERM',()=>{if(host)fs.writeFileSync(process.env.EXIT_MARKER,'exited');process.exit(0);});
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
    if(m.method==='turn/start'&&host&&process.env.FAKE_EARLY_FAILURE==='1'){
      send({method:'error',params:{threadId:'old-thread',turnId:'turn',error:fail,willRetry:false}});
      send({id:m.id,result});return;
    }
    if(m.method==='turn/start'&&process.env.FAKE_EARLY_COMPLETE==='1'){
      const threadId=host?'old-thread':'new-thread';
      send({method:'item/completed',params:{threadId,turnId:'turn',item:{type:'agentMessage',id:'m',text:'early completion'}}});
      send({method:'turn/completed',params:{threadId,turn:{id:'turn',status:'completed'}}});
      send({id:m.id,result});return;
    }
    send({id:m.id,result});
    if(m.method==='turn/start')setTimeout(()=>{
      if(process.env.FAKE_UNEXPECTED_EXIT==='1')process.exit(7);
      const threadId=host?'old-thread':'new-thread';
      if(host)send({method:'error',params:{threadId,turnId:'turn',error:fail,willRetry:false}});
      else {
        if(!fs.existsSync(process.env.EXIT_MARKER))process.exit(3);
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
    const workerStore = createWorkerStore({ codexWorkerStateDir: path.join(root, "worker") });
    await workerStore.ensure();
    const result = await runWorkerJob({ job: { id: "job", chatKey: "chat", inputText: "test", transport }, config, store: workerStore, signal: new AbortController().signal });
    assert.equal(result.finalResponse, "completed");
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
  config.codexEnv.FAKE_UNEXPECTED_EXIT = "1";
  const thread = createCodexThread({ config, accountId: account.id, transport: "app-server-direct" });
  await assert.rejects(thread.run("request"), /process exited/);
  await store.remove(account.id);
});

test("app-server completion before the turn/start response finishes the stream", { timeout: 5000 }, async (t) => {
  const { config } = await fakeCli(t);
  config.codexEnv.FAKE_EARLY_COMPLETE = "1";
  const thread = createCodexThread({ config, transport: "app-server-direct" });
  assert.equal((await thread.run("request")).finalResponse, "early completion");
});

test("early app-server terminal failure preserves the quota reason for rotation", { timeout: 5000 }, async (t) => {
  const { config, store } = await fakeCli(t);
  const backup = await store.create("Backup");
  await store.update(backup.id, { status: "ready" });
  await store.setAutoRotate(true);
  config.codexEnv.FAKE_EARLY_FAILURE = "1";
  const thread = createCodexThread({ config, transport: "app-server-direct" });
  assert.equal((await thread.run("request")).finalResponse, "completed");
  assert.equal(thread.accountId, backup.id);
});
