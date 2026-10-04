import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createWorkerStore} from '../src/worker/store.js';
import {createSteeringBroker} from '../src/worker/steering.js';
import {createSteeringUi} from '../src/telegram/steering.js';
import {dequeueNextTurn, hydratePendingQueues, serializePendingTurn, pruneExpiredTurns} from '../src/queue.js';
import {isWorkerRestartFailure} from '../src/worker/replay.js';

async function brokerFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steer-test-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const store=createWorkerStore({codexWorkerStateDir:dir});
  await store.ensure();
  await store.writeJobState({id:'job',chatKey:'chat:topic',requesterUserId:'7',status:'running'});
  const controllers=new Map([['job',new AbortController()]]);
  const broker=createSteeringBroker({store,controllers});
  const params={jobId:'job',requestId:'input1',chatKey:'chat:topic',userId:'7',inputText:'do B',imagePaths:[]};
  return {store,controllers,broker,params};
}
test('steering validates identity and deduplicates concurrent delivery with durable receipts', async t => {
  const {store,broker,params}=await brokerFixture(t);let calls=0;
  broker.register('job',{threadId:'thread',turnId:'turn',steer:async input=>{
    calls++; assert.equal((await store.readJobState('job')).steers.input1.status,'sending');
    assert.equal(input,'do B');return {status:'accepted'};
  }});
  await assert.rejects(broker.submit({...params,userId:'8'}),/owner/);
  await assert.rejects(broker.submit({...params,chatKey:'other'}),/owner/);
  const answers=await Promise.all([broker.submit(params),broker.submit(params)]);
  assert.deepEqual(answers.map(x=>x.status),['accepted','accepted']);assert.equal(calls,1);
  await assert.rejects(broker.submit({...params,inputText:'different'}),/reused/);
  const restarted=createSteeringBroker({store,controllers:new Map()});
  assert.equal((await restarted.submit(params)).status,'accepted');
});
test('steering rejects expired targets and pending decisions, never resends uncertain requests',async t=>{
  const {store,broker,params}=await brokerFixture(t);
  assert.equal((await broker.submit(params)).status,'rejected');
  let calls=0;
  const release=broker.register('job',{turnId:'turn',steer:async()=>{calls++;throw Error('connection lost');}});
  await store.writeJobState({id:'job',userQuestion:{state:'pending'}});
  assert.equal((await broker.submit(params)).status,'rejected');assert.equal(calls,0);
  await store.writeJobState({id:'job',userQuestion:{state:'answered'}});
  assert.equal((await broker.submit(params)).status,'unknown');
  assert.equal((await broker.submit(params)).status,'unknown');assert.equal(calls,1);
  release();assert.equal((await broker.submit({...params,requestId:'input2'})).status,'rejected');
  assert.equal(isWorkerRestartFailure({failureReason:'steer_interrupted',error:'worker restarted before job completed'}),false);
});
test('in-flight and uncertain queue promotion survives restart and cannot expire into a replay',()=>{
  const item={id:'q',chatKey:'c',inputText:'hi',steerTarget:'job',steering:{status:'sending'},expiresAt:'2020-01-01T00:00:00Z'};
  const saved=serializePendingTurn(item);
  const hydrated=hydratePendingQueues({c:[saved]},{maxAgeSeconds:1});
  assert.equal(hydrated.pending.get('c').length,1);
  assert.equal(pruneExpiredTurns([saved],{maxAgeSeconds:1}).expired,0);
  assert.equal(dequeueNextTurn([saved],{maxAgeSeconds:1}).turn,null);
});
function uiFixture({status='accepted',question=null,rpcError=false}={}) {
  const turn={id:'q',requesterUserId:'7',steerTarget:'old-job',inputText:'do B',imagePaths:[]};
  let items=[turn], sent=0;const replies=[];const writes=[];
  const ui=createSteeringUi({getChatKey:()=> 'chat:topic',text:k=>k,
    getClient:()=>({currentQuestion:async()=>question,steerJob:async p=>{
      sent++; assert.equal(p.jobId,'old-job');assert.equal(turn.steering.status,'sending');
      assert.equal(writes.at(-1)[0].steering.status,'sending');
      if(rpcError)throw Error('timeout');return {status};
    }}),queue:{get:()=>items,persist:async()=>writes.push(JSON.parse(JSON.stringify(items))),remove:async()=>{items=[];},startDrain:async()=>{}}
  });
  const ctx={callbackQuery:{data:'steer:q'},from:{id:7},answerCbQuery:async()=>{},editMessageReplyMarkup:async()=>{},reply:async s=>replies.push(s)};
  return {ui,ctx,turn,replies,get items(){return items;},get sent(){return sent;}};
}
test('Telegram promotion removes accepted input once; stale clicks do not create new turns',async()=>{
  const f=uiFixture();await f.ui.handle(f.ctx,()=>assert.fail());await f.ui.handle(f.ctx,()=>assert.fail());
  assert.equal(f.sent,1);assert.equal(f.items.length,0);assert.equal(f.replies[0],'steerAccepted');
});
test('Telegram rejection stays queued; uncertainty holds; question answers take priority',async()=>{
  const rejected=uiFixture({status:'rejected'});await rejected.ui.handle(rejected.ctx,()=>{});
  assert.equal(rejected.items.length,1);assert.equal(rejected.turn.steering,undefined);
  const unknown=uiFixture({rpcError:true});await unknown.ui.handle(unknown.ctx,()=>{});
  assert.equal(unknown.turn.steering.status,'unknown');assert.equal(dequeueNextTurn(unknown.items).turn,null);
  const waiting=uiFixture({question:{id:'question'}});await waiting.ui.handle(waiting.ctx,()=>{});
  assert.equal(waiting.sent,0);assert.equal(waiting.turn.steering,undefined);
  const other=uiFixture();other.ctx.from.id=8;await other.ui.handle(other.ctx,()=>{});assert.equal(other.sent,0);
});

