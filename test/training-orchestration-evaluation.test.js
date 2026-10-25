import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
import {verifyEffectfulSession} from '../src/training/effectful-session.js';
import {EFFECTFUL_ENGINEERING_FIXTURES} from '../src/training/engineering-fixtures.js';
import {controlledEvaluationCase,evaluateSelectedCase} from '../src/training/selected-evaluation.js';
import {controlledOrchestrationCase,evaluateOrchestrationCase,
  observedFixtureRecord} from '../src/training/orchestration-evaluation.js';
import {createMegatokenProcessSelector} from '../src/training/megatoken-process.js';
import {decodeWitness} from '../src/training/format.js';

const copy=value=>structuredClone(value);
const pure=verifyEffectfulTrainingCase({source:'"use strict";function run(){return 7;}',
  entry:'run',args:[],family:'orchestration-unit',fixture:{calls:[]},
  projectionOptions:{representation:'explicit'}}).then(result=>{
  assert.equal(result.status,'locally_verified',result.reason);
  return controlledEvaluationCase(result.exported,{id:'pure-orchestration'});
});
const envelope=fixture=>({schema:'semantic-evaluation-request/4',caseId:fixture.id,
  seed:17,representation:'explicit',request:fixture.request});

// This deliberately small fake tests the JavaScript scheduling boundary only.
// Native lifecycle correctness is exercised separately below with Megatoken.
function fakeNativeSelector({onSelect=null,onStep=null,stallStep=false}={}){
  let state,serial=0;
  const calls=[];
  const observe=(role,payload)=>state.observations.push({eventId:'fake-event'+(++serial),
    track:state.track,role,payloadHex:Buffer.from(JSON.stringify(payload)).toString('hex'),terminal:true});
  const select=async prefix=>{throw new Error('Unit fake has no model generation');};
  select.calls=calls;
  select.openOrchestration=async request=>{
    calls.push({op:'open',request:copy(request)});
    state={schema:'semantic-orchestration-state/4',session:request.session,track:'fake:coordinator',
      representation:'explicit',origin:request.origin,status:'active',decisions:[],receipts:[],observations:[],
      tracks:[{address:'fake:coordinator',status:'active',parent:null}],
      children:request.proposals.map(prefix=>({execution:{invocation_id:prefix.invocationId},
        program:prefix.committed[0],invocation:prefix.committed[1]}))};
    observe('tool',{opened:true});return copy(state);
  };
  select.stepOrchestration=async request=>{
    calls.push({op:'step',request:copy(request)});
    if(stallStep)return new Promise(()=>{});
    await onStep?.(request);
    const record=request.controlledRecord,action=JSON.parse(record),outcome={ok:true};
    observe('assistant',action);
    if(action.name==='track_create'){
      const child={address:'fake:child'+state.children.findIndex(item=>
        item.execution.invocation_id===action.arguments.execution.invocation_id),status:'waiting',
        parent:state.track,execution:action.arguments.execution,bootstrap_ready:false};
      state.tracks.push(child);outcome.track=copy(child);
      outcome.completion_dependency={id:'dep:'+child.address,track:child.address,
        invocation:child.execution.invocation_id,revision:'unit'};
    }else if(action.name==='track_join'){
      state.status='waiting';state.tracks[0].status='waiting';
      const child=state.tracks.find(track=>track.address===action.arguments.completion_dependency.track);
      child.status='active';child.bootstrap_ready=true;
      state.receipts.push({schema:'fake-join',dependency:action.arguments.completion_dependency});
    }else if(action.name==='track_complete'){
      state.status='completed';state.tracks[0].status='completed';
    }
    observe('tool',outcome);
    state.decision={record,selection:{modelSelected:false,origin:'controlled',modelTrack:state.track,
      selectedEventId:'fake-selected'+serial},outcomes:[outcome]};
    state.decisions.push(copy(state.decision));return copy(state);
  };
  select.selectControlled=async(prefix,record)=>{
    calls.push({op:'select-controlled',prefix:copy(prefix),record});
    assert.equal(state.status,'waiting','inactive child must not enter semantic selection before native join');
    const child=state.tracks.find(track=>track.execution?.invocation_id===prefix.invocationId);
    assert.equal(child?.status,'active');assert.equal(child.bootstrap_ready,true);
    await onSelect?.(prefix,record);
    return {schema:'selected-model-output/2',record,selection:{modelSelected:false,
      origin:'controlled-test-injected',modelTrack:child.address,ownerTrack:prefix.trackId,
      selectedEventId:'fake-semantic'+(++serial)}};
  };
  select.complete=async prefix=>{
    calls.push({op:'complete',prefix:copy(prefix)});
    const child=state.tracks.find(track=>track.execution?.invocation_id===prefix.invocationId);
    child.status='completed';state.status='active';state.tracks[0].status='active';
    const dependency=state.receipts.find(item=>item.schema==='fake-join').dependency;
    const receipt={schema:'semantic-completion/4',dependency,
      ...copy(prefix.selectedState.completion),parent:state.track,target:state.track};
    state.receipts.push(receipt);observe('tool',receipt);
  };
  select.statusOrchestration=async()=>copy(state);
  select.cancelOrchestration=async request=>{
    calls.push({op:'cancel-orchestration',request:copy(request)});
    state.status='cancelled';for(const track of state.tracks)if(track.status!=='completed')track.status='cancelled';
    observe('tool',{cancelled:true,reason:request.reason});return copy(state);
  };
  select.cancel=async prefix=>{calls.push({op:'cancel',prefix:copy(prefix)});};
  select.commitRequest=async()=>{throw new Error('Pure unit fixture must not dispatch');};
  select.close=()=>{calls.push({op:'close'});};
  select.metrics=()=>({schema:'semantic-inference-metrics/4',rpcCalls:calls.length,
    computeSeconds:0,peakMemoryBytes:0});
  return select;
}

