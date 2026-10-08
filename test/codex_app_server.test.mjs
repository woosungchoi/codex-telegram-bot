import test from "node:test";
import assert from "node:assert/strict";
import { appServerDirectArgs, appServerThreadReadEvents, createAppServerThread } from "../src/codex/app_server.js";

test("createAppServerThread exposes an SDK-like thread shape", () => {
  const thread = createAppServerThread({
    threadId: "thread-1",
    threadOptions: { workingDirectory: "/repo" }
  });
  assert.equal(thread.transport, "app-server-direct");
  assert.equal(thread.id, "thread-1");
  assert.equal(typeof thread.run, "function");
  assert.equal(typeof thread.runStreamed, "function");
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
