import test from 'node:test';
import assert from 'node:assert/strict';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState,cloneRegionController} from '../src/semantic/regions.js';
import {encodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {validateRegionTrainingContexts,auditRegionServingCosts,encodeCausalLmV8Example} from '../src/semantic/causal-lm-v8.js';

const source='"use strict";function getter(){return 7;}function run(x){let before=x+1;'+
  'const key=Symbol("amount");const obj={};Object.defineProperty(obj,key,{get:getter});'+
  'let value=obj[key];let after=before+value;return after;}';
const clone=structuredClone;
function fresh(){const h=new RegionExecutionHarness({sessionId:'protocol-composition'});
  h.publishProgram({programId:'p',source,entry:'run'});
  h.admitInvocation({programId:'p',invocationId:'i',trackId:'t',realmId:'r',triggerId:'entry',args:[3]});return h;}
function allocate(name,extra={}){return {kind:'allocate',name,objectKind:'object',length:null,properties:[],
  code:null,captures:[],functionKind:null,lexicalReceiver:null,...extra};}
function begin(h,contexts=[]){
  const select=record=>{contexts.push(h.modelContext('i'));h.select('i',record);};
  const region=h.program('i').regions.find(row=>row.owner==='run'&&row.outputs.includes('before'));
  select(h.preview('i',region.id));
  for(const record of [
    {kind:'symbol.create',id:'o1',description:['str','amount']},
    allocate('o2'),allocate('o3',{objectKind:'closure',code:'getter',functionKind:'ordinary'}),
    {kind:'property.define',object:'o2',key:['symbol','o1'],success:true,
      descriptor:{kind:'accessor',get:['ref','o3'],set:['undefined'],enumerable:false,configurable:false}},
    {kind:'property.get.call',id:'access1',child:'get1',object:'o2',key:['symbol','o1'],receiver:['ref','o2']}
  ])select(encodeProtocolRecordV8(record));
  return contexts;
}
function finish(h,contexts=[]){
  const select=record=>{contexts.push(h.modelContext('i'));h.select('i',record);};
  select(encodeProtocolRecordV8({kind:'return',value:['num',7],invocation:'get1'}));
  select(encodeProtocolRecordV8({kind:'property.finish',id:'access1',completion:{kind:'normal',value:['num',7]}}));
  select({kind:'bind',fields:{name:'value',value:['num',7],invocation:'i'}});
  const region=h.program('i').regions.find(row=>row.owner==='run'&&row.outputs.includes('after'));
  select(h.preview('i',region.id));
  select(encodeProtocolRecordV8({kind:'end',completion:'return'}));
  return contexts;
}

test('compact arithmetic surrounds a Symbol getter in the same heap, receiver scope and public replay',async()=>{
  const h=fresh(),contexts=begin(h);
  assert.equal(contexts[0].state.protocol,null);
  const state=sharedRegionState(h.controller),heap=new Map(state.heap);
  assert.deepEqual(heap.get('o2').descriptors[0][0],['symbol','o1']);
  assert.deepEqual(h.controller.receiver,['ref','o2']);
  assert.equal(h.controller.protocol.pendingCalls[0].value,null);
  assert.equal(h.controller.heap,h.realms.get('r').heap);
  const staged=cloneRegionController(h.controller);
  assert(staged.heap.get('o2').descriptors instanceof Map);
  assert.notEqual(staged.heap,h.controller.heap);
  finish(h,contexts);
  assert.deepEqual(h.controller.completion,{kind:'return',value:['num',11]});
  assert.deepEqual(h.controller.receiver,['undefined']);
  assert.equal(h.controller.protocol.pendingCalls.length,0);
  const artifact={public:h.exportEpisode(),contexts};
  assert.equal(validateRegionTrainingContexts(artifact).length,contexts.length);
  assert.deepEqual(sharedRegionState(RegionExecutionHarness.replay(artifact).controller),sharedRegionState(h.controller));
  const cost=await auditRegionServingCosts(artifact);
  assert.equal(cost.predictions,contexts.length);
  assert(cost.rows.some(row=>row.recordKind==='protocol'&&row.detail));
});

test('a JSON checkpoint preserves a pending property call and rejects rehashed descriptor or scope changes',()=>{
  const h=fresh();begin(h);
  const packet=JSON.parse(JSON.stringify(h.checkpoint())),restored=RegionExecutionHarness.restore(packet);
  assert.equal(packet.selected.schema,'semantic-protocol-continuation/1');
  assert.deepEqual(restored.modelContext('i'),h.modelContext('i'));
  finish(restored);finish(h);
  assert.deepEqual(restored.exportEpisode(),h.exportEpisode());
  for(const mutate of [
    selected=>{selected.invocations[0][1].state.heap.find(([id])=>id==='o2')[1].descriptors[0][1].configurable=true;},
    selected=>{selected.invocations[0][1].state.protocol.callFrames[0].priorReceiver=['ref','o2'];},
    selected=>{selected.invocations[0][1].state.protocol.symbols.find(row=>row.id==='o1').description=['str','forged'];}
  ]){
    const forged=clone(packet);mutate(forged.selected);const {integrity,...body}=forged;
    forged.integrity=hashAlgorithmData(body);
    assert.throws(()=>RegionExecutionHarness.restore(forged),/exact public shared state/);
  }
});

test('scoped protocol transitions and host lifecycle reject incomplete authority atomically',()=>{
  const h=fresh();begin(h);const before=h.checkpoint();
  assert.throws(()=>h.select('i',{kind:'read',fields:{object:'o2',key:'amount',value:['num',7],invocation:'get1'}}),/bypass|field/);
  assert.throws(()=>h.select('i',{kind:'return',fields:{value:['num',7],invocation:'get1'}}),/scoped/);
  assert.throws(()=>h.select('i',encodeProtocolRecordV8({kind:'return',value:['num',7],invocation:'wrong'})),/active invocation/);
  assert.throws(()=>h.admitInvocation({}),/Invalid .*ID/);
  assert.throws(()=>h.admitInvocation({programId:'p',invocationId:'later',trackId:'t',realmId:'r',
    triggerId:'later',realmPolicy:'retained',args:[3]}),/active guest turn/);
  assert.throws(()=>h.registerEventHandler({}),/Invalid .*ID/);
  assert.deepEqual(h.checkpoint(),before);
});

test('protocol target bytes alone receive generated loss and neither source proof nor future state is added',async()=>{
  const h=fresh(),context=h.modelContext('i'),target=encodeProtocolRecordV8({kind:'symbol.create',id:'o1',description:['str','amount']});
  const encoded=await encodeCausalLmV8Example(context,target,{eosTokenId:256,maxContextTokens:100000,
    tokenizer:{identity:'a'.repeat(64),encode:text=>[...Buffer.from(text)],decode:ids=>Buffer.from(ids)}});
  assert.equal(encoded.recordKind,'protocol');
  assert.deepEqual(encoded.labels.slice(encoded.boundaries.promptTokens),[...Buffer.from(target),256]);
  assert(encoded.labels.slice(0,encoded.boundaries.promptTokens).every(value=>value===-100));
  assert(!encoded.prompt.includes('sourceArtifact'));
});
