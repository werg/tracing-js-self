import test from 'node:test';
import assert from 'node:assert/strict';
import {SelectedExecutionLifecycleV8 as Lifecycle} from '../src/semantic/lifecycle-v8.js';
import {RegionExecutionHarness as Region} from '../src/semantic/region-harness.js';
import {encodeDetailedRecord} from '../src/semantic/detail-v8.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';

const copy=value=>JSON.parse(JSON.stringify(value));
const select=(h,id,kind,fields)=>h instanceof Region?h.select(id,{kind,fields}):
  h.selected(id,encodeDetailedRecord({kind,fields}));
const core=h=>h instanceof Region?h.inner:h;
const site=(source,operation)=>{
  const {start,end}=analyzeSemanticProgram(source).sites.find(row=>row.operation===operation);
  return {start,end};
};
function begin(h,source,capabilities){
  h.publishProgram({programId:'p',source,entry:'run',capabilities});
  h.admitInvocation({programId:'p',invocationId:'call',trackId:'worker',realmId:'realm',
    triggerId:'outside',realmPolicy:'retained'});
}
async function uncertain(t,H=Lifecycle){
  const source='"use strict";function run(){return host.readNumber("x");}';
  let release;
  const h=new H({services:{'demo.readNumber':()=>new Promise(resolve=>{release=resolve;})}});
  begin(h,source,['demo.readNumber']);
  select(h,'call','request',{effect:'e',operation:'demo.readNumber',invocation:'call',
    arguments:[['str','x']],site:site(source,'demo.readNumber'),payload:'["x"]'});
  const pending=h.dispatch('call','e');
  for(let index=0;index<20&&!release;index++)await Promise.resolve();
  assert.equal(typeof release,'function');
  t.after(async()=>{release(7);await pending;});
  return H.restore(copy(h.checkpoint()));
}
function rawPrefix(h,count){
  const data=core(h).exportEpisode();data.public.timeline.length=count;
  return Lifecycle.replay(data,{requireTerminal:false});
}

test('invalid reconciled results leave public receipts and shared selected state unchanged',async t=>{
  for(const H of [Lifecycle,Region]){
    const h=await uncertain(t,H),before=copy(h.checkpoint());
    for(const options of [
      {result:['ref','missing']},
      {result:['ref','new'],graph:{objects:[],roots:[['ref','new']]}},
      {result:['num',7],graph:{objects:[],roots:[['num',8]]}},
      {result:['not-a-tag',7]}
    ]){
      assert.throws(()=>h.reconcile('call','e',{disposition:'fulfilled',evidenceId:'receipt',...options}));
      assert.deepEqual(copy(h.checkpoint()),before);
      assert.equal(h.intents.get('call/e').status,'uncertain');
    }
    h.reconcile('call','e',{disposition:'fulfilled',value:7,evidenceId:'receipt'});
    assert.deepEqual(core(h).timeline.slice(-2).map(row=>row.kind),['reconcile','result']);
    assert.equal(h.intents.get('call/e').status,'settled');
    select(h,'call','return',{value:['num',7]});select(h,'call','end',{kind:'return'});
    const replayed=H.replay(h.exportEpisode());
    assert.deepEqual(replayed.exportEpisode(),h.exportEpisode());
  }
});

test('reconciliation replay binds owner and requires the immediately matching result',async t=>{
  const h=await uncertain(t);
  h.reconcile('call','e',{disposition:'fulfilled',value:7,evidenceId:'external-batch-receipt'});
  const receipt=h.timeline.at(-2),result=h.timeline.at(-1);
  for(const changes of [{track:'other'},{evidenceId:''},{evidenceId:null},{disposition:'maybe'}]){
    const waiting=rawPrefix(h,receipt.sequence-1),before=copy(waiting.checkpoint());
    assert.throws(()=>waiting.replayRecord({...copy(receipt),...changes}),/reconcil|evidence/i);
    assert.deepEqual(copy(waiting.checkpoint()),before);
  }
  for(const changes of [{invocationId:'other'},{effectId:'other'},{status:'rejected'}]){
    const waiting=rawPrefix(h,receipt.sequence),before=copy(waiting.checkpoint());
    assert.throws(()=>waiting.replayRecord({...copy(result),...changes}),/matching observed result/i);
    assert.deepEqual(copy(waiting.checkpoint()),before);
  }
  const waiting=rawPrefix(h,receipt.sequence),before=copy(waiting.checkpoint()),
    interruption={...copy(receipt),sequence:receipt.sequence+1,ownerSequence:receipt.ownerSequence+1,
      disposition:'lost'};
  assert.throws(()=>waiting.replayRecord(interruption),/matching observed result/i);
  assert.deepEqual(copy(waiting.checkpoint()),before);
  const restored=Lifecycle.restore(copy(waiting.checkpoint()));
  restored.replayRecord(copy(result));
  assert.equal(restored.intents.get('call/e').status,'settled');
  assert.deepEqual(restored.timeline,h.timeline);
});

