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