test('orchestration fixture references bind only to already observed own fields',()=>{
  const observed={state:{track:'native:1'},receipt:{value:['num',7]}};
  assert.deepEqual(JSON.parse(observedFixtureRecord({name:'track_progress',arguments:{
    address:{$observed:['state','track']},progress:{$json:{$observed:['receipt']}}}},observed)),
  {name:'track_progress',arguments:{address:'native:1',progress:'{"value":["num",7]}'}});
  assert.throws(()=>observedFixtureRecord({$observed:['state','toString']},observed),/unavailable/);
  assert.throws(()=>observedFixtureRecord({$observed:['future']},observed),/unavailable/);
  assert.throws(()=>observedFixtureRecord({$observed:[],extra:true},observed),/Invalid/);
  assert.throws(()=>observedFixtureRecord('x'.repeat(65537),observed),/byte bound/);
});

test('orchestration fixture freezing retains separately checked identities and rejects tampered reference inputs',async()=>{
  const source=await pure,fixture=controlledOrchestrationCase(source);
  assert.deepEqual(fixture.request.invocations[0],source.request.invocation);
  assert.deepEqual(fixture.request.programs[0],source.request.program);
  assert.equal(Object.hasOwn(fixture.request,'expected'),false);
  assert.deepEqual(fixture.expected.completion.value.children,[{invocationId:source.request.invocation.invocationId,
    kind:'return',value:['num',7]}]);
  const forged=copy(source);forged.request.program.source='function run(){return 99;}';
  assert.throws(()=>controlledOrchestrationCase(forged),/exact independent/);
});

test('unit scheduler creates source-only proposals and waits for native capacity before child selection',async()=>{
  const fixture=controlledOrchestrationCase(await pure),select=fakeNativeSelector();
  const actual=await evaluateSelectedCase(envelope(fixture),{select});
  assert.equal(actual.failure,null,JSON.stringify(actual.failure));
  assert.deepEqual(actual.outcome,fixture.expected);
  const proposal=select.calls[0].request.proposals[0];
  assert.deepEqual(proposal.committed.map(item=>item.kind),['program','invocation']);
  assert.equal(Object.hasOwn(proposal,'selectedState'),false);
  assert.equal(Object.hasOwn(proposal,'expected'),false);
  const firstChild=select.calls.findIndex(item=>item.op==='select-controlled');
  assert.deepEqual(select.calls.slice(0,firstChild).map(item=>item.op),['open','step','step']);
  assert.equal(actual.episode.public.timeline.filter(item=>item.kind==='program').length,1);
  assert(actual.orchestration.childSelections.every(item=>item.selection.modelSelected===false));
  assert.deepEqual(actual.orchestration.validation,{semanticReplay:true,lifecycle:true,complete:true});
});

