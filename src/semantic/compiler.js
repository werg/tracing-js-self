// The algorithm teacher is a source-certified projection of a private owned
// archive. Its serving controller never imports this module or that archive.
import {isDeepStrictEqual} from 'node:util';
import {validateBundle} from '../validation.js';
import {replayExact} from '../replay.js';
import {normalizeJournal,validateSemantic} from './normalize.js';
import {describeOwnedGraph} from '../training/graph.js';
import {ownedEffectfulOutcome} from '../training/effectful-compiler.js';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission} from '../training/effectful-admit.js';
import {evaluateTerm} from './operations.js';
import {compareObservableGraphs} from './observables.js';
import {createTransformationReceipt} from './provenance.js';
import {AlgorithmExecutionHarness} from './harness.js';
import {defineAlgorithmProgram,hashAlgorithmData} from './program.js';
import {decodeAlgorithmRecord} from './trace-codec.js';

const copy=value=>structuredClone(value);
const eq=isDeepStrictEqual;
function refuse(message){const error=new Error('Algorithm teacher projection: '+message);
  error.category='unsupported.algorithm-projection';throw error;}
const uniqueInputIds=roots=>[...new Set(roots.filter(value=>value[0]==='ref').map(value=>value[1]))];

function interactions(bundle){
  const rows=[];
  for(const event of bundle.events){
    if(event.operation==='effect.dispatch'){
      const id=event.causes.find(cause=>cause.kind==='effect')?.effectId;
      const effect=event.stateChanges.find(change=>change.table==='effects'&&change.id===id)?.after;
      if(!effect)refuse('dispatch has no immutable journal state');
      rows.push({kind:'dispatch',id,operation:effect.operation,arguments:copy(effect.args),
        payload:effect.request.payload,journalEvent:event.eventId});
    }else if(event.operation==='external.input.deliver'){
      const id=event.causes.find(cause=>cause.kind==='effect')?.effectId;
      const inputId=event.causes.find(cause=>cause.kind==='input')?.inputId;
      const input=event.stateChanges.find(change=>change.table==='inputs'&&change.id===inputId)?.after;
      if(!input||input.effectId!==id||!Array.isArray(input.value)||input.graph)
        refuse('observation is outside the scalar profile');
      rows.push({kind:'observe',id,status:input.abrupt?'rejected':'fulfilled',
        value:copy(input.value),journalEvent:event.eventId});
    }
  }
  return rows;
}

