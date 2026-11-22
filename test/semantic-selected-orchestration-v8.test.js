import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {runSelectedRegionOrchestrationV8,RegionSelectedOrchestrationDriver} from
  '../src/semantic/selected-orchestration-v8.js';
import {boundedCancellationReason} from '../src/semantic/selected-execution-v8.js';
import {nativeV8OrchestrationContext} from '../src/semantic/native-orchestration-transport-v8.js';

const artifact=JSON.parse(await readFile(new URL('./fixtures/semantic-regions-v8.json',import.meta.url)))
  .examples.find(row=>row.id==='ordered-map');
const pin={checkpointIdentity:'c'.repeat(64),tokenizerIdentity:'e'.repeat(64),trainingIdentity:null,seed:17};
const generationSettings={device:'cpu',maxTokens:128,maxFragments:8,effort:1};

function ingress({roots=1,fresh=false}={}){
  const firstGenerated=artifact.public.timeline.findIndex(row=>row.mode==='generated');
  const publicData=structuredClone({...artifact.public,timeline:artifact.public.timeline.slice(0,firstGenerated)});
  const invocations=publicData.timeline.filter(row=>row.kind==='invocation');
  if(fresh)for(const row of invocations)row.fields.realmPolicy='fresh';
  for(let index=1;index<roots;index++){
    const source=invocations[0],row=structuredClone(source);row.sequence=publicData.timeline.length+1;
    row.fields.invocationId='invocation'+(index+1);row.fields.realmId='realm'+(index+1);
    row.fields.track='worker'+(index+1);row.fields.triggerId='trigger-'+(index+1);
    row.fields.ingressKey='trigger-'+(index+1);row.fields.realmPolicy='fresh';
    publicData.timeline.push(row);
  }
  return publicData;
}

function selectionEvidence(record,context,{selectionId,invocationId=null,session=null,track, family=null,
    publicDigest=null}={}){
  const payloadHex=Buffer.from(record,'utf8').toString('hex');
  return {origin:'actual-model-selected',modelSelected:true,selectionId,
    ...(family?{family}:{}),session:session??context.session??null,invocationId,
    checkpointIdentity:pin.checkpointIdentity,tokenizerIdentity:pin.tokenizerIdentity,
    trainingIdentity:null,prefixDigest:context.prefixDigest??null,contextDigest:hashAlgorithmData(context),
    ...(publicDigest?{publicDigest}:{}),payloadHex,
    fragments:[{payloadHex,tokenIds:[91],emittedTokenIds:[91],selectedEventId:selectionId+':event',
      meridian:0,modelTrack:track,terminal:true}]};
}