test('lost and not-dispatched receipts remain explicit, with retries incrementing the same intent',async t=>{
  const h=await uncertain(t);
  h.reconcile('call','e',{disposition:'not-dispatched',evidenceId:'service-query'});
  assert.equal(h.intents.get('call/e').status,'committed');
  let calls=0;h.services={'demo.readNumber':()=>{calls++;return 9;}};
  await h.dispatch('call','e');
  assert.equal(calls,1);
  assert.deepEqual(h.timeline.filter(row=>row.kind==='dispatch').map(row=>row.attempt),[1,2]);
  assert.equal(Lifecycle.replay(h.exportEpisode(),{requireTerminal:false}).intents.get('call/e').status,'settled');
  const lost=await uncertain(t);
  lost.reconcile('call','e',{disposition:'lost',evidenceId:'service-query'});
  assert.throws(()=>lost.dispatch('call','e'),/uncertain|committed/);
  assert.throws(()=>lost.deliverResult('call','e',{status:'fulfilled',value:1}),/uncommitted/);
  assert.equal(Lifecycle.replay(lost.exportEpisode(),{requireTerminal:false}).intents.get('call/e').status,'lost');
});

async function retiredBoundary(H,operation,status){
  const source='"use strict";function run(){return host.'+operation.slice(5)+
    '("tick",handler);}function handler(value){return value;}';
  const h=new H({services:{[operation]:()=>{if(status==='rejected')throw Error('failed');}}});
  begin(h,source,[operation]);
  select(h,'call','allocate',{name:'fn',kind:'closure',code:'handler',captures:[],properties:[]});
  select(h,'call','request',{effect:'registration',operation,invocation:'call',
    arguments:[['str','tick'],['ref','fn']],site:site(source,operation),
    payload:'["tick",{"$ownedCallback":"fn"}]',promise:'registration'});
  await h.dispatch('call','registration');
  const exported=h.exportEpisode(),timeline=H===Region?exported.timeline:exported.public.timeline;
  timeline.length=timeline.findIndex(row=>row.kind==='result')+1;
  return H.replay(exported,{requireTerminal:false});
}

test('JSON restore preserves closing handlers and cannot revive revoked call or failed callbacks',async()=>{
  for(const H of [Lifecycle,Region])for(const [operation,status] of [
    ['demo.withCallback','fulfilled'],['demo.withCallback','rejected'],['demo.listen','rejected']
  ]){
    const boundary=await retiredBoundary(H,operation,status);
    assert.equal(core(boundary).handlers.get('callback1').state,'closing');
    const restored=H.restore(copy(boundary.checkpoint())),host=core(restored),before=copy(restored.checkpoint());
    assert.equal(host.handlers.get('callback1').state,'closing');
    assert.equal(host.callbacks.get('call/registration/1').state,'revoked');
    let attaches=0;
    assert.throws(()=>host.reattachSubscription('callback1',{
      evidenceId:'service-query',attach(){attaches++;}
    }),/reattachment|revoked/);
    assert.equal(attaches,0);
    assert.deepEqual(copy(restored.checkpoint()),before);
    const forged={schema:host.contract.executionVersion,session:host.sessionId,
      sequence:host.globalSequence+1,ownerSequence:host.ownerSequences.get('worker')+1,
      track:'worker',mode:'observed',kind:'callback-reattach',
      subscriptionId:'callback1',realmId:'realm',evidenceId:'service-query'};
    assert.throws(()=>host.replayRecord(forged),/closed|revoked/);
    assert.deepEqual(copy(restored.checkpoint()),before);
    assert.throws(()=>host.postEvent({subscriptionId:'callback1',eventId:'late',args:[1]}),/closed/);
    assert.deepEqual(host.timeline,before.timeline??before.selected.timeline);
    assert.equal(host.deliveries.at(-1).status,'quarantined');
  }
});

test('reattachment replay requires exact resource ownership and nonempty external evidence',async()=>{
  const h=await retiredBoundary(Lifecycle,'demo.listen','fulfilled'),
    restored=Lifecycle.restore(copy(h.checkpoint()));
  let receive;
  restored.reattachSubscription('callback1',{evidenceId:'existing-resource',attach:fn=>{receive=fn;}});
  assert.equal(typeof receive,'function');
  const receipt=restored.timeline.at(-1);
  for(const changes of [{track:'other'},{realmId:'other'},{evidenceId:''},{evidenceId:null}]){
    const waiting=rawPrefix(restored,receipt.sequence-1),before=copy(waiting.checkpoint());
    assert.throws(()=>waiting.replayRecord({...copy(receipt),...changes}),/reattach|evidence/i);
    assert.deepEqual(copy(waiting.checkpoint()),before);
  }
  assert.equal(Lifecycle.replay(restored.exportEpisode(),{requireTerminal:false})
    .handlers.get('callback1').state,'active');
});
