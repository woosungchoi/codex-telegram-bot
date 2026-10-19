import test from "node:test";
import assert from "node:assert/strict";
import { appServerDirectArgs, appServerThreadReadEvents, connectAppServer, createAppServerThread } from "../src/codex/app_server.js";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

test("createAppServerThread exposes an SDK-like thread shape", () => {
  const thread = createAppServerThread({
    threadId: "thread-1",
    threadOptions: { workingDirectory: "/repo" }
  });
  assert.equal(thread.transport, "app-server-direct");
  assert.equal(thread.id, "thread-1");
  assert.equal(typeof thread.run, "function");
  assert.equal(typeof thread.runStreamed, "function");
  assert.equal(thread.sessionTimeoutMs, 120_000);
});

async function delayedServer(t, { sessionDelayMs = 0, hangSession = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "session-rpc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, "fake.mjs");
  const log = join(dir, "requests.jsonl");
  await writeFile(log, "");
  await writeFile(script, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const x = JSON.parse(line);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method: x.method, pid: process.pid }) + '\\n');
  if (x.method === 'initialize') send({ id: x.id, result: {} });
  if (['thread/start', 'thread/resume'].includes(x.method) && !${hangSession}) {
    setTimeout(() => send({ id: x.id, result: { thread: { id: x.params.threadId || 'new-thread' } } }), ${sessionDelayMs});
  }
  if (x.method === 'turn/start') send({ id: x.id, result: { turn: { id: 'turn', status: 'completed', items: [] } } });
  if (x.method === 'test/delay') setTimeout(() => send({ id: x.id, result: 'done' }), x.params.delayMs);
});`, { mode: 0o700 });
  return { script, requests: async () => (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse) };
}

test("session RPC can outlast the control timeout and logs only timing metadata", async (t) => {
  const { script } = await delayedServer(t);
  const messages = [];
  t.mock.method(console, "warn", (...args) => messages.push(args.join(" ")));
  const client = await connectAppServer({ codexPath: script });
  t.after(() => client.close());
  client.requestTimeoutMs = 50;
  assert.equal(await client.request("test/delay", { delayMs: 150, secret: "private-prompt" }, { timeoutMs: 1000, slowAfterMs: 20 }), "done");
  assert.equal(messages.length, 2);
  assert.match(messages[0], /"status":"slow"/);
  assert.match(messages[1], /"status":"completed"/);
  assert.doesNotMatch(messages.join(""), /private-prompt|secret|delayMs/);
  // The longer session budget must not change ordinary RPC deadlines.
  await assert.rejects(client.request("test/hang"), { code: "CODEX_APP_SERVER_REQUEST_TIMEOUT", method: "test/hang", timeoutMs: 50 });
  assert.equal(client.pending.size, 0);
});

for (const threadId of ["", "existing-thread"]) {
  test(`delayed ${threadId ? "resume" : "start"} preserves identity and starts exactly one turn`, async (t) => {
    const { script, requests } = await delayedServer(t, { sessionDelayMs: 150 });
    const thread = createAppServerThread({ codexPath: script, threadId, sessionTimeoutMs: 1000 });
    await thread.run("hello");
    assert.equal(thread.id, threadId || "new-thread");
    assert.deepEqual((await requests()).map(x => x.method), ["initialize", "initialized", threadId ? "thread/resume" : "thread/start", "turn/start"]);
  });
}

test("resume timeout closes the process without replaying input or replacing the thread", async (t) => {
  const { script, requests } = await delayedServer(t, { hangSession: true });
  t.mock.method(console, "warn", () => {});
  const thread = createAppServerThread({ codexPath: script, threadId: "existing-thread", sessionTimeoutMs: 50 });
  await assert.rejects(thread.run("hello"), { code: "CODEX_APP_SERVER_REQUEST_TIMEOUT", method: "thread/resume", timeoutMs: 50 });
  const calls = await requests();
  assert.deepEqual(calls.map(x => x.method), ["initialize", "initialized", "thread/resume"]);
  assert.equal(thread.id, "existing-thread");
  assert.throws(() => process.kill(calls[0].pid, 0), { code: "ESRCH" });
});

test("cancel during resume closes the process promptly and never starts a turn", async (t) => {
  const { script, requests } = await delayedServer(t, { hangSession: true });
  const controller = new AbortController();
  const thread = createAppServerThread({ codexPath: script, threadId: "existing-thread" });
  const result = thread.run("hello", { signal: controller.signal });
  const rejected = assert.rejects(result, /cancel-resume/);
  t.after(() => controller.abort(new Error("cancel-resume")));
  let calls;
  for (let i = 0; i < 100; i++) {
    calls = await requests();
    if (calls.some(x => x.method === "thread/resume")) break;
    await delay(20);
  }
  assert.ok(calls.some(x => x.method === "thread/resume"));
  controller.abort(new Error("cancel-resume"));
  await rejected;
  assert.deepEqual((await requests()).map(x => x.method), ["initialize", "initialized", "thread/resume"]);
  assert.throws(() => process.kill(calls[0].pid, 0), { code: "ESRCH" });
});

test("closing a slow request clears both warning and deadline timers", async (t) => {
  const { script } = await delayedServer(t);
  const messages = [];
  t.mock.method(console, "warn", (...args) => messages.push(args.join(" ")));
  const client = await connectAppServer({ codexPath: script });
  t.after(() => client.close());
  const rejected = assert.rejects(client.request("test/hang", {}, { timeoutMs: 150, slowAfterMs: 50 }), /connection closed/);
  await client.close();
  await rejected;
  await delay(200);
  assert.equal(client.pending.size, 0);
  assert.deepEqual(messages, []);
});

test("appServerDirectArgs uses direct stdio without daemon or proxy", () => {
  assert.deepEqual(appServerDirectArgs(), ["app-server", "--stdio"]);
});

test("appServerThreadReadEvents converts completed turns into stream notifications", () => {
  const events = appServerThreadReadEvents({
    thread: {
      id: "thread-1",
      turns: [
        {
          id: "turn-1",
          status: "completed",
          items: [
            { type: "agentMessage", id: "msg-1", text: "done" }
          ]
        }
      ]
    }
  });

  assert.deepEqual(events, [
    {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", id: "msg-1", text: "done" }
      }
    },
    {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [
            { type: "agentMessage", id: "msg-1", text: "done" }
          ]
        }
      }
    }
  ]);
});

test("app-server routes server requests separately even when IDs collide with client requests", async (t) => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "question-rpc-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, "fake.mjs");
  await fs.writeFile(script, `#!/usr/bin/env node
