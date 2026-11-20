// Orchestration/recovery controls with an explicit supplied decoder. The native
// adapter separately tests actual CPU model reconstruction; no learned claim is
// made by these deterministic records.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {RegionSelectedModelDriver} from '../src/semantic/selected-execution-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {encodeDetailedRecord} from '../src/semantic/detail-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';

const copy=structuredClone;
const identity={schema:'semantic-inference-identity/8',checkpointIdentity:'c'.repeat(64),
  tokenizerIdentity:'e'.repeat(64),seed:17,
  generationSettings:{device:'cpu',maxTokens:128,maxFragments:8,effort:1}};
const policy={checkpointIdentity:identity.checkpointIdentity,tokenizerIdentity:identity.tokenizerIdentity,
  nativeIdentity:identity,hostLimits:{maxGenerated:4096,maxOutstanding:64},
  automaticDelivery:true,maxSelections:16,maxOutstanding:4,maxStaleRetries:2};
const seal=body=>({...body,digest:hashAlgorithmData(body)});
const line=(kind,fields)=>encodeDetailedRecord({kind,fields});
const site=(source,operation)=>{
  const {start,end}=analyzeSemanticProgram(source).sites.find(row=>row.operation===operation);return {start,end};
};
function suppliedSelector(choose){
  let attempts=[],modelAttempts=[],sessions={},restoreCalls=0,closed=false;
  const select=async request=>{
    const record=choose(request),payloadHex=Buffer.from(record).toString('hex');
    const selection={modelSelected:true,origin:'actual-model-selected',selectionId:'v8:'+attempts.length,
      session:request.session,invocationId:request.context.invocationId,
      checkpointIdentity:identity.checkpointIdentity,tokenizerIdentity:identity.tokenizerIdentity,
      prefixDigest:request.context.prefixDigest,contextDigest:hashAlgorithmData(request.context),payloadHex,
      fragments:[{tokenIds:[...Buffer.from(record)],payloadHex}]};
    attempts.push({attempt:attempts.length,session:request.session,invocationId:request.context.invocationId,
      record,selection:copy(selection),status:'decoded'});
    modelAttempts.push({...copy(selection),status:'awaiting-commit'});
    sessions[request.session]??={public:copy(request.public),contexts:copy(request.contexts),
      unacknowledgedSelection:null};
    return {record,selection};
  };
  select.commit=async request=>{
    RegionExecutionHarness.replay(request.public,{requireTerminal:false});
    const index=Number(request.selection.selectionId.split(':')[1]);
    attempts[index].status='accepted';modelAttempts[index].status='committed';
    sessions[request.session]={public:copy(request.public),contexts:copy(request.contexts),unacknowledgedSelection:null};
    return {schema:'semantic-native-commit/8',committed:true,selectionId:request.selection.selectionId,
      publicDigest:hashAlgorithmData(request.public)};
  };
  select.complete=async request=>{
    sessions[request.session].public=copy(request.public);
    return {completed:true};
  };
  select.reject=async request=>{
    const index=Number(request.selectionId.split(':')[1]);
    attempts[index].status='rejected';modelAttempts[index].status='semantic-rejected';
    return {rejected:true};
  };
  select.cancel=async()=>({closed:true});
  select.checkpoint=async()=>{
    const native=seal({schema:'semantic-model-checkpoint/8',equivalence:'verified-model-reexecution',
      initialization:identity,attempts:copy(modelAttempts),sessions:copy(sessions)});
    return seal({schema:'semantic-native-transport-checkpoint/8',identity,native,attempts:copy(attempts),
      runtimeMetrics:{rpcCalls:0,computeSeconds:0,peakMemoryBytes:0}});
  };
  select.restore=async({checkpoint})=>{
    restoreCalls++;assert.equal(attempts.length,0);
    attempts=copy(checkpoint.attempts);modelAttempts=copy(checkpoint.native.attempts);sessions=copy(checkpoint.native.sessions);
    return {restored:true,hostDispatches:0,transportCheckpointDigest:checkpoint.digest};
  };
  select.close=()=>{closed=true;};
  select.controls=()=>({restoreCalls,closed,attempts:copy(attempts)});
  return select;
}
function begin(source,services={},realmPolicy='fresh',limits={}){
  const harness=new RegionExecutionHarness({services,automaticDelivery:true,...limits});
  harness.publishProgram({programId:'p',source,entry:'run',capabilities:[...new Set(
    analyzeSemanticProgram(source).sites.map(row=>row.operation).filter(value=>value?.startsWith('demo.')))]});
  harness.admitInvocation({programId:'p',invocationId:'call',trackId:'t',realmId:'r',triggerId:'outside',realmPolicy});
  return harness;
}
async function until(predicate){
  for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setImmediate(resolve));}
  assert.fail('Expected execution boundary was not reached');
}
async function finish(driver,id){
  const result=await driver.runInvocation(id);if(result.taskCompletion)await result.taskCompletion;
  await until(()=>!driver.running.size);return result;
}