test('bounded coordinator failure cancels native tracks before any child can become public',async()=>{
  const fixture=controlledOrchestrationCase(await pure,{maxCoordinatorDecisions:1});
  const select=fakeNativeSelector(),actual=await evaluateOrchestrationCase(envelope(fixture),{select});
  assert.match(actual.failure.message,/decision budget/);
  assert.equal(actual.episode.public.timeline.length,0);
  assert.equal(actual.orchestration.children.length,0);
  assert.equal(actual.orchestration.finalState.status,'cancelled');
  assert.equal(actual.outcome.cleanup.pendingTracks,0);
  assert.equal(actual.orchestration.validation.complete,false);
  assert.equal(select.calls.filter(item=>item.op==='cancel-orchestration').length,1);
});

test('whole-task graph scoring normalizes child identity while retaining exact native progress bytes',async()=>{
  const source=await verifyEffectfulTrainingCase({source:'"use strict";function run(){const x={a:1};return x;}',
    entry:'run',args:[],family:'orchestration-object',fixture:{calls:[]},
    projectionOptions:{representation:'explicit'}});
  assert.equal(source.status,'locally_verified',source.reason);
  const fixture=controlledOrchestrationCase(controlledEvaluationCase(source.exported));
  const actual=await evaluateOrchestrationCase(envelope(fixture),{select:fakeNativeSelector()});
  assert.equal(actual.failure,null,JSON.stringify(actual.failure));
  assert.deepEqual(actual.outcome,fixture.expected);
  const raw=JSON.parse(JSON.parse(actual.orchestration.decisions[2].record).arguments.progress);
  assert.deepEqual(raw,actual.orchestration.children[0].completion);
  assert.notDeepEqual(raw.value,actual.outcome.completion.value.progress[0].value);
  assert.deepEqual(actual.outcome.completion.value.progress[0].value,['ref','o0']);
});

test('a rejected selected child preserves original evidence and cancels the joined coordinator',async()=>{
  const fixture=controlledOrchestrationCase(await pure);
  fixture.request.controlledSelectionsByRepresentation.explicit[fixture.request.invocations[0].invocationId]=[
    'return {"value":["ref","missing"]}'];
  const select=fakeNativeSelector(),actual=await evaluateOrchestrationCase(envelope(fixture),{select});
  assert(actual.failure);
  assert.equal(actual.outcome.cleanup.pendingTracks,0);
  assert.equal(actual.orchestration.finalState.status,'cancelled');
  assert.equal(actual.orchestration.validation.complete,false);
  assert.equal(actual.costs.dispatches,0);
  assert.equal(actual.rejections[0].phase,'semantic-validation');
  assert.equal(actual.rejections[0].selection.origin,'controlled-test-injected');
  assert.equal(actual.orchestration.childSelections[0].record,'return {"value":["ref","missing"]}');
});

test('orchestration deadlines cancel an unresponsive selection without polling',async()=>{
  const fixture=controlledOrchestrationCase(await pure),select=fakeNativeSelector({stallStep:true});
  const actual=await evaluateOrchestrationCase(envelope(fixture),{select,timeoutMs:30,cleanupTimeoutMs:100});
  assert.match(actual.failure.message,/deadline exceeded/);
  assert.equal(select.calls.filter(item=>item.op==='step').length,1);
  assert.equal(actual.outcome.cleanup.pendingTracks,0);
  assert.equal(actual.cleanupFailure,null);
});

test('actual-model orchestration never forwards controlled lifecycle or child plans',async()=>{
  const fixture=controlledOrchestrationCase(await pure),select=fakeNativeSelector();
  select.initialize=async request=>({schema:'semantic-inference-identity/4',...request,tokenizerIdentity:'unit'});
  select.stepOrchestration=async request=>{
    assert.equal(Object.hasOwn(request,'controlledRecord'),false);
    const error=new Error('Actual unit model selection rejected');
    error.evidence={origin:'model',payloadHex:'ff',fragments:[{selectedEventId:'original',emittedTokenIds:[7]}]};
    throw error;
  };
  select.selectControlled=()=>assert.fail('Actual model mode cannot select an authored child action');
  const actual=await evaluateOrchestrationCase(envelope(fixture),{select,origin:'fixed-weights',checkpointIdentity:'a'.repeat(64)});
  assert.equal(select.calls[0].request.origin,'model');
  assert.equal(JSON.stringify(select.calls[0].request).includes('controlledSelections'),false);
  assert.equal(actual.failure.evidence.payloadHex,'ff');
  assert.equal(actual.inferenceIdentity.checkpointIdentity,'a'.repeat(64));
  assert.equal(actual.episode.public.timeline.length,0);
  assert.equal(actual.costs.dispatches,0);
  assert.equal(actual.outcome.cleanup.pendingTracks,0);
});

