import test from 'node:test';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {verifyRegionTrainingCase} from '../src/semantic/compiler-v8.js';
import {attachSourceQualifiedOrchestrationV8,validateOrchestrationTranscriptV8} from '../src/semantic/orchestration-training-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {stableAlgorithmJSON} from '../src/semantic/ir.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {causalLmV8OrchestrationPrompt,buildCausalLmV8Examples} from '../src/semantic/causal-lm-v8.js';
import {prepareRegionFamilyRegistry,bindRegionFamilySplit} from '../src/semantic/dataset-v8.js';

const fixture={id:'orchestration-training-scalar',family:'source-qualified-v8-child',
  source:'"use strict";function run(x){return x*2;}',entry:'run',args:[3],fixture:{calls:[]}};
const qualified=await verifyRegionTrainingCase(fixture);
assert(qualified.exported,qualified.reason);
const sourceArtifact=qualified.exported,sourceBefore=structuredClone(sourceArtifact),
  artifact=await attachSourceQualifiedOrchestrationV8(sourceArtifact),
  baseline=structuredClone(artifact),transcript=artifact.sidecar.orchestrationTranscript;

function rehash(candidate){
  const {digest,...body}=candidate.sidecar.orchestrationTranscript;
  candidate.sidecar.orchestrationTranscript.digest=hashAlgorithmData(body);
}
function rejectedTranscript(label,mutate,{rehashDigest=true}={}){
  const candidate=structuredClone(baseline);mutate(candidate.sidecar.orchestrationTranscript);
  if(rehashDigest)rehash(candidate);
  assert.throws(()=>validateOrchestrationTranscriptV8(candidate),undefined,label);
}
function event(candidate,kind,ordinal){
  return candidate.sidecar.orchestrationTranscript.events.find(row=>row.kind===kind&&
    (ordinal===undefined||row.ordinal===ordinal));
}

test('source-qualified scalar child attaches the canonical ten-event four-target lifecycle without mutation',()=>{
  assert.deepEqual(sourceArtifact,sourceBefore,'attaching lifecycle targets must not mutate source evidence');
  assert.equal(transcript.schema,'semantic-orchestration-transcript/1');
  assert.equal(transcript.origin,'source-qualified-teacher');
  assert.equal(transcript.policy.schema,'semantic-orchestration-policy/1');
  assert.equal(validateOrchestrationTranscriptV8(artifact).orchestrationRecords,4);
  assert.equal(transcript.events.length,10);
  assert.deepEqual(transcript.events.map(row=>row.kind),[
    'decision','ack','bootstrap','decision','ack','completion','decision','ack','decision','ack'
  ]);
  assert.deepEqual(transcript.events.map(row=>row.ordinal),Array.from({length:10},(_,index)=>index+1));
  assert.deepEqual(transcript.events.map(row=>row.afterPublicSequence),[2,2,2,2,2,4,4,4,4,4]);
  const decisions=transcript.events.filter(row=>row.kind==='decision');
  assert.deepEqual(decisions.map(row=>JSON.parse(row.record).name),[
    'track_create','track_join','track_progress','track_complete'
  ]);
  for(const row of decisions){
    const record=JSON.parse(row.record);
    assert.equal(row.record,stableAlgorithmJSON(record),'teacher target bytes must be canonical');
    assert.equal(row.context.schema,'semantic-orchestration-context/8');
  }
  assert.deepEqual(artifact.public.timeline.map(row=>row.mode),['observed','observed','generated','generated']);
  assert.deepEqual(artifact.public.timeline.slice(0,2).map(row=>row.kind),['program','invocation']);
  assert.equal(transcript.child.track,'track:1');
  assert.deepEqual(JSON.parse(decisions[0].record).arguments.execution,transcript.ingress.execution);
  assert.deepEqual(transcript.events.find(row=>row.kind==='ack'&&row.for===1).receipt.completion_dependency,
    transcript.child.dependency);
  assert.deepEqual(JSON.parse(decisions[1].record).arguments.completion_dependency,transcript.child.dependency);
  assert.deepEqual(transcript.child.delivered.dependency,transcript.child.dependency);
  assert.equal(transcript.child.completion.schema,'semantic-child-completion/8');
  assert.equal(transcript.child.delivered.schema,'semantic-completion/4');
  assert.equal(transcript.child.delivered.parent,'track:0');
  assert.equal(transcript.child.delivered.target,'track:0');

  const replay=RegionExecutionHarness.replay(artifact.public),terminal=replay.modelContext(transcript.ingress.invocationId).state;
  assert.deepEqual(transcript.child.completion.completion,terminal.completion);
  assert.deepEqual(transcript.child.completion.heap,terminal.heap);
  assert.equal(transcript.child.completion.publicDigest,hashAlgorithmData(artifact.public));
  assert.equal(transcript.child.completion.contextsDigest,hashAlgorithmData(artifact.contexts));
  assert.deepEqual(transcript.child.completion.completion,{kind:'return',value:['num',6]});
  const lifecycleKeys=new Set(['payloadHex','selectionId','modelSelected','checkpointIdentity','emittedTokenIds']);
  const found=[];
  const visit=(value,path='transcript')=>{
    if(!value||typeof value!=='object')return;
    for(const [key,child]of Object.entries(value)){
      if(lifecycleKeys.has(key))found.push(path+'.'+key);
      visit(child,path+'.'+key);
    }
  };
  visit(transcript);
  assert.deepEqual(found,[],'authored teacher targets cannot claim model-selection evidence');
});

