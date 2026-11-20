import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {SelectedExecutionLifecycleV8} from '../src/semantic/lifecycle-v8.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';
import {decodeDetailedRecord} from '../src/semantic/detail-v8.js';

const copy=value=>JSON.parse(JSON.stringify(value));
function begin(source,capabilities,options={}){
  const {protocol=true,...harnessOptions}=options,
    host=new RegionExecutionHarness({sessionId:'recovery',automaticDelivery:false,...harnessOptions});
  host.publishProgram({programId:'program',source,entry:'run',capabilities});
  host.admitInvocation({programId:'program',invocationId:'root',realmId:'realm',trackId:'worker',
    triggerId:'start',realmPolicy:'retained',args:[]});
  host.select('root',{kind:'allocate',fields:{name:'anchor',kind:'object',properties:[]}});
  if(protocol)host.select('root',{kind:'property.define',object:'anchor',key:['str','marker'],success:true,
    descriptor:{kind:'data',value:['num',1],writable:true,enumerable:true,configurable:true}});
  return host;
}
function request(host,source,operation,args,payload,{effect='effect',promise='external'}={}){
  const {start,end}=analyzeSemanticProgram(source).sites.find(row=>row.operation===operation);
  host.select('root',{kind:'request',fields:{effect,operation,invocation:'root',site:{start,end},
    arguments:args,payload,promise}});
}
function finish(host,id,value=['undefined']){
  host.select(id,{kind:'return',fields:{value}});
  host.select(id,{kind:'end',fields:{kind:'return'}});
}
function external(){
  const source='"use strict";function run(){return host.natlangCall("x",null,null);}',
    host=begin(source,['natlang.call']),args=[['str','x'],['null'],['null']];
  request(host,source,'natlang.call',args,JSON.stringify({schema:'owned-graph/1',roots:args,objects:[]}));
  host.importObserved({mode:'observed',kind:'dispatch',fields:{session:'recovery',track:'worker',
    invocationId:'root',effectId:'effect',key:'root/effect',attempt:1}});
  return host;
}

test('mixed recovery derives duplicate result identity from exact observed scalar and graph semantics',()=>{
  const child=Object.create(null);child.negative=-0;child.nan=NaN;
  const graphValue={right:child,left:child};graphValue.self=graphValue;
  for(const value of [undefined,null,-0,NaN,7,graphValue])for(const status of ['fulfilled','rejected']){
    const host=external();host.deliverResult('root','effect',{status,value});
    const packet=copy(host.checkpoint()),restored=RegionExecutionHarness.restore(packet),
      before=restored.exportEpisode(),receipt=restored.intents.get('root/effect').result,
      decoded=decodeDetailedRecord(receipt.line,{role:'observed'}).fields;
    assert.equal(typeof restored.intents.get('root/effect').resultDigest,'string');
    assert.deepEqual(restored.deliverResult('root','effect',{status,value}),receipt);
    assert.deepEqual(restored.deliverResult('root','effect',{
      status,result:decoded.result,...(decoded.graph?{graph:decoded.graph}:{})}),receipt);
    assert.deepEqual(restored.exportEpisode(),before);
    assert.throws(()=>restored.deliverResult('root','effect',{status,value:'different'}),/Conflicting duplicate result/);
    assert.deepEqual(restored.exportEpisode(),before);
    if(decoded.graph){
      const changed=structuredClone(decoded.graph);changed.objects[0].properties.reverse();
      assert.throws(()=>restored.deliverResult('root','effect',{status,result:decoded.result,graph:changed}),
        /Conflicting duplicate result/);
      assert.deepEqual(restored.exportEpisode(),before);
    }
  }
});

test('closed realms retain an explicit terminal receipt across replay and mixed restoration',()=>{
  const host=external();host.deliverResult('root','effect',{status:'fulfilled',value:7});
  finish(host,'root',['num',7]);
  const premature={mode:'observed',kind:'realm-close',fields:{session:'recovery',track:'host',realmId:'realm',reason:'test close'}},
    before=host.checkpoint();
  assert.throws(()=>host.importObserved(premature),/cancellation receipts/);
  assert.deepEqual(host.checkpoint(),before);
  const closed=host.closeRealm('realm',{reason:'test close'}),episode=host.exportEpisode();
  assert.equal(closed.kind,'realm-close');assert.equal(episode.timeline.at(-1).kind,'realm-close');
  assert.deepEqual(host.closeRealm('realm',{reason:'already closed'}),closed);
  assert.deepEqual(host.exportEpisode(),episode);
  for(const recovered of [RegionExecutionHarness.replay(episode),RegionExecutionHarness.restore(copy(host.checkpoint()))]){
    assert.equal(recovered.realms.get('realm').closed,true);
    const checkpoint=recovered.checkpoint();
    assert.throws(()=>recovered.admitInvocation({programId:'program',invocationId:'later',trackId:'worker',
      realmId:'realm',triggerId:'later',realmPolicy:'retained',args:[]}),/Closed realm/);
    assert.throws(()=>recovered.registerEventHandler({subscriptionId:'late',programId:'program',
      realmId:'realm',trackId:'worker'}),/closed realm/);
    assert.throws(()=>recovered.inner.enqueueClosure({ownerInvocationId:'root',closureId:'fn'}),/closed/);
    assert.throws(()=>recovered.importObserved(premature),/closed/);
    assert.deepEqual(recovered.checkpoint(),checkpoint);
  }
});