test('a persisted sending receipt after worker loss is unknown and cannot be redelivered',async t=>{
  const {store,broker,params}=await brokerFixture(t);let captured;
  broker.register('job',{turnId:'turn',steer:async()=>{
    captured=await store.readJobState('job');return {status:'accepted'};
  }});
  await broker.submit(params);
  await store.writeJobState({id:'job',steers:captured.steers});
  const restarted=createSteeringBroker({store,controllers:new Map()});
  assert.equal((await restarted.submit(params)).status,'unknown');
});

test('queue promotion rechecks a dequeue race after asynchronous question lookup',async()=>{
  let items=[{id:'q',requesterUserId:'7',steerTarget:'job',inputText:'hi'}];let sent=false;
  const ui=createSteeringUi({getChatKey:()=> 'c',text:k=>k,getClient:()=>({
    currentQuestion:async()=>{items=[];return null;},steerJob:async()=>{sent=true;}
  }),queue:{get:()=>items}});
  await ui.handle({callbackQuery:{data:'steer:q'},from:{id:7},answerCbQuery:async()=>{},reply:async()=>{}},()=>{});
  assert.equal(sent,false);
});

test('automatic steering uses the same receipts without callback-only Telegram methods', async () => {
  for (const status of ['accepted', 'rejected', 'unknown']) {
    const f = uiFixture({status});
    delete f.ctx.callbackQuery;
    delete f.ctx.answerCbQuery;
    delete f.ctx.editMessageReplyMarkup;
    assert.equal(await f.ui.apply(f.ctx, 'q'), true);
    assert.equal(f.sent, 1);
    assert.equal(f.items.length, status === 'accepted' ? 0 : 1);
    if (status === 'unknown') assert.equal(dequeueNextTurn(f.items).turn, null);
    if (status === 'rejected') assert.equal(f.turn.steering, undefined);
  }
});