const nativeReady=Boolean(process.env.MEGATOKEN_ORCHESTRATION_SERVED&&process.env.MEGATOKEN_PYTHON&&
  process.env.MEGATOKEN_REPOSITORY);
const nativeOptions={skip:nativeReady?false:'Set MEGATOKEN_ORCHESTRATION_SERVED, MEGATOKEN_PYTHON and MEGATOKEN_REPOSITORY for native runtime gates',timeout:120000};
function nativeSelector({representation='explicit',controlled=true}={}){
  return createMegatokenProcessSelector({command:process.env.MEGATOKEN_PYTHON,
    cwd:process.env.MEGATOKEN_REPOSITORY,representation,timeoutMs:30000,
    env:{...process.env,OMP_NUM_THREADS:'1'},args:['scripts/serve_selected_semantic.py',
      '--served',process.env.MEGATOKEN_ORCHESTRATION_SERVED,'--device','cpu','--max-tokens','8',
      ...(controlled?['--controlled-lifecycle-fixtures']:[])]});
}
function saveNativeEvidence(name,fixture,actual){
  const directory=process.env.MEGATOKEN_ORCHESTRATION_EVIDENCE_DIR;if(!directory)return;
  mkdirSync(directory,{recursive:true});
  writeFileSync(join(directory,name+'.json'),JSON.stringify({case:fixture,
    request:{...envelope(fixture),representation:actual.representation},result:actual},null,2)+'\n');
}
function observedBootstrap(actual,selection){
  const receipt=selection.stateBootstrap;
  assert.equal(receipt?.schema,'semantic-selected-bootstrap-receipt/4');
  const ids=new Set(receipt.observedEventIds);
  const rows=actual.orchestration.finalState.observations.filter(item=>ids.has(item.eventId));
  assert.equal(rows.length,ids.size,'Every current-state bootstrap fragment must exist in native observations');
  const packet=JSON.parse(Buffer.concat(rows.map(item=>Buffer.from(item.payloadHex,'hex'))).toString('utf8'));
  if(packet.schema==='semantic-execution/4'&&packet.kind==='model-context'){
    assert.equal(packet.mode,'observed');assert.equal(packet.sequence,receipt.publicSequence);
    assert.equal(packet.realmPrefixDigest,receipt.prefixDigest);assert.equal(packet.visibleThrough,receipt.visibleThrough);
    return {...packet,state:packet.selectedState,reason:receipt.reason};
  }
  assert.equal(packet.schema,'semantic-selected-bootstrap/4');
  assert.equal(packet.prefixDigest,receipt.prefixDigest);assert.equal(packet.visibleThrough,receipt.visibleThrough);
  return packet;
}