async function callbacks(options={}){
  const source='"use strict";function run(){return host.listen("tick",handler);}function handler(value){return value;}',
    controls={},host=begin(source,['demo.listen'],{...options,services:{'demo.listen':(_,meta)=>{
      controls.fire=meta.callback(1);return meta.subscriptionId(1);
    }}});
  host.select('root',{kind:'allocate',fields:{name:'fn',kind:'closure',code:'handler',captures:[],properties:[]}});
  request(host,source,'demo.listen',[['str','tick'],['ref','fn']],
    '["tick",{"$ownedCallback":"fn"}]');
  await host.dispatch('root','effect');return {host,controls};
}

test('native callback counters expose only delivered IDs and reconstruct after JSON recovery',async()=>{
  const {host,controls}=await callbacks(),before=host.modelContext('root');
  controls.fire(11);controls.fire(22);
  assert.deepEqual(host.modelContext('root'),before,'buffered IDs and arguments are outside the public prefix');
  assert.equal(host.inner.callbacks.get('root/effect/1').sequence,0);
  assert.deepEqual(host.inner.handlers.get('callback1').queue.map(row=>row.eventId),['callbackevent1','callbackevent2']);
  assert.throws(()=>host.checkpoint(),/unjournaled native arrivals/);
  finish(host,'root');host.inner.deliverReadyEvents('callback1');host.sync();
  assert.equal(host.inner.callbacks.get('root/effect/1').sequence,1);
  finish(host,'event1',['num',11]);host.inner.deliverReadyEvents('callback1');host.sync();
  assert.equal(host.inner.callbacks.get('root/effect/1').sequence,2);
  const context=host.modelContext('event2'),replayed=RegionExecutionHarness.replay(host.exportEpisode(),{requireTerminal:false});
  assert.deepEqual(replayed.modelContext('event2'),context);
  const restored=RegionExecutionHarness.restore(copy(host.checkpoint()));
  assert.equal(restored.inner.callbacks.get('root/effect/1').sequence,2);
  assert.deepEqual([...restored.handlers.get('callback1').seen],['callbackevent1','callbackevent2']);
  finish(host,'event2',['num',22]);controls.fire(33);host.sync();
  assert.equal(host.inner.callbacks.get('root/effect/1').sequence,3);
  assert.equal(host.timeline.findLast(row=>row.kind==='event').fields.eventId,'callbackevent3');
  host.closeRealm('realm');
  const closed=RegionExecutionHarness.restore(copy(host.checkpoint()));
  let attaches=0;
  assert.throws(()=>closed.inner.reattachSubscription('callback1',{evidenceId:'late',attach(){attaches++;}}),/reattachment|closed/);
  assert.equal(attaches,0);
  assert.throws(()=>closed.postEvent({subscriptionId:'callback1',eventId:'late',args:[]}),/closed/);
  assert.throws(()=>controls.fire(44),/revoked/);
});

test('direct lifecycle recovery rejects rehashed closure, callback counter and result identity changes',async()=>{
  const {host,controls}=await callbacks({protocol:false});finish(host,'root');controls.fire(1);host.sync();
  finish(host,'event1',['num',1]);host.closeRealm('realm');
  const original=copy(host.inner.checkpoint());
  assert.equal(SelectedExecutionLifecycleV8.restore(original).realms.get('realm').closed,true);
  for(const change of [
    packet=>{packet.realms[0][1].closed=false;},
    packet=>{packet.callbacks[0][1].sequence=0;},
    packet=>{packet.intents[0][1].resultDigest='0'.repeat(64);}
  ]){
    const forged=structuredClone(original);change(forged);
    const {integrity,...body}=forged;forged.integrity=createHash('sha256').update(JSON.stringify(body)).digest('hex');
    assert.throws(()=>SelectedExecutionLifecycleV8.restore(forged),/realm ownership|callback counter|result identity/);
  }
});
