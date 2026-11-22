// Authored lifecycle targets for one independently source-qualified V8 child.
// This teacher never samples a model, fabricates selection evidence, or changes
// the semantic public timeline. Production admission must replay both machines.
import {isDeepStrictEqual} from 'node:util';
import {stableAlgorithmJSON} from './ir.js';
import {hashAlgorithmData} from './program.js';
import {RegionExecutionHarness} from './region-harness.js';
import {validateRegionTrainingContexts} from './causal-lm-v8.js';
import {nativeV8OrchestrationContext} from './native-orchestration-transport-v8.js';

const copy=structuredClone;
const demand=(condition,message)=>{if(!condition)throw new TypeError('V8 orchestration training: '+message);};
const freeze=value=>{if(value&&typeof value==='object'){
  for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

export const V8_ORCHESTRATION_TRAINING_POLICY=freeze({
  schema:'semantic-orchestration-policy/1',name:'create-join-publish-complete',maxActive:1,maxWaiting:17,
  coordinator:{track:'track:0',purpose:'Execute the declared V8 child tasks and publish their exact results',
    completion:'All declared children completed and their exact results were published',budget:100000},
  child:{track:'track:1',purpose:'Run the exact declared V8 source',completion:'Deliver its exact result',budget:64}
});

const description=(policy,capabilities,extra={})=>({address:policy.track,purpose:policy.purpose,label:'',
  parent:null,completion:policy.completion,capabilities,budget:policy.budget,revision:0,status:'active',
  prerequisites:[],progress:'',execution:null,bootstrap_ready:false,...extra});

function requireTeacherProvenance(document){
  const side=document?.sidecar,sourceSide=side?.sourceArtifact?.sidecar,
    eligible=new Set(['owned-interpreter-teacher','certified_teacher']);
  demand(side&&['semantic-region-evidence/1','semantic-protocol-region-evidence/1',
    'semantic-protocol-host-region-evidence/1'].includes(side.schema),
    'a source-qualified teacher artifact is required');
  if(side.schema==='semantic-region-evidence/1')demand(eligible.has(sourceSide?.selectionOrigin),
    'the original source selection is not a qualified teacher target');
  for(const evidence of [side,sourceSide])if(evidence&&Object.hasOwn(evidence,'selectionOrigin'))
    demand(eligible.has(evidence.selectionOrigin),'controlled or unverified model evidence cannot become teacher provenance');
}

/** Structural construction only. The asynchronous attaching entry below checks
 * original source correspondence before this becomes an eligible teacher target.
 */
export function buildOrchestrationTranscriptV8(document){
  const publicData=document?.public,rows=publicData?.timeline,contexts=document?.contexts;
  demand(Array.isArray(rows)&&rows.length>=3&&Array.isArray(contexts),'complete public/context artifact required');
  const [program,invocation]=rows,source=program?.fields,input=invocation?.fields;
  demand(program?.sequence===1&&program.mode==='observed'&&program.kind==='program'&&
    invocation?.sequence===2&&invocation.mode==='observed'&&invocation.kind==='invocation'&&
    rows.slice(2).every(row=>!['program','invocation'].includes(row.kind)),
    'one source followed by one declared root input is required');
  demand(input.activation==='call'&&input.parentInvocationId===null&&input.closureId===null&&
    input.taskRevision===1&&['fresh','retained'].includes(input.realmPolicy)&&source.session===input.session&&
    source.programId===input.programId&&source.digest===hashAlgorithmData(source.source)&&
    input.sourceDigest===source.digest,'one immutable initial root child is required');
  demand(rows.at(-1).mode==='generated'&&rows.at(-1).fields.invocationId===input.invocationId,
    'the complete child cut must end at its generated terminal boundary');
  validateRegionTrainingContexts(document);
  const harness=RegionExecutionHarness.replay(publicData),activation=harness.activation(input.invocationId),
    terminal=harness.modelContext(input.invocationId).state;
  demand(activation.status==='completed'&&['return','throw'].includes(terminal.completion?.kind),
    'the child lacks an independently replayed terminal result');
  const policy=V8_ORCHESTRATION_TRAINING_POLICY,coordinatorTrack=policy.coordinator.track,childTrack=policy.child.track,
    initialPublic={...copy(publicData),timeline:copy(rows.slice(0,2))},initialDigest=hashAlgorithmData(initialPublic),
    publicDigest=hashAlgorithmData(publicData),contextsDigest=hashAlgorithmData(contexts),
    execution={schema:'semantic-execution-binding/4',program_id:source.programId,source_digest:source.digest,
      entry:input.entry,invocation_id:input.invocationId,realm_id:input.realmId,trigger_id:input.triggerId,
      input_ref:hashAlgorithmData(input.inputGraph),realm_policy:input.realmPolicy,
      completion_mode:input.completionPolicy,capability_grants:copy(source.capabilities),completion_target:coordinatorTrack},
    capabilities=[...new Set(['text',...source.capabilities])],
    coordinator=description(policy.coordinator,[...new Set(['text',...[...source.capabilities].sort()])]),
    child=description(policy.child,capabilities,{parent:coordinatorTrack,status:'waiting',execution:copy(execution)}),
    dependency={schema:'semantic-completion-dependency/4',id:'completion:'+childTrack+':0',
      track:childTrack,revision:0,invocation:input.invocationId},
    completion={schema:'semantic-child-completion/8',session:source.session,invocationId:input.invocationId,
      track:childTrack,completion:copy(terminal.completion),heap:copy(terminal.heap),publicDigest,contextsDigest},
    delivered={schema:'semantic-completion/4',dependency:copy(dependency),kind:terminal.completion.kind,
      value:copy(terminal.completion.value),parent:coordinatorTrack,target:coordinatorTrack};
  const state={session:source.session,track:coordinatorTrack,
    children:[{program:copy(program),invocation:copy(invocation),execution:copy(execution),track:null,completion:null}],
    tracks:[coordinator],receipts:[],published:[],publicDigest:initialDigest},events=[];
  const event=(afterPublicSequence,kind,extra)=>events.push({ordinal:events.length+1,afterPublicSequence,kind,...copy(extra)});
  const decision=(afterPublicSequence,name,args)=>{
    event(afterPublicSequence,'decision',{context:nativeV8OrchestrationContext(state),
      record:stableAlgorithmJSON({name,arguments:args})});return events.length;};
  const ack=(afterPublicSequence,ordinal,track,extra={})=>event(afterPublicSequence,'ack',{for:ordinal,
    receipt:{schema:'semantic-orchestration-teacher-commit/1',committed:true,track:copy(track),...copy(extra)}});

  const create=decision(2,'track_create',{purpose:child.purpose,completion:child.completion,
    budget:child.budget,capabilities:copy(child.capabilities),execution:copy(execution)});
  state.children[0].track=childTrack;state.tracks.push(child);
  ack(2,create,child,{completion_dependency:dependency});
  child.bootstrap_ready=true;
  event(2,'bootstrap',{receipt:{schema:'semantic-orchestration-bootstrap/8',track:copy(child),bootstrapped:true}});
  const join=decision(2,'track_join',{address:coordinatorTrack,completion_dependency:copy(dependency)});
  coordinator.status='waiting';coordinator.prerequisites=[dependency.id];child.status='active';
  ack(2,join,coordinator);

  child.status='completed';coordinator.status='active';state.children[0].completion=copy(completion);
  state.receipts.push(copy(delivered));state.publicDigest=publicDigest;
  event(rows.length,'completion',{receipt:completion,delivered});
  const progress=stableAlgorithmJSON(terminal.completion),publish=decision(rows.length,'track_progress',
    {address:coordinatorTrack,progress});
  coordinator.progress=progress;state.published.push(input.invocationId);ack(rows.length,publish,coordinator);
  const complete=decision(rows.length,'track_complete',{address:coordinatorTrack});
  coordinator.status='completed';ack(rows.length,complete,coordinator);
  const body={schema:'semantic-orchestration-transcript/1',origin:'source-qualified-teacher',
    policy:{...copy(policy),digest:hashAlgorithmData(policy)},session:source.session,coordinatorTrack,
    ingress:{publicDigest:initialDigest,throughSequence:2,programSequence:1,invocationSequence:2,
      sourceDigest:source.digest,invocationId:input.invocationId,execution:copy(execution)},
    child:{track:childTrack,dependency:copy(dependency),terminalPublicSequence:rows.length,publicDigest,
      contextsDigest,completion,delivered},events};
  return {...body,digest:hashAlgorithmData(body)};
}

/** Compare with an independent reconstruction, not a self-reported digest. */
export function validateOrchestrationTranscriptV8(document){
  requireTeacherProvenance(document);
  const transcript=document?.sidecar?.orchestrationTranscript;
  demand(transcript&&isDeepStrictEqual(transcript,buildOrchestrationTranscriptV8(document)),
    'transcript differs from its source-bound lifecycle, causal contexts or exact child result');
  return {valid:true,orchestrationValidated:true,orchestrationRecords:4,
    orchestrationTranscriptDigest:hashAlgorithmData(transcript)};
}

/** A new authored teacher policy, kept separate from diagnostic model fixtures. */
export async function attachSourceQualifiedOrchestrationV8(document){
  requireTeacherProvenance(document);
  demand(document?.sidecar&&!Object.hasOwn(document.sidecar,'orchestrationTranscript'),
    'source artifact must not already carry a transcript');
  demand(!['datasetBinding','splitIdentity'].some(key=>Object.hasOwn(document.sidecar,key))&&
    document.sidecar.nativeAdmission==null,
    'attach the lifecycle targets before dataset binding or native admission');
  const captured=copy(document),{recheckRegionEvidence}=await import('./compiler-v8.js');
  const checked=await recheckRegionEvidence(captured,{requireNative:false});
  demand(checked.valid&&checked.sourceValidated&&checked.projectionValidated&&checked.replayValidated,
    'the original child requires independent source, projection and replay qualification');
  captured.sidecar.orchestrationTranscript=buildOrchestrationTranscriptV8(captured);
  validateOrchestrationTranscriptV8(captured);return captured;
}