for(const representation of ['explicit','compact'])test('native '+representation+
  ' coordinator runs async, callback and throwing children in one process with exact whole-task receipts',nativeOptions,async()=>{
  const cases=['counter-0','callback-captured-write'].map(id=>{
    const fixture=copy(EFFECTFUL_ENGINEERING_FIXTURES.find(item=>item.id===id));
    fixture.projectionOptions={representation};return fixture;
  });
  cases.push({source:'"use strict";async function run(){try{return await host.readAsync("bad");}finally{host.store("cleanup",1);}}',
    entry:'run',args:[],projectionOptions:{representation},fixture:{calls:[
      {operation:'demo.readAsync',arguments:['bad'],status:'rejected',result:'missing'},
      {operation:'demo.store',arguments:['cleanup',1]}]}});
  const session=await verifyEffectfulSession({cases,family:'orchestration-native-services'});
  assert.equal(session.status,'locally_verified',session.reason);
  const source=controlledEvaluationCase(session.exported,{id:'native-services-'+representation});
  const fixture=controlledOrchestrationCase(source,{sessionId:'native-services-'+representation});
  const select=nativeSelector({representation});let commits=0;
  const commit=select.commitRequest;select.commitRequest=(...args)=>{commits++;return commit(...args);};
  try{
    const actual=await evaluateSelectedCase({...envelope(fixture),representation},{select,timeoutMs:60000});
    saveNativeEvidence('native-services-'+representation,fixture,actual);
    assert.equal(actual.failure,null,JSON.stringify(actual.failure));
    assert.equal(actual.cleanupFailure,null);
    assert.deepEqual(actual.outcome,fixture.expected);
    assert.equal(actual.orchestration.children.length,3);
    assert.equal(actual.episode.public.timeline.filter(item=>item.kind==='program').length,3);
    assert.equal(actual.episode.public.timeline.filter(item=>item.kind==='invocation').length,5);
    assert.equal(actual.orchestration.children[2].completion.kind,'throw');
    assert.equal(actual.outcome.callbacks.length,2);
    const parentResume=actual.orchestration.childSelections.find(item=>item.invocationId==='ingress2'&&item.record.startsWith('resume '));
    const snapshot=observedBootstrap(actual,parentResume.selection);
    assert.equal(snapshot.reason,'realm-resume');
    const captured=snapshot.state.heap.flatMap(([,value])=>value.captures??[]).find(item=>item.binding==='seen');
    assert.deepEqual(new Map(snapshot.state.locals).get(captured.cell),['num',7]);
    assert.equal(commits,actual.costs.dispatches);
    assert(commits>=8);
    assert(actual.orchestration.decisions.every(item=>item.selection.modelSelected===false&&item.selection.origin==='controlled'));
    assert(actual.orchestration.childSelections.every(item=>item.selection.modelSelected===false&&item.selection.origin==='controlled-test-injected'));
    assert(actual.orchestration.finalState.tracks.every(track=>track.status==='completed'));
    assert.deepEqual(actual.orchestration.validation,{semanticReplay:true,lifecycle:true,complete:true});
    assert(Object.values(actual.hardGates).every(value=>value===0));
    assert.equal(actual.optimizerSteps,0);
    assert(actual.nativeRuntimeMetrics.computeSeconds>0&&actual.nativeRuntimeMetrics.peakMemoryBytes>0);
  }finally{select.close();}
});

test('native bounded context rereads the current captured cell after a callback tail exceeds original history',
  {...nativeOptions,timeout:290000},async()=>{
  const source=await verifyEffectfulTrainingCase({
    source:'"use strict";async function run(){let seen=0;await host.withCallback("tick",function(n){seen+=n;for(let i=0;i<30;i++){const ignored=i+1;}host.store("callback",seen);});return seen;}',
    entry:'run',args:[],family:'orchestration-bounded-retained-state',projectionOptions:{representation:'compact'},
    fixture:{calls:[{operation:'demo.withCallback',arguments:['tick',{callback:true}],callbacks:[{slot:1,arguments:[3]}]},
      {operation:'demo.store',arguments:['callback',3]}]}});
  assert.equal(source.status,'locally_verified',source.reason);
  const fixture=controlledOrchestrationCase(controlledEvaluationCase(source.exported,{id:'native-retained-tail-compact'}),
    {sessionId:'native-retained-tail'});
  const select=nativeSelector({representation:'compact'});
  try{
    const actual=await evaluateOrchestrationCase({...envelope(fixture),representation:'compact'},
      {select,timeoutMs:240000,cleanupTimeoutMs:3000});
    saveNativeEvidence('native-retained-tail-compact',fixture,actual);
    assert.equal(actual.failure,null,JSON.stringify(actual.failure));
    assert.deepEqual(actual.outcome,fixture.expected);
    const rows=actual.orchestration.childSelections,root=fixture.request.invocations[0].invocationId;
    const resumeAt=rows.findIndex(item=>item.invocationId===root&&item.record.startsWith('resume '));
    assert(resumeAt>0);
    const resume=rows[resumeAt],snapshot=observedBootstrap(actual,resume.selection);
    assert.equal(snapshot.reason,'realm-resume');
    const captured=snapshot.state.heap.flatMap(([,value])=>value.captures??[]).find(item=>item.binding==='seen');
    assert.deepEqual(new Map(snapshot.state.locals).get(captured.cell),['num',3]);
    const mutationAt=rows.findIndex(item=>{
      const decoded=decodeWitness(item.record);
      return item.invocationId!==root&&decoded.kind==='bind'&&decoded.fields.name===captured.cell&&
        JSON.stringify(decoded.fields.value)==='["num",3]';
    });
    assert(mutationAt>=0);
    const history=JSON.parse(readFileSync(join(process.env.MEGATOKEN_ORCHESTRATION_SERVED,'model_config.json'),'utf8')).max_history_chunks;
    assert(resumeAt-mutationAt-1>history,'The actual selected callback tail must exceed the served history bound');
    const bootstrap=resume.selection.stateBootstrap,mutation=rows[mutationAt].selection.selectedEventId;
    assert.equal(bootstrap.maxHistoryChunks,history);
    assert(bootstrap.observedEventIds.every(identity=>bootstrap.visibleEventIds.includes(identity)));
    assert(!bootstrap.visibleEventIds.some(identity=>identity===mutation||identity.startsWith(mutation+':part:')),
      'Original mutation must be evicted before the parent reads its current observed state');
    assert.equal(actual.costs.leakedResources,0);assert(Object.values(actual.hardGates).every(count=>count===0));
  }finally{select.close();}
});