test('driver recovery joins acknowledged model state to uncertain host work without redispatch',async()=>{
  const source='"use strict";function run(){return host.readNumber("x");}';
  const records=[line('request',{effect:'e',operation:'demo.readNumber',invocation:'call',
    arguments:[['str','x']],site:site(source,'demo.readNumber'),payload:'["x"]'}),
  line('return',{value:['num',7]}),line('end',{kind:'return'})];
  const choose=request=>records[request.public.timeline.filter(row=>row.mode==='generated').length];
  let calls=0,resolveHost;
  const limits={...policy,hostLimits:{maxGenerated:8,maxOutstanding:1}};
  const bridge=begin(source,{'demo.readNumber':()=>{calls++;return new Promise(resolve=>{resolveHost=resolve;});}},
    'fresh',limits.hostLimits);
  const select=suppliedSelector(choose),driver=new RegionSelectedModelDriver({select,harness:bridge,...limits});
  const abort=new AbortController(),running=driver.runInvocation('call',{signal:abort.signal});
  void running.catch(()=>{});
  await until(()=>calls===1);
  const packet=JSON.parse(JSON.stringify(await driver.checkpoint()));
  const session=packet.bridge.public.timeline[0].fields.session;
  assert.equal(packet.attempts.length,1);
  assert.equal(packet.native.native.sessions[session].public.timeline.at(-1).mode,'generated');
  assert.equal(packet.bridge.public.timeline.at(-1).kind,'dispatch');
  abort.abort(new Error('simulated process loss'));await assert.rejects(running,/simulated process loss/);
  const next=suppliedSelector(choose);
  const restored=await RegionSelectedModelDriver.restore(packet,{select:next,policy:limits,
    harnessOptions:{services:{'demo.readNumber':()=>{calls++;return 99;}}}});
  try{
    assert.equal(restored.bridge.inner.intents.get('call/e').status,'uncertain');
    await assert.rejects(restored.bridge.dispatch('call','e'),/uncertain|reconcil|committed/);
    assert.equal(calls,1);assert.equal(restored.metrics().predictionAttempts,1);
    restored.bridge.reconcile('call','e',{disposition:'fulfilled',value:7,evidenceId:'durable-service-receipt'});
    const result=await finish(restored,'call');
    assert.deepEqual(result.completion,{kind:'return',value:['num',7]});
    assert.equal(restored.metrics().predictionAttempts,3);
    assert.equal(next.controls().attempts.length,3);assert.equal(calls,1);
    const again=await restored.checkpoint();assert.equal(again.attempts.length,3);
  }finally{restored.close();driver.close();resolveHost(7);}
});