function fakeSelector(publicData,{failCoordinator=null,failBootstrap=false}={}){
  const session=publicData.timeline[0].fields.session,programs=new Map(),roots=[];
  for(const row of publicData.timeline){
    if(row.kind==='program')programs.set(row.fields.programId,row);
    else roots.push(row);
  }
  const generated=new Map();
  for(const row of artifact.public.timeline.filter(item=>item.mode==='generated')){
    const id=row.fields.invocationId;if(!generated.has(id))generated.set(id,[]);generated.get(id).push(row.fields.line);
  }
  const state={schema:'semantic-orchestration-state/8',session,track:'coordinator-1',origin:'model',
    sourceAdmissionClaim:false,status:'active',children:roots.map(row=>({program:structuredClone(programs.get(row.fields.programId)),
      invocation:structuredClone(row),execution:{schema:'semantic-execution-binding/4',
        program_id:row.fields.programId,source_digest:row.fields.sourceDigest,entry:row.fields.entry,
        invocation_id:row.fields.invocationId,realm_id:row.fields.realmId,trigger_id:row.fields.triggerId,
        input_ref:hashAlgorithmData(row.fields.inputGraph),realm_policy:row.fields.realmPolicy,
        completion_mode:row.fields.completionPolicy,capability_grants:structuredClone(programs.get(row.fields.programId).fields.capabilities),
        completion_target:'coordinator-1'},track:null,completion:null})),
    decisions:[],tracks:[],receipts:[],published:[],publicDigest:hashAlgorithmData(publicData),pendingSelection:null};
  const coordinator={address:state.track,parent:null,status:'active',bootstrap_ready:false};
  const events=[],childPositions=new Map(),dependencies=new Map(),published=new Set();
  const plan=roots.flatMap(row=>[
    {name:'track_create',invocationId:row.fields.invocationId},
    {name:'track_join',invocationId:row.fields.invocationId},
    {name:'track_progress',invocationId:row.fields.invocationId},
  ]).concat([{name:'track_complete'}]);
  let nextTrack=0,coordinatorSelection=0,childSelection=0,coordinatorActionIndex=0;
  const descriptors=()=>[structuredClone(coordinator),...state.children.filter(row=>row.track).map(row=>{
    const original=state.tracks.find(track=>track.address===row.track);return structuredClone(original);
  })];
  const snapshot=()=>({...structuredClone(state),tracks:descriptors()});
  const childFor=id=>state.children.find(row=>row.execution.invocation_id===id);
  const actionFor=step=>{
    const child=childFor(step.invocationId);
    if(step.name==='track_create')return {name:step.name,arguments:{purpose:'Run declared V8 child',
      completion:'Publish the exact V8 child completion',budget:64,capabilities:['text'],execution:structuredClone(child.execution)}};
    if(step.name==='track_join')return {name:step.name,arguments:{address:state.track,
      completion_dependency:structuredClone(dependencies.get(child.track))}};
    if(step.name==='track_progress')return {name:step.name,arguments:{address:state.track,
      progress:JSON.stringify(child.completion.completion)}};
    return {name:'track_complete',arguments:{address:state.track}};
  };
  const select=async request=>{
    const invocationId=request.context.invocationId,index=childPositions.get(invocationId)??0,
      record=generated.get(invocationId)?.[index]??generated.values().next().value?.[index];
    assert.equal(typeof record,'string','the selected child fixture must have another original record');
    childPositions.set(invocationId,index+1);events.push('child-select:'+invocationId);
    childSelection++;
    return {record,selection:selectionEvidence(record,request.context,{selectionId:'child-selection-'+childSelection,
      invocationId,session,track:request.public.timeline.findLast(row=>row.kind==='invocation'&&
        row.fields.invocationId===invocationId)?.fields.track??'worker'})};
  };
  select.initialize=async request=>({...request,schema:'semantic-inference-identity/8',adapter:'native-semantic-v8/1',
    generationSettings,nativeAdmissionClaim:false});
  select.commit=async request=>{events.push('child-commit:'+request.invocationId);return {committed:true,
    selectionId:request.selection.selectionId};};
  select.complete=async request=>{
    events.push('child-complete:'+request.invocationId);
    const child=childFor(request.invocationId),dependency=dependencies.get(child.track),track=state.tracks.find(row=>row.address===child.track),
      receipt={schema:'semantic-child-completion/8',session,invocationId:request.invocationId,track:child.track,
        completion:structuredClone(request.completion),heap:[],publicDigest:hashAlgorithmData(request.public),
        contextsDigest:hashAlgorithmData(request.contexts)};
    child.completion=receipt;track.status='completed';coordinator.status='active';state.status='active';
    state.publicDigest=hashAlgorithmData(request.public);
    state.receipts.push({schema:'semantic-completion/4',dependency:structuredClone(dependency),
      kind:request.completion.kind,value:structuredClone(request.completion.value),parent:state.track,target:state.track});
    return {schema:'semantic-native-completion/8',session,invocationId:request.invocationId,completed:true,
      sessionRetained:true,publicDigest:state.publicDigest,childCompletion:structuredClone(receipt)};
  };
  select.reject=async()=>({rejected:true});
  select.metrics=()=>({schema:'semantic-native-model-metrics/8',attempts:[]});
  select.openOrchestration=async request=>{
    assert.equal(request.origin,'model');events.push('open');
    state.tracks=[structuredClone(coordinator)];return snapshot();
  };
  select.statusOrchestration=async()=>snapshot();
  select.selectOrchestration=async request=>{
    assert.equal(state.status,'active');assert.equal(request.track,state.track);
    const step=plan[coordinatorActionIndex++];assert(step,'coordinator action fixture exhausted');
    events.push('coordinator-select:'+step.name+':'+(step.invocationId??''));
    if(failCoordinator){
      const error=new Error(failCoordinator.message);error.category='fixture-native-selection';
      error.evidence={record:failCoordinator.record,rawPayloadHex:Buffer.from(failCoordinator.record,'utf8').toString('hex'),
        selection:{family:'orchestration',origin:'actual-model-selected',modelSelected:true,selectionId:'failed-choice'}};
      throw error;
    }
    const record=JSON.stringify(actionFor(step)),context=nativeV8OrchestrationContext(snapshot()),selectionId='coordinator-'+(++coordinatorSelection),
      selection=selectionEvidence(record,context,{selectionId,track:state.track,family:'orchestration',publicDigest:state.publicDigest});
    state.pendingSelection=selectionId;
    return {schema:'semantic-orchestration-output/8',record,selection};
  };
  select.commitOrchestration=async request=>{
    assert.equal(request.selection.selectionId,state.pendingSelection);
    const action=JSON.parse(request.record),receipt={schema:'semantic-orchestration-commit/8',
      selectionId:request.selection.selectionId,committed:true};
    state.decisions.push({selectionId:request.selection.selectionId,record:request.record});
    state.pendingSelection=null;
    if(action.name==='track_create'){
      const child=childFor(action.arguments.execution.invocation_id),track='child-track-'+(++nextTrack),
        dependency={schema:'semantic-completion-dependency/4',id:'completion:'+track+':1',
          track,revision:1,invocation:child.execution.invocation_id};
      child.track=track;dependencies.set(track,dependency);
      const desc={address:track,parent:state.track,status:'waiting',bootstrap_ready:false,
        execution:structuredClone(child.execution)};state.tracks.push(desc);
      receipt.track=structuredClone(desc);receipt.completion_dependency=structuredClone(dependency);
    }else if(action.name==='track_join'){
      const dependency=action.arguments.completion_dependency,child=childFor(dependency.invocation),desc=state.tracks.find(row=>row.address===child.track);
      coordinator.status='waiting';state.status='waiting';desc.status='active';
      receipt.track=structuredClone(coordinator);
    }else if(action.name==='track_progress'){
      const child=state.children.find(row=>row.completion&&row.execution.invocation_id===
        JSON.parse(action.arguments.progress).invocationId);
      // Publication identity is tied to the currently joined child in the planned cohort.
      const current=state.children.find(row=>row.completion&& !published.has(row.execution.invocation_id));
      const target=child??current;assert(target);published.add(target.execution.invocation_id);
      state.published.push(target.execution.invocation_id);receipt.track=structuredClone(coordinator);
    }else if(action.name==='track_complete'){
      state.status='completed';coordinator.status='completed';receipt.track=structuredClone(coordinator);
    }else if(action.name==='track_cancel'){
      state.status='cancelled';coordinator.status='cancelled';receipt.track=structuredClone(coordinator);
    }
    events.push('coordinator-commit:'+action.name+':'+(action.arguments.execution?.invocation_id??''));
    return receipt;
  };
  select.bootstrapOrchestrationChild=async request=>{
    if(failBootstrap)throw new Error('bootstrap receipt unavailable');
    const child=state.children.find(row=>row.track===request.childTrack),desc=state.tracks.find(row=>row.address===request.childTrack);
    assert(child&&desc);desc.bootstrap_ready=true;events.push('bootstrap:'+child.execution.invocation_id);
    return {schema:'semantic-orchestration-bootstrap/8',bootstrapped:true,track:structuredClone(desc)};
  };
  select.cancelOrchestration=async request=>{
    events.push('cancel-coordinator:'+request.reason);state.status='cancelled';state.cancelled=request.reason;
    coordinator.status='cancelled';state.receipts.push({schema:'semantic-orchestration-cancel/8',
      track:state.track,reason:request.reason});return snapshot();
  };
  select.cancel=async request=>{events.push('close:'+request.reason);return {schema:'semantic-native-close/8',
    session:request.session,closed:true,reason:request.reason};};
  select.close=()=>{};
  return {select,events,state,dependencies};
}