import {createInterface} from 'node:readline';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const x=JSON.parse(line);
 if(x.method==='initialize')send({id:x.id,result:{}});
 if(x.method==='thread/start')send({id:x.id,result:{thread:{id:'thread'}}});
 if(x.method==='turn/start'){
  send({id:x.id,method:'item/tool/requestUserInput',params:{threadId:'thread',turnId:'turn',isBlocking:true,questions:[{id:'q',question:'Choose',options:[{label:'A'}]}]}});
  send({id:x.id,result:{turn:{id:'turn',status:'inProgress'}}});
 }
 if(x.result?.answers){
  send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'answer',type:'agentMessage',text:x.result.answers.q.answers[0]}}});
  send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
 }
});`, { mode: 0o700 });
  let requested = false;
  const thread = createAppServerThread({ codexPath: script });
  const result = await thread.run("hello", { onUserInput: async (request) => {
    requested = true;
    assert.equal(request.params.questions[0].id, "q");
    await new Promise((r) => setTimeout(r, 20));
    return { answers: { q: { answers: ["A"] } } };
  } });
  assert.equal(requested, true);
  assert.equal(result.finalResponse, "A");
});

test('app-server steering uses the active turn and never interrupts or starts a second turn', async (t) => {
  const fs = await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'steer-rpc-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const script=path.join(dir,'fake.mjs');
  await fs.writeFile(script, `#!/usr/bin/env node
