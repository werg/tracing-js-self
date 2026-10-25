// Source-certified repeated ingress. Each activation is collected independently
// in its declared fresh realm; source publication is shared, private authorities
// are retained per activation, and the resulting whole session is native-admitted.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {SelectedExecutionHarness} from './harness-v4.js';
import {hostOperationContract,hostOperation} from '../host/operations.js';
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const copy=x=>structuredClone(x);

function composeEffectfulSession(components,{family,seed=17,producerRevision=null,split}={}){
  if(!Array.isArray(components)||components.length<2||typeof family!=='string'||!family)
    throw new TypeError('A source family and two independently collected activations are required');
  const first=components[0],timeline=[],programs=new Map(),owners=new Map(),seenInvocations=new Set();
  const effects=[],calls=[],settlementOrder=[];let callOffset=0;
  for(const component of components){
    if(component.sidecar.referenceStatus!=='agreed'||component.sidecar.producerRevision!==producerRevision||
      component.sidecar.sourceFamily!==family||component.sidecar.sourceProvenance.seed!==seed||
      component.sidecar.representation!==first.sidecar.representation)
      throw new Error('Every session component needs the same pinned source authority');
    for(const original of component.public.timeline){
      if(original.session!==first.public.timeline[0].session)throw new Error('Session identities differ');
      if(original.kind==='program'){
        if(programs.has(original.programId)){
          if(programs.get(original.programId)!==original.digest)throw new Error('Immutable program changed');
          continue;
        }
        programs.set(original.programId,original.digest);
      }
      if(original.kind==='invocation'){
        if(seenInvocations.has(original.invocationId)||original.realmPolicy!=='fresh')
          throw new Error('Repeated source collection requires distinct fresh activations');
        seenInvocations.add(original.invocationId);
      }
      const item=copy(original);item.sequence=timeline.length+1;
      item.ownerSequence=(owners.get(item.track)??0)+1;owners.set(item.track,item.ownerSequence);
      timeline.push(item);
    }
    for(const receipt of component.sidecar.effects)effects.push({...copy(receipt),call:receipt.call+callOffset});
    calls.push(...copy(component.sidecar.referenceInput.fixture.calls));
    const plan=component.sidecar.referenceInput.fixture;
    const order=plan.settlementOrder??plan.calls.flatMap((call,index)=>
      hostOperation(call.operation).kind==='promise'?[index]:[]);
    settlementOrder.push(...order.map(index=>index+callOffset));
    callOffset+=component.sidecar.referenceInput.fixture.calls.length;
  }
  const publicEpisode={...copy(first.public),timeline};
  SelectedExecutionHarness.replay({public:publicEpisode});
  const ancestors=[...new Set([family,...components.flatMap(c=>c.sidecar.ancestorIds??[])])];
  return {public:publicEpisode,sidecar:{schema:first.sidecar.schema,admission:'locally_verified',
    representation:first.sidecar.representation,
    referenceStatus:'agreed',selectionOrigin:'owned-interpreter-teacher',sourceLineage:family,
    sourceFamily:family,fixtureFamily:family,ancestorIds:ancestors,split,taskId:family,
    producerRevision,license:'repository-fixture',trustTier:'repository-fixture',
    sourceProvenance:{family,license:'repository-fixture',trustTier:'repository-fixture',seed,
      sourceDigest:hash([...programs]),fixtureDigest:hash(calls)},
    capabilityProfile:[...new Set(components.flatMap(c=>c.sidecar.capabilityProfile))].sort(),
    catalogDigest:hash(JSON.stringify(hostOperationContract(),null,2)+'\n'),effects,
    referenceInput:{fixture:{calls,settlementOrder}},
    reference:{outcomes:components.map(c=>copy(c.sidecar.reference.outcome))},
    collection:{schema:'semantic-teacher-session/4',components:copy(components),
      componentDigests:components.map(c=>hash(c.public)),publicDigest:hash(publicEpisode)},
    evidenceKind:'deterministic-engineering',optimizerSteps:0}};
}

export async function verifyEffectfulSession({cases,family,nativeConsumer=null,seed=17,
    producerRevision=null,sessionId='teachersession'}={}){
  if(!Array.isArray(cases)||cases.length<2)throw new TypeError('At least two source invocations are required');
  const {verifyEffectfulTrainingCase,requireNativeAdmission,effectfulFamilySplit}=await import('./effectful-admit.js');
  const components=[],programs=new Map();let nextProgram=0;
  for(const [index,fixture] of cases.entries()){
    const digest=hash(fixture.source);
    if(!programs.has(digest))programs.set(digest,'program'+(++nextProgram));
    const result=await verifyEffectfulTrainingCase({...fixture,family,seed,producerRevision,
      projectionOptions:{...fixture.projectionOptions,sessionId,programId:programs.get(digest),invocationId:'ingress'+(index+1),
        trackId:'worker'+(index+1),realmId:'realm'+(index+1),realmPolicy:'fresh',triggerId:'outside'+(index+1)}});
    if(!result.exported)return result;
    components.push(result.exported);
  }
  const exported=composeEffectfulSession(components,{family,seed,producerRevision,split:effectfulFamilySplit(family,{seed})});
  if(nativeConsumer){
    const receipt=await nativeConsumer(exported);requireNativeAdmission(exported,receipt);
    exported.sidecar.nativeAdmission=receipt;exported.sidecar.admission='admitted';
    exported.sidecar.selectionOrigin='certified_teacher';
  }
  return {status:exported.sidecar.admission,exported};
}

export async function recheckEffectfulSession(exported,{requireAdmitted=true,timeoutMs=10000}={}){
  const {recheckEffectfulAdmission,requireNativeAdmission,effectfulFamilySplit}=await import('./effectful-admit.js');
  const side=exported.sidecar,collection=side.collection;
  for(const component of collection.components)
    await recheckEffectfulAdmission(component,{requireAdmitted:false,timeoutMs});
  const rebuilt=composeEffectfulSession(collection.components,{family:side.sourceFamily,
    seed:side.sourceProvenance.seed,producerRevision:side.producerRevision,
    split:effectfulFamilySplit(side.sourceFamily,{seed:side.sourceProvenance.seed})});
  if(!isDeepStrictEqual(rebuilt.public,exported.public)||
    !isDeepStrictEqual(rebuilt.sidecar.collection,collection)||
    !isDeepStrictEqual(rebuilt.sidecar.effects,side.effects)||
    !isDeepStrictEqual(rebuilt.sidecar.reference,side.reference)||
    ['sourceProvenance','ancestorIds','catalogDigest','split','sourceFamily','referenceInput','representation']
      .some(field=>!isDeepStrictEqual(rebuilt.sidecar[field],side[field])))
    throw new Error('Repeated-ingress source certificates or public bytes changed');
  if(requireAdmitted){
    if(side.admission!=='admitted'||side.selectionOrigin!=='certified_teacher')throw new Error('Session not fully admitted');
    requireNativeAdmission(exported,side.nativeAdmission);
  }
  return {schema:'semantic-source-admission/4',episodeDigest:hash(exported.public),
    producerRevision:side.producerRevision,catalogDigest:side.catalogDigest,referenceStatus:'agreed',
    journalValidated:true,replayValidated:true,sourceValidated:true,effectsValidated:true,optimizerSteps:0};
}