test('driver restore rejects rehashed cross-layer history and budget changes before native restore',async()=>{
  const records=[line('return',{value:['num',1]}),line('end',{kind:'return'})];
  const choose=request=>records[request.public.timeline.filter(row=>row.mode==='generated').length];
  const driver=new RegionSelectedModelDriver({select:suppliedSelector(choose),
    harness:begin('"use strict";function run(){return 1;}'),...policy});
  await finish(driver,'call');const packet=await driver.checkpoint();driver.close();
  const session=packet.bridge.public.timeline[0].fields.session;
  const mutations=[
    p=>{p.policy.maxSelections++;},p=>{p.policy.hostLimits.maxGenerated++;},
    p=>{p.staleRetries++;},p=>{p.attempts[0].status='decoded';},
    p=>{p.attempts[0].record=line('return',{value:['num',99]});},
    p=>{p.contexts[0].visibleThrough++;},
    p=>{p.native.native.sessions[session].contexts=[];
      const {digest,...body}=p.native.native;p.native.native=seal(body);
      const {digest:outer,...transport}=p.native;p.native=seal(transport);},
    p=>{p.native.native.sessions.foreign=copy(p.native.native.sessions[session]);
      const {digest,...body}=p.native.native;p.native.native=seal(body);
      const {digest:outer,...transport}=p.native;p.native=seal(transport);},
    p=>{p.native.identity.seed++;p.native.native.initialization=copy(p.native.identity);
      const {digest,...body}=p.native.native;p.native.native=seal(body);
      const {digest:outer,...transport}=p.native;p.native=seal(transport);},
    p=>{p.bridge.selected.maxOutstanding++;
      const {integrity,...body}=p.bridge.selected;
      p.bridge.selected={...body,integrity:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
      const {integrity:outer,...bridge}=p.bridge;p.bridge={...bridge,integrity:hashAlgorithmData(bridge)};},
    p=>{p.bridge.selected.automaticDelivery=false;
      const {integrity,...body}=p.bridge.selected;
      p.bridge.selected={...body,integrity:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
      const {integrity:outer,...bridge}=p.bridge;p.bridge={...bridge,integrity:hashAlgorithmData(bridge)};}
  ];
  for(const mutate of mutations){
    const changed=copy(packet);mutate(changed);const {digest,...body}=changed;
    const next=suppliedSelector(choose);
    await assert.rejects(RegionSelectedModelDriver.restore(seal(body),{select:next,policy}));
    assert.equal(next.controls().restoreCalls,0);
  }
  const next=suppliedSelector(choose),restored=await RegionSelectedModelDriver.restore(packet,{select:next,policy});
  assert.equal(restored.metrics().predictionAttempts,2);restored.close();
});

test('checkpoint after retained registration restores callbacks and preserves the consumed global budget',async()=>{
  const source='"use strict";function run(){host.listen("tick",handler);return 1;}function handler(value){return value;}';
  const root=[line('allocate',{name:'fn',kind:'closure',code:'handler',captures:[],properties:[]}),
    line('request',{effect:'registration',operation:'demo.listen',invocation:'call',arguments:[['str','tick'],['ref','fn']],
      site:site(source,'demo.listen'),payload:'["tick",{"$ownedCallback":"fn"}]',promise:'registration'}),
    line('return',{value:['num',1]}),line('end',{kind:'return'})];
  const choose=request=>{
    const id=request.context.invocationId,index=request.public.timeline.filter(row=>row.mode==='generated'&&row.fields.invocationId===id).length;
    return id==='call'?root[index]:index===0?line('return',{value:['num',5]}):line('end',{kind:'return'});
  };
  let registrations=0;
  const limits={...policy,maxSelections:6};
  const driver=new RegionSelectedModelDriver({select:suppliedSelector(choose),...limits,
    harness:begin(source,{'demo.listen':(_,meta)=>{registrations++;return meta.subscriptionId(1);}},'retained')});
  await finish(driver,'call');const packet=await driver.checkpoint();driver.close();
  const next=suppliedSelector(choose),restored=await RegionSelectedModelDriver.restore(packet,{select:next,policy:limits});
  try{
    assert.equal(restored.bridge.handlers.get('callback1').state,'lost');
    let fire;restored.bridge.inner.reattachSubscription('callback1',{evidenceId:'existing-registration',attach:receive=>{fire=receive;}});
    restored.bridge.sync();fire('one',[5]);
    await until(()=>restored.bridge.invocations.get('event1')?.status==='completed');
    await until(()=>!restored.running.size);
    assert.equal(registrations,1);assert.equal(restored.metrics().predictionAttempts,6);
    const again=await restored.checkpoint();assert.equal(again.attempts.length,6);
    fire('two',[5]);await until(()=>restored.rejections.length>0);
    assert.match(JSON.stringify(restored.rejections),/global prediction budget exhausted/);
    assert.equal(restored.attempts.length,6);assert.equal(registrations,1);
  }finally{restored.close();}
});

test('recovery retains stale attempts and cannot reset their independent retry budget',async()=>{
  const source='"use strict";function run(){return 1;}',bridge=begin(source);
  const records=[line('return',{value:['num',1]}),line('end',{kind:'return'})];
  let published=0;
  const addProgram=harness=>harness.publishProgram({programId:'later'+(++published),source,entry:'run'});
  const choose=request=>{
    if(request.attempt===0)addProgram(bridge);
    return records[request.public.timeline.filter(row=>row.mode==='generated').length];
  };
  const limits={...policy,maxSelections:4,maxStaleRetries:1},
    driver=new RegionSelectedModelDriver({select:suppliedSelector(choose),harness:bridge,...limits});
  await finish(driver,'call');const packet=await driver.checkpoint();driver.close();
  assert.deepEqual(packet.attempts.map(row=>row.status),['stale','accepted','accepted']);
  assert.equal(packet.contexts.length,2);assert.equal(packet.staleRetries,1);
  let restored;
  const next=suppliedSelector(()=>{addProgram(restored.bridge);return records[0];});
  restored=await RegionSelectedModelDriver.restore(packet,{select:next,policy:limits});
  try{
    assert.equal(restored.metrics().predictionAttempts,3);assert.equal(restored.metrics().staleRetries,1);
    restored.bridge.admitInvocation({programId:'p',invocationId:'again',trackId:'t2',realmId:'r2',triggerId:'next'});
    await assert.rejects(restored.runInvocation('again'),/stale prediction retry budget exhausted/);
    assert.equal(restored.attempts.length,4);assert.equal(restored.attempts.at(-1).status,'stale-limit');
    assert.equal(restored.metrics().staleRetries,1);
  }finally{restored.close();}
});
