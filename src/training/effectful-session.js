// Source-certified repeated ingress. Each activation is collected independently
// in its own realm, including its retained callback activations. Source
// publication is shared, private authorities are retained per activation, and
// the resulting whole session is native-admitted. Certified identities are
// never rewritten to make independently collected components fit together.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {SelectedExecutionHarness} from './harness-v4.js';
import {hostOperationContract,hostOperation} from '../host/operations.js';
import {defaultSplitIdentity,bindAdmissionIdentity,verifyAdmissionIdentity,admissionEnvironment}
  from './admission-identity.js';
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const copy=x=>structuredClone(x);

function composeEffectfulSession(components,{family,seed=17,producerRevision=null,split,splitIdentity}={}){
  if(!Array.isArray(components)||components.length<2||typeof family!=='string'||!family)
    throw new TypeError('A source family and two independently collected activations are required');
  const first=components[0],timeline=[],programs=new Map(),programDeclarations=new Map(),owners=new Map();
  const seenInvocations=new Set(),seenRealms=new Set(),seenSubscriptions=new Set(),seenIngress=new Set();
  const effects=[],calls=[],settlementOrder=[];let callOffset=0;
  for(const component of components){
    verifyAdmissionIdentity(component);
    if(component.sidecar.referenceStatus!=='agreed'||component.sidecar.producerRevision!==producerRevision||
      component.sidecar.sourceFamily!==family||component.sidecar.sourceProvenance.seed!==seed||
      component.sidecar.representation!==first.sidecar.representation||
      component.sidecar.license!==first.sidecar.license||component.sidecar.trustTier!==first.sidecar.trustTier||
      !isDeepStrictEqual(component.sidecar.splitIdentity,splitIdentity)||
      !isDeepStrictEqual(component.sidecar.nativePolicy,first.sidecar.nativePolicy))
      throw new Error('Every session component needs the same pinned source authority');
    const activations=component.public.timeline.filter(item=>item.kind==='invocation');
    const roots=activations.filter(item=>item.parentInvocationId===null);
    if(roots.length!==1||roots[0].activation==='callback'||seenRealms.has(roots[0].realmId))
      throw new Error('Each independently collected component requires one isolated root realm');
    const root=roots[0],componentInvocations=new Map();
    seenRealms.add(root.realmId);
    for(const original of component.public.timeline){
      if(original.session!==first.public.timeline[0].session)throw new Error('Session identities differ');
      if(original.kind==='program'){
        const declaration=copy(original);delete declaration.sequence;delete declaration.ownerSequence;
        if(programs.has(original.programId)){
          if(programs.get(original.programId)!==original.digest||
            !isDeepStrictEqual(programDeclarations.get(original.programId),declaration))
            throw new Error('Immutable program changed');
          continue;
        }
        programs.set(original.programId,original.digest);
        programDeclarations.set(original.programId,declaration);
      }
      if(original.kind==='invocation'){
        if(seenInvocations.has(original.invocationId)||seenIngress.has(original.ingressKey))
          throw new Error('Certified invocation or ingress identity collision between session components');
        if(original.realmId!==root.realmId||original.programId!==root.programId)
          throw new Error('Component invocation escaped its independently collected root realm');
        if(original!==root){
          const parent=componentInvocations.get(original.parentInvocationId);
          if(!parent||original.activation!=='callback'||original.realmPolicy!=='retained'||
            original.closureId===null||parent.realmId!==original.realmId||parent.programId!==original.programId)
            throw new Error('Retained callback requires an earlier certified owner in its component realm');
        }
        seenInvocations.add(original.invocationId);
        seenIngress.add(original.ingressKey);
        componentInvocations.set(original.invocationId,original);
      }
      if(original.kind==='handler'){
        if(seenSubscriptions.has(original.subscriptionId))
          throw new Error('Certified subscription identity collision between session components');
        const owner=componentInvocations.get(original.ownerInvocationId);
        if(!owner||owner.realmId!==original.realmId||owner.programId!==original.programId||
          owner.track!==original.trackId||original.realmPolicy!=='retained')
          throw new Error('Subscription requires its certified owner and retained component realm');
        seenSubscriptions.add(original.subscriptionId);
      }
      let item=copy(original);item.sequence=timeline.length+1;
      if(item.kind==='model-context'&&Object.hasOwn(item,'selectedState')){
        // Absolute cutoffs and controller bootstrap cell names are relative to
        // this composed public prefix. Reconstruct the observed receipt from
        // that prefix; selected witness bytes and component certificates stay
        // unchanged, and no private final state participates in the refresh.
        const prefix=SelectedExecutionHarness.replay({public:{...copy(first.public),timeline}},
          {requireTerminal:false});
        item=copy(prefix.recordModelContext(item.invocationId,item.sourceReads,{includeState:true}));
      }
      item.ownerSequence=(owners.get(item.track)??0)+1;owners.set(item.track,item.ownerSequence);
      timeline.push(item);
    }
    for(const receipt of component.sidecar.effects)effects.push({...copy(receipt),call:receipt.call+callOffset,
      ...(receipt.subscriptionCall===undefined?{}:{subscriptionCall:receipt.subscriptionCall+callOffset})});
    calls.push(...component.sidecar.referenceInput.fixture.calls.map(call=>({...copy(call),
      ...(call.callbacks?{callbacks:call.callbacks.map(callback=>({...copy(callback),
        ...(callback.call===undefined?{}:{call:callback.call+callOffset})}))}:{})})));
    const plan=component.sidecar.referenceInput.fixture;
    const order=plan.settlementOrder??plan.calls.flatMap((call,index)=>
      hostOperation(call.operation).kind==='promise'?[index]:[]);
    settlementOrder.push(...order.map(index=>index+callOffset));
    callOffset+=component.sidecar.referenceInput.fixture.calls.length;
  }
  const publicEpisode={...copy(first.public),timeline};
  SelectedExecutionHarness.replay({public:publicEpisode});
  const ancestors=[...new Set([family,...components.flatMap(c=>c.sidecar.ancestorIds??[])])];
  const exported={public:publicEpisode,sidecar:{schema:first.sidecar.schema,admission:'locally_verified',
    representation:first.sidecar.representation,
    referenceStatus:'agreed',selectionOrigin:'owned-interpreter-teacher',sourceLineage:family,
    sourceFamily:family,fixtureFamily:family,ancestorIds:ancestors,split,splitIdentity,taskId:family,
    producerRevision,license:first.sidecar.license,trustTier:first.sidecar.trustTier,nativePolicy:copy(first.sidecar.nativePolicy),
    sourceProvenance:{family,license:first.sidecar.license,trustTier:first.sidecar.trustTier,seed,
      sourceDigest:hash([...programs]),fixtureDigest:hash(calls),
      upstream:components.map(component=>copy(component.sidecar.sourceProvenance.upstream))},
    executionLimits:components.map(component=>copy(component.sidecar.executionLimits)),
    seeds:copy(first.sidecar.seeds),environment:admissionEnvironment(),
    capabilityProfile:[...new Set(components.flatMap(c=>c.sidecar.capabilityProfile))].sort(),
    catalogDigest:hash(JSON.stringify(hostOperationContract(),null,2)+'\n'),effects,
    referenceInput:{fixture:{calls,settlementOrder}},
    reference:{outcomes:components.map(c=>copy(c.sidecar.reference.outcome))},
    collection:{schema:'semantic-teacher-session/4',components:copy(components),
      componentDigests:components.map(c=>hash(c.public)),publicDigest:hash(publicEpisode)},
    evidenceKind:'deterministic-engineering',optimizerSteps:0}};
  bindAdmissionIdentity(exported);return exported;
}