import {createInterface} from 'node:readline';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
let started=0;
createInterface({input:process.stdin}).on('line',line=>{
 const x=JSON.parse(line);
 if(x.method==='initialize')send({id:x.id,result:{}});
 if(x.method==='thread/start')send({id:x.id,result:{thread:{id:'thread'}}});
 if(x.method==='turn/start'){started++;send({id:x.id,result:{turn:{id:'turn',status:'inProgress'}}});}
 if(x.method==='turn/interrupt')process.exit(22);
 if(x.method==='turn/steer'){
  if(started!==1 || x.params.expectedTurnId!=='turn'||x.params.threadId!=='thread')process.exit(23);
  send({id:x.id,result:{turnId:'turn'}});
  send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'answer',type:'agentMessage',text:x.params.input[0].text}}});
  send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
 }
});`,{mode:0o700});
  let control, delivery, released=false;
  const result=await createAppServerThread({codexPath:script}).run('start',{onSteerReady:c=>{control=c;delivery=c.steer('changed');return ()=>{released=true;};}});
  assert.equal(result.finalResponse,'changed');assert.equal((await delivery).status,'accepted');assert.equal(released,true);
  assert.equal((await control.steer('too late')).status,'rejected');
});

test("original input receipt hooks surround one native turn/start with a correlated client ID", async (t) => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "input-receipt-rpc-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, "fake.mjs");
  const intent = path.join(dir, "intent.json");
  await fs.writeFile(script, `#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {readFileSync} from 'node:fs';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
let starts=0;
createInterface({input:process.stdin}).on('line',line=>{
 const x=JSON.parse(line);
 if(x.method==='initialize')send({id:x.id,result:{}});
 if(x.method==='thread/start')send({id:x.id,result:{thread:{id:'thread'}}});
 if(x.method==='turn/start'){
  const saved=JSON.parse(readFileSync(${JSON.stringify(intent)},'utf8'));
  if(++starts!==1 || saved.threadId!=='thread')throw Error('receipt ordering');
  send({id:x.id,result:{turn:{id:'turn',status:'completed',items:[{id:'answer',type:'agentMessage',text:x.params.clientUserMessageId}]}}});
 }
});`, { mode: 0o700 });
  const receipts = [];
  const thread = createAppServerThread({ codexPath: script });
  const result = await thread.run("hello", {
    clientUserMessageId: "telegram:receipt-test",
    onThreadReady: async (receipt) => { receipts.push(receipt); await fs.writeFile(intent, JSON.stringify(receipt)); },
    onTurnStarted: async (receipt) => { receipts.push(receipt); }
  });
  assert.equal(result.finalResponse, "telegram:receipt-test");
  assert.deepEqual(receipts, [{ threadId: "thread" }, { threadId: "thread", turnId: "turn" }]);
});

for (const resume of [false, true]) {
  test(`direct ${resume ? "resume" : "start"} sends explicit network/search/write-root controls to the native server`, async (t) => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-policy-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const capture = path.join(dir, "requests.jsonl");
    const script = path.join(dir, "fake.mjs");
    await fs.writeFile(script, `#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const x=JSON.parse(line);
 appendFileSync(${JSON.stringify(capture)},line+'\\n');
 if(x.method==='initialize')send({id:x.id,result:{}});
 if(x.method==='thread/start'||x.method==='thread/resume')send({id:x.id,result:{thread:{id:'thread'},sandbox:{type:'workspaceWrite',writableRoots:['/stale'],networkAccess:true,excludeTmpdirEnvVar:true,excludeSlashTmp:true}}});
 if(x.method==='turn/start')send({id:x.id,result:{turn:{id:'turn',status:'completed',items:[]}}});
});`, { mode: 0o700 });
    await createAppServerThread({ codexPath: script, threadId: resume ? "thread" : "", threadOptions: {
      workingDirectory: dir, skipGitRepoCheck: true, sandboxMode: "workspace-write",
      networkAccessEnabled: false, webSearchEnabled: false, webSearchMode: "live",
      additionalDirectories: ["/new"], codexConfig: { fixture: "preserved" }
    } }).run("fixture");
    const requests = (await fs.readFile(capture, "utf8")).trim().split("\n").map(JSON.parse);
    const session = requests.find((r) => r.method === (resume ? "thread/resume" : "thread/start"));
    assert.deepEqual(session.params.config, { fixture: "preserved", web_search: "disabled",
      "sandbox_workspace_write.network_access": false, "sandbox_workspace_write.writable_roots": ["/new"] });
    assert.deepEqual(requests.find((r) => r.method === "turn/start").params.sandboxPolicy, {
      type: "workspaceWrite", writableRoots: [dir, "/new"], networkAccess: false,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true
    });
  });
}