test('the transcript digest cannot bless missing, reordered, or rehashed altered teacher events',()=>{
  rejectedTranscript('missing event',candidate=>candidate.events.splice(1,1));
  rejectedTranscript('reordered events',candidate=>{
    [candidate.events[0],candidate.events[1]]=[candidate.events[1],candidate.events[0]];
  });
  rejectedTranscript('digest mismatch',candidate=>{candidate.events[0].record+=' ';},{rehashDigest:false});
  rejectedTranscript('rehashed noncanonical physical target bytes',candidate=>{candidate.events[0].record+=' ';});
  rejectedTranscript('invented model-selection receipt fields',candidate=>{
    candidate.events[0].selection={modelSelected:true,selectionId:'fake'};
  });
  rejectedTranscript('relabelled controlled teacher origin',candidate=>{
    candidate.origin='controlled-or-model-output-unverified';
  });
});

test('source, input, causal context, ownership, dependency and terminal bytes remain bound',()=>{
  const changedSource=structuredClone(baseline);
  changedSource.public.timeline[0].fields.source+='\n// changed source bytes';
  assert.throws(()=>validateOrchestrationTranscriptV8(changedSource),undefined,'source bytes changed');

  const changedInput=structuredClone(baseline);
  changedInput.public.timeline[1].fields.inputGraph.roots[0][1]=4;
  assert.throws(()=>validateOrchestrationTranscriptV8(changedInput),undefined,'child input changed');

  const futureContext=structuredClone(baseline);
  event(futureContext,'decision',1).context.children[0].completion=
    structuredClone(futureContext.sidecar.orchestrationTranscript.child.completion);
  rehash(futureContext);
  assert.throws(()=>validateOrchestrationTranscriptV8(futureContext),undefined,'decision sees future child completion');

  rejectedTranscript('foreign child owner',candidate=>{
    const receipt=candidate.events.find(row=>row.kind==='ack'&&row.for===1).receipt;
    receipt.track.parent='track:foreign';
  });
  rejectedTranscript('foreign completion dependency',candidate=>{
    candidate.child.dependency.track='track:foreign';
  });
  rejectedTranscript('altered child heap',candidate=>candidate.child.completion.heap.push(['ref','foreign-object']));
  rejectedTranscript('altered terminal completion',candidate=>{candidate.child.completion.completion.value[1]=99;});
  rejectedTranscript('altered terminal source cut',candidate=>{candidate.child.publicDigest='0'.repeat(64);});

  const changedPhysicalBytes=structuredClone(baseline);
  event(changedPhysicalBytes,'decision',1).record+=' ';
  rehash(changedPhysicalBytes);
  assert.throws(()=>validateOrchestrationTranscriptV8(changedPhysicalBytes),undefined,
    'JSON-equivalent but byte-different target must fail');

  assert.equal(isDeepStrictEqual(artifact.public,baseline.public),true);
});

test('attachment refuses controlled source origin and artifacts already bound or admitted',async()=>{
  const controlled=structuredClone(sourceArtifact);
  controlled.sidecar.sourceArtifact.sidecar.selectionOrigin='controlled-or-model-output-unverified';
  controlled.sidecar.sourceArtifactDigest=hashAlgorithmData(controlled.sidecar.sourceArtifact);
  await assert.rejects(attachSourceQualifiedOrchestrationV8(controlled),/teacher|origin|selection|source/i);

  for(const [field,value]of [
    ['datasetBinding',{schema:'semantic-dataset-binding/1'}],
    ['splitIdentity',{schema:'semantic-split-identity/1'}],
    ['nativeAdmission',{schema:'semantic-native-admission/8',admitted:true}]
  ]){
    const bound=structuredClone(sourceArtifact);bound.sidecar[field]=value;
    await assert.rejects(attachSourceQualifiedOrchestrationV8(bound),/before dataset binding|native admission/);
  }
  await assert.rejects(attachSourceQualifiedOrchestrationV8(artifact),/already carry a transcript/);
});

