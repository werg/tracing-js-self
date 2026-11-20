import test from 'node:test';
import assert from 'node:assert/strict';
import {applyProtocolRecordV8,createProtocolStateV8,restoreProtocolStateV8} from '../src/semantic/protocol-state-v8.js';
import {encodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {validateRegionTrainingContexts} from '../src/semantic/causal-lm-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

const ref=id=>['ref',id];
function fixture(){
  const controller={heap:new Map(),locals:new Map(),captureAliases:new Map(),receiver:['undefined'],stack:['root'],
    frameFunctions:new Map([['root','run']]),pending:null,lastReturn:null,completion:null,protocol:createProtocolStateV8(),
    jobs:new Map(),ready:[],scheduler:{registration:0,ready:0},activeJob:null,continuations:new Map()};
  return {controller,apply:record=>applyProtocolRecordV8(controller,record)};
}
const closure=(name,binding,cell)=>({kind:'allocate',name,objectKind:'closure',length:null,properties:[],code:name,
  captures:[{binding,cell}],functionKind:'ordinary',lexicalReceiver:null});
const call=(callee,child)=>({kind:'call',callee:ref(callee),child,receiver:['undefined'],arguments:[]});

test('closures retain uninitialized cells without values and calls reject them transactionally',()=>{
  const {controller,apply}=fixture();apply(closure('read','value','late'));
  assert.equal(controller.locals.has('late'),false);
  assert.deepEqual(controller.heap.get('read').captures,[{binding:'value',cell:'late'}]);
  assert.equal(restoreProtocolStateV8(controller,controller.protocol).valid,true);
  const before=structuredClone(controller);
  assert.throws(()=>apply(call('read','early')),/capture is not initialized/);
  assert.deepEqual(controller,before);
  apply({kind:'bind',name:'late',value:['undefined']});apply(call('read','ready'));
  assert.deepEqual(controller.captureAliases,new Map([['value','late']]));
  const forged=structuredClone(controller);forged.locals.delete('late');
  assert.throws(()=>restoreProtocolStateV8(forged,forged.protocol),/active closure capture is not initialized/);
});

test('nested closure captures keep their canonical live cell through caller alias restoration',()=>{
  const {controller,apply}=fixture();apply(closure('outer','value','late'));
  apply({kind:'bind',name:'late',value:['num',7]});apply(call('outer','outerCall'));
  apply(closure('inner','nested','value'));
  assert.deepEqual(controller.heap.get('inner').captures,[{binding:'nested',cell:'late'}]);
  apply({kind:'return',invocation:'outerCall',value:ref('inner')});
  apply({kind:'bind',name:'late',value:['num',9]});apply(call('inner','innerCall'));
  apply({kind:'compute',expr:{op:'local',name:'nested'},result:['num',9],bind:null});
  assert.equal(restoreProtocolStateV8(controller,controller.protocol).valid,true);
});

test('source hoisted closures expose only initialized capture values at each causal cutoff and checkpoint',async()=>{
  const source='"use strict";function run(){const marker=Symbol("capture");function read(){return value;}let value=7;const first=read();value=9;return first+read();}',
    result=await verifyProtocolRegionTrainingCase({source,entry:'run',args:[],family:'hoisted-capture',timeoutMs:30000});
  assert(result.exported,result.reason);const artifact=result.exported;
  const allocationIndex=artifact.public.timeline.findIndex(row=>row.fields?.line?.includes('"code":"read"')&&row.fields.line.includes('"kind":"allocate"'));
  assert(allocationIndex>0);
  const cut=allocationIndex+1,prefix={...artifact.public,timeline:artifact.public.timeline.slice(0,cut)},
    partial=RegionExecutionHarness.replay(prefix,{requireTerminal:false}),
    [identity,object]=[...partial.controller.heap].find(([,node])=>node.kind==='closure'&&node.code==='read'),cell=object.captures[0].cell;
  assert.equal(partial.controller.locals.has(cell),false);
  assert(artifact.contexts.some(context=>context.state.heap.some(([id])=>id===identity)&&!context.state.locals.some(([name])=>name===cell)));
  assert.equal(validateRegionTrainingContexts(artifact).length,artifact.contexts.length);
  const packet=JSON.parse(JSON.stringify(partial.checkpoint())),restored=RegionExecutionHarness.restore(packet),before=restored.checkpoint();
  assert.throws(()=>restored.select('invocation1',encodeProtocolRecordV8(call(identity,'early'))),/capture is not initialized/);
  assert.deepEqual(restored.checkpoint(),before);
  const forged=structuredClone(packet);forged.selected.invocations[0][1].state.locals.push([cell,['num',7]]);
  const {integrity,...body}=forged;forged.integrity=hashAlgorithmData(body);
  assert.throws(()=>RegionExecutionHarness.restore(forged),/exact public shared state/);
  for(const row of artifact.public.timeline.slice(cut))restored.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  assert.deepEqual(restored.exportEpisode(),artifact.public);
  assert.deepEqual(restored.controller.completion,{kind:'return',value:['num',16]});
  assert.equal((await recheckProtocolRegionEvidence(artifact)).sourceValidated,true);
});

test('source distinguishes initialized undefined captures from unsupported early TDZ calls',async()=>{
  for(const [body,accepted]of [
    ['function read(){return later;}let later;return read();',true],
    ['function read(){return later;}const value=read();let later=7;return value;',false]
  ]){
    const result=await verifyProtocolRegionTrainingCase({source:'"use strict";function run(){const marker=Symbol("capture");'+body+'}',entry:'run',args:[],
      family:'hoisted-capture-tdz',timeoutMs:30000});
    if(accepted){assert(result.exported,result.reason);assert.deepEqual(RegionExecutionHarness.replay(result.exported).controller.completion,
      {kind:'return',value:['undefined']});}
    else{assert.equal(result.status,'unsupported');assert(!result.exported);assert.match(result.reason,/capture is not initialized/);}
  }
});