test('model-only coordinator runs only the exact joined, bootstrapped child before its next choice',async()=>{
  const publicData=ingress({roots:2,fresh:true}),fixture=fakeSelector(publicData),
    driver=new RegionSelectedOrchestrationDriver({initialPublic:publicData,select:fixture.select,
      ...pin,generationSettings,maxActive:1}),result=await driver.run();
  assert.equal(result.status,'completed',JSON.stringify(result.failure));
  assert.equal(result.finalState.status,'completed');assert.equal(result.publicCompleted,true);
  assert.equal(result.coordinatorAttempts.length,7);
  assert.equal(result.completionReceipts.length,2);assert.equal(result.childAttempts.length,artifact.contexts.length*2);
  assert.equal(result.recovery.resumable,false);
  const child1=fixture.events.indexOf('child-complete:invocation1'),progress1=fixture.events.indexOf('coordinator-select:track_progress:invocation1'),
    child2=fixture.events.indexOf('child-complete:invocation2'),progress2=fixture.events.indexOf('coordinator-select:track_progress:invocation2');
  assert(child1>=0&&child1<progress1,'native child complete must precede the next coordinator selection');
  assert(child2>=0&&child2<progress2,'second native child complete must precede its publication selection');
  assert(fixture.events.indexOf('bootstrap:invocation1')<fixture.events.indexOf('child-select:invocation1'));
  assert(fixture.events.indexOf('bootstrap:invocation2')<fixture.events.indexOf('child-select:invocation2'));
  assert.equal(fixture.events.filter(event=>event.startsWith('child-select:invocation2')).length,artifact.contexts.length);
  assert.equal(result.qualification.defaultPromotion,false);
  await assert.rejects(driver.run(),/one-shot/);
});