test('family-bound local diagnostic serialization keeps four flat lifecycle targets loss-masked and source-bound',async()=>{
  const prepared=prepareRegionFamilyRegistry([sourceArtifact,artifact],{seed:17}),
    plain=prepared.members[0],withTranscript=prepared.members[1],registry=prepared.registry;
  assert.equal(prepared.members.length,2);
  assert.notEqual(plain.id,withTranscript.id,'same public child with a transcript is a distinct candidate');
  assert.equal(plain.duplicateOf,undefined);assert.equal(withTranscript.duplicateOf,undefined);
  assert.equal(registry.sources.length,2);
  assert.equal(registry.components.length,1,'same source and family stay in the same holdout component');
  assert.equal(registry.sources[0].family,registry.sources[1].family);
  assert.equal(registry.sources[0].sourceDigest,registry.sources[1].sourceDigest);
  assert.equal(prepared.identityById.get(plain.id).componentId,prepared.identityById.get(withTranscript.id).componentId);
  const bound=bindRegionFamilySplit(artifact,withTranscript,registry),identity=prepared.identityById.get(withTranscript.id),
    tokenizer={identity:'e'.repeat(64),encode:text=>[...Buffer.from(text)],decode:ids=>Buffer.from(ids)},
    examples=await buildCausalLmV8Examples(bound,{tokenizer,eosTokenId:256,maxContextTokens:1000000,
      allowLocal:true,expectedSplit:identity.split});
  assert.equal(bound.sidecar.splitIdentity.sourceId,withTranscript.id);
  assert.equal(bound.sidecar.datasetBinding.orchestrationTranscriptDigest,hashAlgorithmData(transcript));
  assert.equal(examples.length,6,'two normal generated records and four lifecycle targets are flattened');
  assert.deepEqual(examples.map(row=>[row.recordKind,row.metadata.sequence,row.metadata.orchestrationOrdinal??null]),[
    ['orchestration',2,1],['orchestration',2,4],['algorithm',3,null],['semantic',4,null],
    ['orchestration',4,7],['orchestration',4,9]
  ]);
  const targets=examples.filter(row=>row.recordKind==='orchestration');
  assert.deepEqual(targets.map(row=>row.target),transcript.events.filter(row=>row.kind==='decision').map(row=>row.record));
  assert.deepEqual(targets.map(row=>row.metadata.orchestrationTranscriptDigest),
    Array(4).fill(hashAlgorithmData(transcript)));
  assert.deepEqual(targets.map(row=>row.metadata.contextVisibleThrough),[2,2,4,4]);
  for(const row of examples){
    assert.equal(row.metadata.sourceFamily,fixture.family);
    assert.equal(row.metadata.sourceId,identity.sourceId);
    assert.equal(row.metadata.sourceComponent,identity.componentId);
    assert.equal(row.metadata.split,identity.split);
    assert.equal(row.metadata.publicDigest,bound.sidecar.publicDigest);
    assert.equal(row.metadata.contextDigest,bound.sidecar.contextDigest);
    assert.equal(row.metadata.sourceAdmission,'passed');
    assert.equal(row.metadata.nativeAdmission,false,'allowLocal is diagnostic, not native admission');
    assert.equal(row.metadata.optimizerSteps,0);assert.equal(row.metadata.learningClaim,null);
    assert.deepEqual(row.labels.slice(0,row.boundaries.promptTokens),Array(row.boundaries.promptTokens).fill(-100));
    assert.deepEqual(row.labels.slice(row.boundaries.promptTokens),[...Buffer.from(row.target),256]);
    assert.deepEqual(row.inputIds,[...tokenizer.encode(row.prompt),...tokenizer.encode(row.target),256]);
  }
  const byOrdinal=new Map(targets.map(row=>[row.metadata.orchestrationOrdinal,row]));
  for(const ordinal of [1,4]){
    assert.match(byOrdinal.get(ordinal).prompt,/Next action:/);
    const context=transcript.events.find(event=>event.ordinal===ordinal).context;
    assert.equal(context.children[0].completion,null,'pre-terminal coordinator input cannot see future child completion');
    assert.equal(byOrdinal.get(ordinal).prompt,causalLmV8OrchestrationPrompt(context));
  }
  for(const ordinal of [7,9]){
    const context=transcript.events.find(event=>event.ordinal===ordinal).context;
    assert.equal(context.children[0].completion.completion.kind,'return');
    assert.equal(byOrdinal.get(ordinal).prompt,causalLmV8OrchestrationPrompt(context));
  }
  assert.equal(isDeepStrictEqual(sourceArtifact,sourceBefore),true,'binding/serialization cannot mutate original source evidence');
});
