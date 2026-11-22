// Isolated engineering probe. It deliberately cannot grant module/data admission.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createRuntime} from '../src/runtime.js';
import {linkEvaluatedModules} from '../src/evaluated-modules.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {deriveModuleSchedulerSourceCutsV8} from '../src/semantic/module-scheduler-source-v8.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {independentModuleRegionReference} from '../src/semantic/module-v8.js';
import {compareObservableGraphs} from '../src/semantic/observables.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';

assert(process.env.MEGATOKEN_ROOT,'MEGATOKEN_ROOT must name the exact independent native candidate');
const output=process.argv[2]??join(process.env.RUNNER_TEMP??'.','nested-async-module-probe-evidence.json');
const request={entryModule:'main.js',exportName:'run',modules:{
  'left.js':'export let x=0;try {await Promise.reject(7);} catch(e){x=e;}',
  'right.js':'await 0; export const x=2;',
  'main.js':"import {x} from './left.js';import {x as y} from './right.js';export function run(){return x+y;}"
}};
const started=performance.now(),linked=linkEvaluatedModules(request),
  runtime=createRuntime().startEntry({text:linked.source,functionName:linked.entryFunction,args:[linked.entryInput],allowAsync:true});
assert.equal(runtime.drive().kind,'terminated');
const bundle=JSON.parse(JSON.stringify(runtime.exportRun())),ownership=deriveModuleSchedulerSourceCutsV8({request,bundle}),
  projection=compileProtocolSourceV8(bundle);
const reference=await independentModuleRegionReference({...request,calls:null,inputGraph:encodeNativeGraph([linked.entryInput])});
assert.equal(reference.status,'passed');assert.equal(reference.outcome.kind,projection.outcome.kind);
assert(compareObservableGraphs(reference.outcome.graph,projection.outcome.graph,
  {leftInputIds:['o0'],rightInputIds:['o0']}).equal,'original ESM outcome differs');
const owners=new Set(),frameIds=new Map(),cuts=[];
for(const cut of ownership.cuts){
  const eventId=cut.certificate.eventId;
  assert(!owners.has(eventId),'a module lifecycle event has more than one owner');owners.add(eventId);
  const indices=projection.claims.flatMap((claim,index)=>claim.certificate.journalEvents.includes(eventId)?[index]:[]);
  assert(indices.length>0,'owned module event has no public source record');
  assert(indices.every((index,position)=>index===indices[0]+position),'module event records are not one contiguous transaction');
  if(cut.action.type==='module.start'){
    const entered=indices.map(index=>projection.claims[index].record).filter(record=>['call','async.call'].includes(record.kind));
    assert.equal(entered.length,1,'module driver event must enter exactly one public source scope');
    frameIds.set(cut.action.frameId,entered[0].child);
  }
  cuts.push({...cut,publicClaimIndices:indices,publicInvocation:frameIds.get(cut.action.frameId)??null});
}
const h=new RegionExecutionHarness({sessionId:'original-module-async-probe',automaticDelivery:false,now:()=>-Infinity});
h.publishProgram({programId:'program1',source:projection.source,entry:projection.entry,capabilities:[]});
h.admitInvocation({programId:'program1',invocationId:'invocation1',trackId:'worker1',realmId:'realm1',triggerId:'protocol-entry',
  inputGraph:projection.inputGraph,realmPolicy:'fresh',completionPolicy:projection.completionPolicy});