test('failed original coordinator bytes and one normalized cancellation reason survive cleanup',async()=>{
  const publicData=ingress(),record='{"name":"partial","arguments":{}}',reason='😃'.repeat(1300),
    fixture=fakeSelector(publicData,{failCoordinator:{message:reason,record}}),result=await runSelectedRegionOrchestrationV8({
      initialPublic:publicData,select:fixture.select,...pin,generationSettings});
  const bounded=boundedCancellationReason(reason);
  assert.equal(result.status,'failed');assert.equal(result.coordinatorAttempts[0].record,record);
  assert.equal(result.coordinatorAttempts[0].rawPayloadHex,Buffer.from(record,'utf8').toString('hex'));
  assert.equal(result.coordinatorAttempts[0].status,'failed');
  assert.equal(result.terminalReason,bounded);assert(Buffer.byteLength(bounded)<=4096);
  assert.equal(fixture.events.find(row=>row.startsWith('cancel-coordinator:')).slice('cancel-coordinator:'.length),bounded);
  assert.equal(fixture.events.at(-1),'close:'+bounded);
  assert.equal(result.finalState.status,'cancelled');
});

test('a committed create remains counted as acknowledged when bootstrap later fails',async()=>{
  const publicData=ingress(),fixture=fakeSelector(publicData,{failBootstrap:true}),
    result=await runSelectedRegionOrchestrationV8({initialPublic:publicData,select:fixture.select,
      ...pin,generationSettings});
  assert.equal(result.status,'failed');
  assert.equal(result.coordinatorAttempts[0].status,'post-commit-failed');
  assert.equal(result.coordinatorAttempts[0].commitReceipt.committed,true);
  assert.equal(result.metrics.coordinatorAccepted,1);
  assert.equal(result.metrics.coordinatorRejected,0);
  assert.equal(result.metrics.coordinatorPostCommitFailures,1);
});

test('orchestration explicitly refuses semantic-only checkpoint and restore APIs',async()=>{
  const publicData=ingress(),fixture=fakeSelector(publicData),driver=new RegionSelectedOrchestrationDriver({
    initialPublic:publicData,select:fixture.select,...pin,generationSettings});
  assert.throws(()=>driver.checkpoint(),/composite coordinator and child recovery/);
  assert.throws(()=>driver.checkpointDurableHistory(),/composite coordinator history/);
  assert.throws(()=>RegionSelectedOrchestrationDriver.restore({}),/composite coordinator restore/);
  assert.throws(()=>RegionSelectedOrchestrationDriver.restoreLatest({}),/composite coordinator restore/);
});
