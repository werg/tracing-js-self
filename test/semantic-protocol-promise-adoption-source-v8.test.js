import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createRuntime} from '../src/runtime.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {PROTOCOL_SOURCE_ADAPTERS_V8} from '../src/semantic/protocol-source-extensions-v8.js';
import {independentProtocolSourceReference} from '../src/semantic/protocol-source-reference-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {decodeProtocolRecordV8,encodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';

const fifo='let order="";let settle;const target=new Promise(resolve=>{settle=resolve;});const outer=new Promise(resolve=>resolve(target));outer.then(()=>{order+="a";});target.then(()=>{order+="d";});settle(7);queueMicrotask(()=>{order+="q";});await outer;return order;';
const cases=[
  ['settled-executor','const p=new Promise(resolve=>resolve(Promise.resolve(5)));return await p;',['num',5]],
  ['pending-executor','let done;const a=new Promise(resolve=>{done=resolve;});const b=new Promise(resolve=>resolve(a));done(7);return await b;',['num',7]],
  ['source-fifo-microtask',fifo,['str','dqa']],
  ['pending-forwarding-before-microtask-settlement',
    fifo.replace('settle(7);queueMicrotask(()=>{order+="q";});','queueMicrotask(()=>{order+="q";settle(7);});'),['str','qda']],
  ['rejected-executor','const target=Promise.reject(7);const outer=new Promise(resolve=>resolve(target));return await outer.then(undefined,x=>x+1);',['num',8]],
  ['root-async-result','return new Promise(resolve=>resolve(3));',['num',3]],
  ['nested-async-result','async function f(){return Promise.resolve(9);}return await f();',['num',9]],
  ['reaction-result','const p=Promise.resolve(1).then(x=>new Promise(resolve=>resolve(x)));return await p;',['num',1]],
  ['reaction-fifo-chain','let order="";const p=Promise.resolve(1).then(x=>new Promise(resolve=>resolve(x)));p.then(()=>{order+="p";});Promise.resolve().then(()=>{order+="a";}).then(()=>{order+="b";}).then(()=>{order+="c";});await p;return order;',['str','abcp']],
  ['late-resolver-and-throw','let done;const target=new Promise(resolve=>{done=resolve;});const p=new Promise((resolve,reject)=>{resolve(target);resolve(99);reject(91);throw 92;});done(8);return await p;',['num',8]],
  ['executor-self-ignored-error','let done;const p=new Promise(resolve=>{done=resolve;});done(p);return await p.then(undefined,()=>9);',['num',9]],
  ['reaction-self-ignored-error','let p;p=Promise.resolve().then(()=>p);return await p.then(undefined,()=>9);',['num',9]],
  ['reaction-join-result','const p=Promise.resolve(1).then(x=>Promise.all([Promise.resolve(x+1)]));return (await p)[0];',['num',2]],
  ['nested-async-receiver','const o={x:3,async m(){await 0;return new Promise(resolve=>resolve(this.x));}};return await o.m();',['num',3]],
  ['rejected-async-result','async function f(){return Promise.reject(4);}return await f().then(undefined,x=>x+1);',['num',5]]
];
const fixture=(name,body)=>({source:'"use strict";async function run(){'+body+'}',entry:'run',args:[],family:'promise-adoption:'+name});
const artifacts=[];let nativeReceipts=[],cutCount=0;
if(process.env.REQUIRE_PROMISE_ADOPTION_V8==='1')assert(process.env.MEGATOKEN_ROOT,'Mandatory adoption gate needs the exact native checkout');
for(const [name,body,expected]of cases)test('independent original source and public adoption: '+name,async()=>{
  const input=fixture(name,body),result=await verifyProtocolRegionTrainingCase(input);assert(result.exported,result.reason);
  const replay=RegionExecutionHarness.replay(result.exported);
  assert.deepEqual(replay.controller.completion.value,expected);
  assert.equal(result.exported.sidecar.sourceArtifact.sidecar.reference.status,'agreed');
  assert.equal((await recheckProtocolRegionEvidence(result.exported)).sourceValidated,true);
  if(name==='pending-forwarding-before-microtask-settlement'){
    const enter=result.exported.public.timeline.filter(row=>row.kind==='protocol')
      .map(row=>decodeProtocolRecordV8(row.fields.line)).find(row=>row.kind==='promise.adopt.enter');
    const contexts=result.exported.contexts,waiting=contexts.find(row=>new Map(row.state.jobs).get(enter.forwarding)?.status==='waiting');
    assert(waiting,'the original target must still be pending when forwarding subscribes');
    assert.equal(new Map(waiting.state.heap).get(enter.target).state,'pending');
    const direct=waiting.state.jobs.find(([,job])=>job.promise===enter.target&&job.reaction==='then')?.[0],
      adopter=waiting.state.jobs.find(([,job])=>job.promise===enter.promise&&job.reaction==='then')?.[0],
      awaiting=waiting.state.continuations.find(([,continuation])=>continuation.promise===enter.promise)?.[0];
    assert(direct&&adopter&&awaiting);
    assert(contexts.some(({state})=>state.ready.includes(enter.forwarding)&&state.ready.includes(direct)&&
      state.ready.indexOf(direct)<state.ready.indexOf(enter.forwarding)));
    assert(contexts.some(({state})=>state.ready.includes(adopter)&&state.ready.includes(awaiting)&&
      state.ready.indexOf(adopter)<state.ready.indexOf(awaiting)));
  }
  artifacts.push({name,input,exported:result.exported,state:sharedRegionState(replay.controller)});
});
test('source ownership and identities are independent of registry order',()=>{
  const input=fixture('registry',fifo),runtime=createRuntime().startEntry({text:input.source,functionName:'run',args:[],allowAsync:true});
  assert.equal(runtime.drive().kind,'terminated');const bundle=runtime.exportRun();
  const forward=compileProtocolSourceV8(bundle),reverse=compileProtocolSourceV8(bundle,{adapters:[...PROTOCOL_SOURCE_ADAPTERS_V8].reverse()});
  assert.deepEqual(reverse,forward);
  const records=forward.claims.filter(row=>row.kind==='protocol').map(row=>row.record);
  const index=records.findIndex(row=>row.kind==='promise.adopt.enqueue');
  assert.equal(records[index-1].kind,'promise.resolver.call');
  assert(records.some(row=>row.kind==='promise.adopt.enter'));assert(records.some(row=>row.kind==='promise.adopt.forward'));
});
test('every source adoption, original completion and first-call cut restores exact public continuation',()=>{
  assert.equal(artifacts.length,cases.length);
  for(const {exported,state}of artifacts){
    const timeline=exported.public.timeline;
    const cuts=timeline.flatMap((row,index)=>{
      if(row.kind!=='protocol')return [];
      const kind=decodeProtocolRecordV8(row.fields.line).kind;
      return kind.startsWith('promise.adopt.')||['promise.resolver.call','promise.reaction.complete','async.complete'].includes(kind)?[index+1]:[];
    });
    for(const cut of cuts){
      const prefix=RegionExecutionHarness.replay({...exported.public,timeline:timeline.slice(0,cut)},{requireTerminal:false}),
        resumed=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(prefix.checkpoint())));
      for(const row of timeline.slice(cut))resumed.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
      assert.deepEqual(sharedRegionState(resumed.controller),state);cutCount++;
    }
  }
});
test('source recheck refuses changed adoption targets, original source and an invented current-event certificate',async()=>{
  const base=artifacts.find(row=>row.name==='pending-executor').exported;
  for(const mutate of [
    artifact=>{const row=artifact.public.timeline.find(row=>row.kind==='protocol'&&decodeProtocolRecordV8(row.fields.line).kind==='promise.adopt.enqueue'),
      record=decodeProtocolRecordV8(row.fields.line);record.target=record.promise;row.fields.line=encodeProtocolRecordV8(record);},
    artifact=>{const input=artifact.sidecar.sourceArtifact.sidecar.referenceInput;input.source=input.source.replace('done(7)','done(17)');},
    artifact=>{const claim=artifact.sidecar.sourceArtifact.sidecar.compiler.claims.find(row=>row.record?.kind==='promise.adopt.enqueue');
      claim.certificate.journalEvents=['invented-resolution-event'];}
  ]){const changed=structuredClone(base);mutate(changed);await assert.rejects(recheckProtocolRegionEvidence(changed));}
});
test('independent native queueMicrotask order changes with actual source scheduling and retains its process deadline',async()=>{
  const source=fixture('reference-order',fifo).source,
    moved=source.replace('settle(7);queueMicrotask(()=>{order+="q";});','queueMicrotask(()=>{order+="q";});settle(7);'),
    input={entry:'run',inputGraph:encodeNativeGraph([]),awaitReturnedPromise:true,mode:'original'};
  for(const [text,expected]of [[source,'dqa'],[moved,'qda']]){
    const result=await independentProtocolSourceReference({...input,source:text});
    assert.equal(result.outcome.kind,'return');assert.deepEqual(result.outcome.graph.roots.at(-1),['str',expected]);
  }
  await assert.rejects(independentProtocolSourceReference({...input,
    source:'async function run(){return await new Promise(resolve=>queueMicrotask(()=>{for(;;){}}));}'},
    {timeoutMs:1000}),/deadline exceeded/);
});
test('unqualified then lookup, async callback activation, reflected self Error and pending cycles remain source refusals',async()=>{
  for(const body of [
    'const p=Promise.resolve(1);p.then=()=>7;return await new Promise(resolve=>resolve(p));',
    'const p=Promise.resolve(1);Object.defineProperty(p,"then",{get(){return ()=>7;}});return await new Promise(resolve=>resolve(p));',
    'Promise.prototype.then=function(){return 7;};return await new Promise(resolve=>resolve(Promise.resolve(1)));',
    'const p=Promise.resolve(1);Object.setPrototypeOf(p,null);return await new Promise(resolve=>resolve(p));',
    'return await new Promise(resolve=>resolve({then(done){done(3);}}));',
    'return await Promise.resolve(1).then(async x=>x);',
    'let done;const p=new Promise(resolve=>{done=resolve;});done(p);try{return await p;}catch(e){return e.name;}',
    'let a,b;const p=new Promise(resolve=>{a=resolve;});const q=new Promise(resolve=>{b=resolve;});a(q);b(p);return await p;'
  ]){const result=await verifyProtocolRegionTrainingCase(fixture('refused',body));assert.equal(result.exported,undefined,body);}
});
test('actual native adoption consumer independently replays every source context and restored cut',
  {skip:!process.env.MEGATOKEN_ROOT},()=>{
  assert.equal(artifacts.length,cases.length);
  const root=resolve(process.env.MEGATOKEN_ROOT),script=`
import json,sys
from megatoken.data.native_v8 import validate_v8_artifact,_replay_shared_state
out=[]
for row in json.load(sys.stdin):
    artifact=row['exported']
    receipt=validate_v8_artifact(artifact)
    assert receipt['admitted'] is False
    assert all(receipt['checks'][key]=='passed' for key in ['replay','contexts','continuation'])
    state=_replay_shared_state(artifact['public']['timeline'],artifact['contexts'],{},roundtrip=True,boundary_invocation='invocation1')['state']
    assert state==row['state']
    out.append({'name':row['name'],'counts':receipt['counts']})
print(json.dumps(out))
`;
  const result=spawnSync(process.env.MEGATOKEN_PYTHON||'python',['-c',script],{cwd:root,
    env:{...process.env,PYTHONPATH:join(root,'src')},input:JSON.stringify(artifacts),encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
  assert.equal(result.status,0,result.stderr||String(result.error));nativeReceipts=JSON.parse(result.stdout);
  assert.equal(nativeReceipts.length,cases.length);
});
after(()=>{
  if(!process.env.RUNNER_TEMP)return;
  writeFileSync(join(process.env.RUNNER_TEMP,'promise-adoption-source-evidence.json'),JSON.stringify({
    schema:'promise-adoption-source-evidence/1',sourceCases:artifacts.length,actualNativeCases:nativeReceipts.length,
    snapshotCuts:cutCount,generatedContexts:artifacts.reduce((sum,row)=>sum+row.exported.contexts.length,0),
    nativeReceipts,moduleAdmission:false,trainingAdmission:false,optimizerUpdates:0,cases:artifacts}));
});