const contexts=[];
for(const [index,claim]of projection.claims.entries()){
  contexts.push(h.modelContext('invocation1'));h.select('invocation1',claim.line);
  for(const cut of cuts.filter(cut=>cut.publicClaimIndices.at(-1)===index)){
    cut.publicSequence=h.timeline.at(-1).sequence;cut.publicState=sharedRegionState(h.controller);
    const module=ownership.plan.modules.find(row=>row.file===cut.action.file),frame=cut.publicInvocation,
      promiseId=cut.action.type==='module.start'?cut.action.executionPromiseId:ownership.state.modules[module.file].executionPromiseId,
      call=promiseId&&h.controller.heap.get(promiseId)?.asyncCall;
    if(module.hasTLA){
      assert.equal(call?.invocation,frame,'module driver execution Promise names another public source frame');
      const phase=cut.action.type==='module.await'?'suspended':['module.complete','module.reject'].includes(cut.action.type)?'completed':'running';
      assert.equal(call.phase,phase,'public async phase differs from the original module lifecycle');
      if(cut.action.type==='module.await')assert.equal(h.controller.continuations.get(call.continuations.at(-1)).promise,cut.action.promiseId);
    }else{
      assert.equal(h.controller.frameFunctions.get(frame),'__traced_eval_sync');
      assert.equal(h.controller.stack.includes(frame),cut.action.type==='module.start');
    }
  }
}
assert.deepEqual({kind:h.controller.completion.kind,graph:h.controller.observedGraph()},projection.outcome);
const artifact={public:h.exportEpisode(),contexts,sidecar:{schema:'module-async-composition-engineering-probe/1'}},
  state=sharedRegionState(h.controller),nativeRoot=resolve(process.env.MEGATOKEN_ROOT);
const python=`
import json,sys
from megatoken.data.native_v8 import validate_v8_artifact,_replay_shared_state
from megatoken.data.module_scheduler_state_v8 import create_module_scheduler_state_v8,apply_module_scheduler_action_v8
data=json.load(sys.stdin);artifact=data['artifact'];cuts=data['cuts']
receipt=validate_v8_artifact(artifact)
assert receipt['admitted'] is False
assert all(receipt['checks'][key]=='passed' for key in ['replay','contexts','continuation'])
selected=create_module_scheduler_state_v8(data['plan'])
for cut in cuts:
    assert selected==cut['before']
    selected=apply_module_scheduler_action_v8(data['plan'],selected,cut['action'],cut['facts'])
    assert selected==cut['after']
    rows=artifact['public']['timeline'][:cut['publicSequence']]
    contexts=[context for context in artifact['contexts'] if context['visibleThrough']<cut['publicSequence']]
    observed=_replay_shared_state(rows,contexts,{},roundtrip=True,boundary_invocation='invocation1')['state']
    assert observed==cut['publicState']
assert selected==data['moduleState']
observed=_replay_shared_state(artifact['public']['timeline'],artifact['contexts'],{},roundtrip=True,boundary_invocation='invocation1')['state']
assert observed==data['state']
print(json.dumps({'receipt':receipt,'ownedModuleCuts':len(cuts),'nativePublicCuts':len(cuts),'finalSharedStateEqual':True}))
`;
const result=spawnSync(process.env.MEGATOKEN_PYTHON||'python',['-c',python],{cwd:nativeRoot,
  env:{...process.env,PYTHONPATH:join(nativeRoot,'src')},encoding:'utf8',timeout:900000,maxBuffer:8*1024*1024,
  input:JSON.stringify({artifact,cuts,plan:ownership.plan,moduleState:ownership.state,state})});
assert.equal(result.status,0,result.stderr||String(result.error));
const native=JSON.parse(result.stdout),summary={schema:'original-module-async-composition-probe/1',
  modules:ownership.plan.modules.length,ownedEvents:bundle.events.length,publicRecords:projection.claims.length,
  protocolRecords:projection.protocolRecords,detailedRecords:projection.detailedRecords,generatedContexts:contexts.length,
  ownedModuleCuts:ownership.ownedEventCount,nativePublicCuts:native.nativePublicCuts,originalEsmReference:reference.status,
  finalSharedStateEqual:native.finalSharedStateEqual,nativeReceipt:native.receipt,
  moduleAdmission:false,trainingAdmission:false,optimizerUpdates:0,elapsedMs:performance.now()-started};
writeFileSync(output,JSON.stringify({summary,request,linked,bundle,projection,ownership,cuts,reference,artifact,state,native}));
console.log('ORIGINAL_MODULE_ASYNC_PROBE_SUMMARY_JSON '+JSON.stringify(summary));