export async function verifyEffectfulSession({cases,family,nativeConsumer=null,seed=17,
    producerRevision=null,sessionId='teachersession',splitIdentity=null,seeds={},provenance={},nativePolicy=null}={}){
  if(!Array.isArray(cases)||cases.length<2)throw new TypeError('At least two source invocations are required');
  const {verifyEffectfulTrainingCase,bindNativeAdmission,validateNativePolicy}=await import('./effectful-admit.js');
  if(nativeConsumer||nativePolicy!==null)nativePolicy=validateNativePolicy(nativePolicy);
  splitIdentity=structuredClone(splitIdentity??defaultSplitIdentity(family,{seed}));
  const components=[],programs=new Map();let nextProgram=0;
  for(const [index,fixture] of cases.entries()){
    const componentSeeds={...seeds,...fixture.seeds};
    const randomSeed=fixture.randomSeed===undefined?(componentSeeds.guestRng??null):fixture.randomSeed;
    // A program declaration publishes its deterministic RNG fixture. Distinct
    // seeds require distinct declarations while preserving one source family.
    const digest=hash({source:fixture.source,randomSeed});
    if(!programs.has(digest))programs.set(digest,'program'+(++nextProgram));
    const result=await verifyEffectfulTrainingCase({...fixture,family,seed,producerRevision,splitIdentity,nativePolicy,
      seeds:componentSeeds,randomSeed,provenance:{...provenance,...fixture.provenance},
      projectionOptions:{...fixture.projectionOptions,sessionId,programId:programs.get(digest),invocationId:'ingress'+(index+1),
        trackId:'worker'+(index+1),realmId:'realm'+(index+1),realmPolicy:'fresh',triggerId:'outside'+(index+1)}});
    if(!result.exported)return result;
    components.push(result.exported);
  }
  const exported=composeEffectfulSession(components,{family,seed,producerRevision,split:splitIdentity.split,splitIdentity});
  if(nativeConsumer){
    const receipt=await nativeConsumer(exported);bindNativeAdmission(exported,receipt,nativePolicy);
  }
  return {status:exported.sidecar.admission,exported};
}