test('native coordinator budget cancellation leaves no selected guest, effect, or live track',nativeOptions,async()=>{
  const fixture=controlledOrchestrationCase(await pure,{sessionId:'native-budget',maxCoordinatorDecisions:1});
  const select=nativeSelector();
  try{
    const actual=await evaluateOrchestrationCase(envelope(fixture),{select,timeoutMs:30000});
    saveNativeEvidence('native-budget',fixture,actual);
    assert.match(actual.failure.message,/decision budget/);
    assert.equal(actual.episode.public.timeline.length,0);
    assert(actual.orchestration.finalState.tracks.every(track=>track.status==='cancelled'));
    assert.equal(actual.costs.dispatches,0);assert.equal(actual.costs.leakedResources,0);
  }finally{select.close();}
});

test('native rejected semantic child preserves its committed bytes and cancels its waiting parent',nativeOptions,async()=>{
  const fixture=controlledOrchestrationCase(await pure,{sessionId:'native-invalid-child'});
  const record='return {"value":["ref","missing"]}';
  fixture.request.controlledSelectionsByRepresentation.explicit[fixture.request.invocations[0].invocationId]=[record];
  const select=nativeSelector();
  try{
    const actual=await evaluateOrchestrationCase(envelope(fixture),{select,timeoutMs:30000});
    saveNativeEvidence('native-invalid-child',fixture,actual);
    assert(actual.failure);assert.equal(actual.rejections[0].phase,'semantic-validation');
    assert.equal(actual.rejections[0].record,record);
    assert.equal(actual.rejections[0].selection.origin,'controlled-test-injected');
    assert.equal(actual.orchestration.childSelections[0].record,record);
    assert(actual.orchestration.finalState.tracks.every(track=>['cancelled','completed'].includes(track.status)));
    assert.equal(actual.outcome.cleanup.pendingTracks,0);assert.equal(actual.costs.dispatches,0);
  }finally{select.close();}
});

test('actual initialized-weight native coordinator preserves rejected bytes and token costs with no fixture fallback',nativeOptions,async()=>{
  const fixture=controlledOrchestrationCase(await pure,{sessionId:'native-model-rejection'});
  const checkpointIdentity=JSON.parse(readFileSync(join(process.env.MEGATOKEN_ORCHESTRATION_SERVED,'manifest.json'),'utf8')).model_sha256;
  const select=nativeSelector({controlled:false});
  try{
    const actual=await evaluateOrchestrationCase({...envelope(fixture),checkpointIdentity},
      {select,origin:'fixed-weights',checkpointIdentity,timeoutMs:30000});
    saveNativeEvidence('native-model-rejection',fixture,actual);
    assert(actual.failure,'Untrained engineering weights must not be reported as a successful learned coordinator');
    assert.equal(actual.failure.evidence.origin,'model');
    assert(actual.failure.evidence.payloadHex.length>0);
    assert(actual.failure.evidence.fragments.some(item=>item.emittedTokenIds.length>0));
    assert.equal(actual.inferenceIdentity.checkpointIdentity,checkpointIdentity);
    assert.equal(actual.inferenceIdentity.seed,17);
    assert.equal(actual.orchestration.finalState.origin,'model');
    assert.equal(actual.episode.public.timeline.length,0);
    assert.equal(actual.costs.dispatches,0);assert.equal(actual.costs.leakedResources,0);
    assert.equal(actual.orchestration.validation.complete,false);
    assert(actual.nativeRuntimeMetrics.computeSeconds>0&&actual.nativeRuntimeMetrics.peakMemoryBytes>0);
  }finally{select.close();}
});