export function compileAlgorithmWitness(bundle,{sessionId='algorithm1',invocationId='invocation1'}={}){
  validateBundle(bundle);replayExact(bundle);
  const semantic=normalizeJournal(bundle);validateSemantic(bundle,semantic);
  if(bundle.entrySpec?.kind!=='function')refuse('explicit function entry required');
  const entry=bundle.entrySpec;
  const source=bundle.sources.find(item=>item.sourceId===entry.sourceId)?.text;
  if(typeof source!=='string')refuse('exact source bytes are missing');
  const {program,provenance}=defineAlgorithmProgram({source,entry:entry.functionName});
  const initial=describeOwnedGraph(bundle.initialState.heap,entry.arguments);
  const inputGraph={roots:initial.roots,objects:initial.objects.map(node=>({id:node.id,kind:node.kind,
    ...(node.prototype===null?{prototype:null}:{}),properties:node.properties.map(({key,value})=>({key,value}))}))};
  const capabilities=[...new Set(program.boundaries.map(boundary=>boundary.operation))];
  const harness=new AlgorithmExecutionHarness({program,inputGraph,capabilities,sessionId,invocationId});
  const external=interactions(bundle),contexts=[],certificates=[];
  let cursor=0;
  const emit=record=>{
    contexts.push(copy(harness.modelContext()));
    const result=harness.select(record);
    if(!result.claim.consistent)refuse('teacher emitted an incorrect semantic claim');
    certificates.push({record:harness.controller.history.length-1,
      rule:record.kind==='request'?'certified-effect-boundary/1':'checked-algorithm-operation/1',
      digest:hashAlgorithmData(harness.controller.history.at(-1).line),
      sourceDigest:program.sourceDigest,definitionDigest:program.definitionDigest});
    return result;
  };
  while(!harness.controller.completion){
    const controller=harness.controller,step=controller.nextStep();
    if(!step)refuse('missing algorithm completion');
    if(step.kind==='compute')emit({...step,result:evaluateTerm(step.term,controller.environment())});
    else if(step.kind==='request'){
      const expected=external[cursor++];
      const args=step.arguments.map(term=>evaluateTerm(term,controller.environment()));
      if(expected?.kind!=='dispatch'||expected.operation!==step.operation||!eq(args,expected.arguments))
        refuse('semantic effect differs from owned dispatch order, operation or arguments');
      const {dispatch}=emit({...step,arguments:args});
      if(dispatch.payload!==expected.payload)refuse('derived host payload differs from dispatch snapshot');
      const intent=harness.intents.get(step.id);intent.status='dispatched';
      harness.timeline.push({mode:'observed',kind:'dispatch',request:step.id,key:intent.key,attempt:1});
      const observed=external[cursor++],next=controller.nextStep();
      if(observed?.kind!=='observe'||observed.id!==expected.id||next?.kind!=='observe')
        refuse('serial profile requires the matching delivery before another dispatch');
      harness.deliver({kind:'observe',request:step.id,id:next.id,status:observed.status,value:observed.value});
      if(controller.completion?.kind==='unsupported')refuse(controller.completion.reason);
      certificates.at(-1).journalEvents=[expected.journalEvent,observed.journalEvent];
    }else if(step.kind==='return'||step.kind==='throw')
      emit({kind:step.kind,value:evaluateTerm(step.value,controller.environment())});
    else refuse('unimplemented certified operation '+step.kind);
  }
  if(cursor!==external.length)refuse('algorithm omitted owned external interactions');
  const expected=ownedEffectfulOutcome(bundle),completion=harness.controller.completion;
  const visible={roots:[...inputGraph.roots,completion.value],objects:inputGraph.objects};
  const graphCheck=compareObservableGraphs(visible,expected.graph,{
    leftInputIds:uniqueInputIds(inputGraph.roots),
    rightInputIds:uniqueInputIds(expected.graph.roots.slice(0,entry.arguments.length))});
  if(expected.kind!==completion.kind||!graphCheck.equal)
    refuse('completion, input state, or rooted aliases differ from owned execution: '+(graphCheck.reason??''));
  const publicEpisode=harness.exportEpisode();
  const sourceSites=(provenance.sourceSites??[]).map(row=>row.site)
    .concat(program.boundaries.map(boundary=>boundary.source));
  const receipt=createTransformationReceipt({rule:'certified-source-algorithm',source,
    input:program.core,output:program.core,sourceSites,
    journalEvents:bundle.events.map(event=>event.eventId),
    preconditions:copy(provenance.inputGuards??provenance.preconditions??[]),
    liveInputs:program.core.inputs.map(input=>input.id),
    liveOutputs:program.core.steps.filter(step=>step.kind==='compute').map(step=>step.id),
    effectBoundaries:copy(program.boundaries)});
  const exported={public:publicEpisode,contexts,sidecar:{schema:'semantic-algorithm-evidence/1',
    admission:'projected',referenceStatus:'unverified',selectionOrigin:'owned-interpreter-teacher',
    representation:'semantic-trace/7',sourceDigest:program.sourceDigest,archiveDigest:hashAlgorithmData(bundle),
    definitionDigest:program.definitionDigest,coreDigest:program.coreDigest,provenance,receipt,certificates,
    publicDigest:hashAlgorithmData(publicEpisode),contextDigest:hashAlgorithmData(contexts),
    nativeAdmission:null,optimizerSteps:0,learningClaim:null}};
  // Continuation replay is a separate check of selected state and authority;
  // it does not dispatch a service or read a future teacher observation.
  const restored=AlgorithmExecutionHarness.restore(harness.checkpoint());
  if(restored.controller.firstViolation||!eq(restored.controller.completion,completion))
    refuse('selected continuation replay disagrees');
  return {exported,semantic,core:copy(program.core),provenance,outcome:expected};
}