export async function recheckEffectfulSession(exported,{requireAdmitted=true,timeoutMs=10000,expectedIdentityDigest=null,nativePolicy=null}={}){
  const {recheckEffectfulAdmission,verifyNativeBinding}=await import('./effectful-admit.js');
  const side=exported.sidecar,collection=side.collection;
  verifyAdmissionIdentity(exported,{expectedIdentityDigest});
  for(const component of collection.components)
    await recheckEffectfulAdmission(component,{requireAdmitted:false,timeoutMs});
  const rebuilt=composeEffectfulSession(collection.components,{family:side.sourceFamily,
    seed:side.sourceProvenance.seed,producerRevision:side.producerRevision,
    split:side.splitIdentity.split,splitIdentity:side.splitIdentity});
  if(!isDeepStrictEqual(rebuilt.public,exported.public)||
    !isDeepStrictEqual(rebuilt.sidecar.collection,collection)||
    !isDeepStrictEqual(rebuilt.sidecar.effects,side.effects)||
    !isDeepStrictEqual(rebuilt.sidecar.reference,side.reference)||
    ['sourceProvenance','ancestorIds','catalogDigest','split','sourceFamily','referenceInput','representation']
      .some(field=>!isDeepStrictEqual(rebuilt.sidecar[field],side[field])))
    throw new Error('Repeated-ingress source certificates or public bytes changed');
  if(requireAdmitted){
    if(side.admission!=='admitted'||side.selectionOrigin!=='certified_teacher')throw new Error('Session not fully admitted');
    verifyNativeBinding(exported,nativePolicy);
  }
  return {schema:'semantic-source-admission/4',episodeDigest:hash(exported.public),
    identityDigest:side.identityDigest,identityValidated:true,
    producerRevision:side.producerRevision,catalogDigest:side.catalogDigest,referenceStatus:'agreed',
    journalValidated:true,replayValidated:true,sourceValidated:true,effectsValidated:true,optimizerSteps:0};
}