export function verifyAlgorithmProjection(bundle,exported,options={}){
  const rebuilt=compileAlgorithmWitness(bundle,options).exported;
  if(!eq(rebuilt.public,exported.public)||!eq(rebuilt.contexts,exported.contexts))
    throw new Error('Algorithm public claims or causal contexts changed');
  for(const key of ['schema','representation','sourceDigest','archiveDigest','definitionDigest','coreDigest',
    'provenance','receipt','certificates','publicDigest','contextDigest'])
    if(!eq(rebuilt.sidecar[key],exported.sidecar?.[key]))throw new Error('Algorithm private evidence changed: '+key);
  return {valid:true,publicDigest:rebuilt.sidecar.publicDigest,contextDigest:rebuilt.sidecar.contextDigest};
}

/** The existing private replay and four independent source audits certify the
 * source before this candidate is used. A v6 native receipt never admits v7. */
export async function verifyAlgorithmTrainingCase(fixture){
  const detailed=await verifyEffectfulTrainingCase({...fixture,nativeConsumer:null,nativePolicy:null});
  if(!['locally_verified','admitted'].includes(detailed.status))return {...detailed,
    algorithmDisposition:'source-unqualified',exported:undefined};
  try{
    const compiled=compileAlgorithmWitness(detailed.exported.sidecar.archive);
    const exported=compiled.exported;
    Object.assign(exported.sidecar,{admission:'locally_verified',referenceStatus:'agreed',
      sourceEvidence:{identityDigest:detailed.exported.sidecar.identityDigest,
        sourceChecks:copy(detailed.exported.sidecar.reference.sourceChecks),
        referenceOutcome:copy(detailed.exported.sidecar.reference.outcome)},
      family:fixture.family,fixtureDigest:detailed.exported.sidecar.sourceProvenance.fixtureDigest});
    return {status:'locally_verified',exported,detailed:detailed.exported,core:compiled.core};
  }catch(error){
    return {status:'detailed-fallback',disposition:'certified-detailed-trace',
      reason:error.message,category:error.category??'unsupported.algorithm-profile',
      detailed:detailed.exported,exported:null};
  }
}

export async function recheckAlgorithmEvidence(exported,detailed){
  const source=await recheckEffectfulAdmission(detailed,{requireAdmitted:false});
  if(exported.sidecar?.admission!=='locally_verified'||exported.sidecar.referenceStatus!=='agreed'||
    exported.sidecar.sourceEvidence?.identityDigest!==detailed.sidecar.identityDigest||
    !eq(exported.sidecar.sourceEvidence.sourceChecks,detailed.sidecar.reference.sourceChecks)||
    !eq(exported.sidecar.sourceEvidence.referenceOutcome,detailed.sidecar.reference.outcome))
    throw new Error('Algorithm source evidence is missing or changed');
  const projection=verifyAlgorithmProjection(detailed.sidecar.archive,exported);
  return {valid:true,admitted:false,source,projection,
    native:{status:'unavailable',reason:'No qualified semantic-trace/7 native consumer receipt'}};
}

export function checkAlgorithmCounterfactualPrefixes(left,right){
  const a=left.public.timeline,b=right.public.timeline;let index=0;
  while(index<Math.min(a.length,b.length)&&eq(a[index],b[index]))index++;
  if(index===Math.min(a.length,b.length)||a[index].mode!=='observed'||b[index].mode!=='observed'||
    a[index].kind!=='observation'||b[index].kind!=='observation'||
    decodeAlgorithmRecord(a[index].line).request!==decodeAlgorithmRecord(b[index].line).request)
    throw new Error('Future response changed an earlier algorithm prefix');
  return {valid:true,identicalRows:index,firstChangedObservation:index};
}
