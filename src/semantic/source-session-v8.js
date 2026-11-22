// Teacher-only composition of independently checked source invocations. The
// selected runtime receives canonical V8 public rows, never component archives.
import {isDeepStrictEqual as equal} from 'node:util';
import {RegionExecutionHarness} from './region-harness.js';
import {hashAlgorithmData} from './program.js';
import {decodeRegionRecord,sharedRegionState,REGION_TRACE_VERSION} from './regions.js';

export const SOURCE_SESSION_EVIDENCE_V8='semantic-session-region-evidence/1';
export const SOURCE_SESSION_ARTIFACT_V8='semantic-session-source-evidence/1';
const componentSchemas=new Set(['semantic-region-evidence/1','semantic-protocol-region-evidence/1',
  'semantic-protocol-host-region-evidence/1']);
const clone=structuredClone,clean=value=>JSON.parse(JSON.stringify(value));
const digest=value=>hashAlgorithmData(clean(value));
const demand=(condition,message)=>{if(!condition)throw new TypeError('V8 source session: '+message);};

function componentSource(component){
  const side=component?.sidecar;
  demand(componentSchemas.has(side?.schema)&&side.admission==='locally_verified'&&side.referenceStatus==='agreed'&&
    side.optimizerSteps===0&&side.learningClaim===null&&side.nativeAdmission===null&&
    !Object.hasOwn(side,'datasetBinding')&&!Object.hasOwn(side,'orchestrationTranscript'),
    'each component must retain unbound original source evidence');
  const source=side.schema==='semantic-protocol-host-region-evidence/1'?side:side.sourceArtifact?.sidecar;
  demand(source?.referenceInput&&typeof source.referenceInput.source==='string'&&
    typeof source.referenceInput.entry==='string'&&source.sourceFamily===side.family&&
    source.sourceFamily===side.sourceFamily,'component source, entry or family is missing');
  const eligible=new Set(['owned-interpreter-teacher','certified_teacher']);
  if(side.schema==='semantic-region-evidence/1')demand(eligible.has(source.selectionOrigin),
    'the original source selection lacks eligible teacher provenance');
  for(const evidence of [side,source])if(Object.hasOwn(evidence,'selectionOrigin'))
    demand(eligible.has(evidence.selectionOrigin),
      'controlled or unverified selections cannot acquire source teacher provenance');
  return source;
}

function expectedPlan(components,{family,sessionId,seed,producerRevision}){
  demand(Array.isArray(components)&&components.length>=2&&components.length<=16,
    'two through sixteen independently checked root calls are required');
  demand(typeof family==='string'&&family&&typeof sessionId==='string'&&sessionId&&
    Number.isSafeInteger(seed)&&seed>=0&&
    (producerRevision===null||/^[a-f0-9]{40}$/.test(producerRevision)),
    'exact family, session, seed and optional producer revision are required');
  const sources=components.map(componentSource),first=sources[0],programs=[],calls=[];
  for(const [index,component]of components.entries()){
    const source=sources[index],rows=component.public?.timeline,
      declarations=rows?.filter(row=>row.kind==='program'),
      roots=rows?.filter(row=>row.kind==='invocation'&&row.fields.parentInvocationId===null);
    demand(component.public?.schema==='semantic-execution/8'&&Array.isArray(component.contexts)&&
      source.sourceFamily===family&&source.referenceInput.source===first.referenceInput.source&&
      source.referenceInput.entry===first.referenceInput.entry&&
      source.license===first.license&&source.trustTier===first.trustTier&&
      source.producerRevision===producerRevision&&declarations?.length===1&&roots?.length===1,
      'all calls must have the same exact source, authority and one declared program/root');
    const program=declarations[0],root=roots[0],fields=root.fields;
    demand(program.mode==='observed'&&root.mode==='observed'&&program.fields.session===sessionId&&
      program.fields.programId==='program1'&&program.fields.source===first.referenceInput.source&&
      program.fields.entry===first.referenceInput.entry&&fields.session===sessionId&&
      fields.programId==='program1'&&fields.invocationId==='ingress'+(index+1)&&
      fields.track==='worker1'&&fields.realmId==='realm'+(index+1)&&fields.realmPolicy==='fresh'&&
      fields.triggerId==='outside'+(index+1)&&fields.activation==='call',
      'component identities must be certified before collection, never renamed afterward');
    demand(!index||equal(program.fields,programs[0]),'immutable program declarations differ');
    programs.push(clone(program.fields));
    calls.push({component:index,invocationId:fields.invocationId,realmId:fields.realmId,
      triggerId:fields.triggerId,inputDigest:digest(fields.inputGraph),publicDigest:digest(component.public),
      contextsDigest:digest(component.contexts)});
  }
  return {schema:'semantic-source-session-plan/1',family,sessionId,seed,producerRevision,
    sourceDigest:programs[0].digest,entry:first.referenceInput.entry,calls};
}

function compose(components,options){
  const plan=expectedPlan(components,options),first=componentSource(components[0]),
    bridge=new RegionExecutionHarness({sessionId:plan.sessionId,automaticDelivery:false,
      now:()=>-Infinity,maxGenerated:16384}),contexts=[],receipts=[],refusals=[],
    invocations=new Set(),realms=new Set(),subscriptions=new Set(),ingresses=new Set();
  let published=false;
  for(const [componentIndex,component]of components.entries()){
    const rows=component.public.timeline,roots=rows.filter(row=>row.kind==='invocation'&&
      row.fields.parentInvocationId===null),root=roots[0].fields,localInvocations=new Map();
    demand(!realms.has(root.realmId),'independent roots cannot share a retained realm');
    realms.add(root.realmId);
    for(let index=0;index<rows.length;){
      const original=rows[index],fields=original.fields;
      if(original.kind==='program'&&published){index++;continue;}
      if(original.kind==='invocation'){
        demand(!invocations.has(fields.invocationId)&&!ingresses.has(fields.ingressKey)&&
          fields.realmId===root.realmId&&fields.programId===root.programId,
          'component invocation or ingress identity collided or escaped its certified realm');
        if(fields.invocationId!==root.invocationId){
          demand(fields.activation==='callback'&&fields.realmPolicy==='retained'&&
            fields.closureId!==null&&localInvocations.has(fields.parentInvocationId),
            'callback lacks its earlier source-certified owner');
        }
        invocations.add(fields.invocationId);ingresses.add(fields.ingressKey);
        localInvocations.set(fields.invocationId,fields);
      }
      if(original.kind==='handler'){
        demand(!subscriptions.has(fields.subscriptionId)&&localInvocations.has(fields.ownerInvocationId)&&
          fields.realmId===root.realmId&&fields.programId===root.programId,
          'callback registration collided or escaped its source-certified owner');
        subscriptions.add(fields.subscriptionId);
      }
      const before=bridge.timeline.length;
      let entry;
      if(original.mode==='generated'){
        demand(localInvocations.has(fields.invocationId)&&typeof fields.line==='string',
          'generated bytes need an earlier certified component invocation');
        contexts.push(clone(bridge.modelContext(fields.invocationId)));
        if(original.kind==='algorithm')entry=bridge.previewAlgorithm(fields.invocationId).entry;
        else if(original.kind==='region')entry=bridge.entry(fields.invocationId,
          decodeRegionRecord(fields.line).region);
        bridge.select(fields.invocationId,fields.line,{entry:entry??null});
      }else{
        demand(original.mode==='observed','only original public observations or generated bytes may compose');
        bridge.importObserved({mode:original.mode,kind:original.kind,fields:clone(fields)});
        if(original.kind==='program')published=true;
      }
      const emitted=bridge.timeline.slice(before);
      demand(emitted.length>0&&index+emitted.length<=rows.length,
        'one public action emitted a missing or extra source observation');
      for(const [offset,actual]of emitted.entries()){
        const expected=rows[index+offset],expectedFields=clone(expected.fields);
        if(offset===0&&entry!==undefined)expectedFields.entry=clone(entry);
        demand(actual.mode===expected.mode&&actual.kind===expected.kind&&equal(actual.fields,expectedFields),
          'public composition changed original selected bytes or the complete consequent observation batch');
        receipts.push({sequence:actual.sequence,component:componentIndex,sourceSequence:expected.sequence,
          rule:actual.mode==='generated'?'original-source-selected-bytes/1':'original-source-observation/1',
          componentPublicDigest:plan.calls[componentIndex].publicDigest,
          ...(entry!==undefined&&offset===0?{entryDigest:digest(entry)}:{})});
      }
      index+=emitted.length;
    }
    refusals.push(...(component.sidecar.refusals??[]).map(row=>({component:componentIndex,...clone(row)})));
  }
  const publicData=bridge.exportEpisode(),restored=RegionExecutionHarness.restore(
    JSON.parse(JSON.stringify(bridge.checkpoint())),{now:()=>-Infinity});
  for(const [id,activation]of bridge.invocations){
    demand(['completed','cancelled'].includes(activation.status)&&
      equal(sharedRegionState(activation.controller),sharedRegionState(restored.invocations.get(id)?.controller)),
      'collected invocation is incomplete or changed under JSON restoration');
  }
  const sourceArtifact={public:{schema:'semantic-session-source-target/1',sourceDigest:plan.sourceDigest,
    entry:plan.entry,componentPublicDigests:plan.calls.map(row=>row.publicDigest)},sidecar:{
    schema:SOURCE_SESSION_ARTIFACT_V8,admission:'locally_verified',referenceStatus:'agreed',
    selectionOrigin:'owned-interpreter-teacher',sourceFamily:plan.family,sourceLineage:plan.family,
    ancestorIds:[...new Set([plan.family,...components.flatMap(component=>componentSource(component).ancestorIds??[])])],
    producerRevision:plan.producerRevision,license:first.license,trustTier:first.trustTier,
    referenceInput:{source:first.referenceInput.source,entry:first.referenceInput.entry,
      invocations:components.map(component=>clone(componentSource(component).referenceInput))},
    sourceProvenance:{family:plan.family,sourceDigest:plan.sourceDigest,seed:plan.seed},
    collection:{schema:'semantic-source-session-collection/1',plan,components:clone(components)},
    optimizerSteps:0,learningClaim:null}};
  const generated=publicData.timeline.filter(row=>row.mode==='generated'),
    compact=generated.filter(row=>['algorithm','region'].includes(row.kind)),
    detail=generated.filter(row=>!['algorithm','region'].includes(row.kind)),
    protocols=generated.filter(row=>row.kind==='protocol'),bytes=rows=>rows.reduce((sum,row)=>sum+Buffer.byteLength(row.fields.line),0),
    regionCoverage={compactRegions:components.reduce((sum,row)=>sum+row.sidecar.regionCoverage.compactRegions,0),
      detailedRegions:components.reduce((sum,row)=>sum+row.sidecar.regionCoverage.detailedRegions,0),
      compactRecords:compact.length,detailedRecords:detail.length,protocolRecords:protocols.length,
      compactBytes:bytes(compact),detailedBytes:bytes(detail),protocolBytes:bytes(protocols),
      detailTokenShare:null,tokenMeasurement:'untested'};
  const exported=clean({public:publicData,contexts,sidecar:{schema:SOURCE_SESSION_EVIDENCE_V8,
    admission:'locally_verified',referenceStatus:'agreed',representation:REGION_TRACE_VERSION,
    profile:'compositional-regions/1',selectionOrigin:'owned-interpreter-teacher',
    sourceFamily:plan.family,family:plan.family,sourceArtifact,sourceArtifactDigest:digest(sourceArtifact),
    publicDigest:digest(publicData),contextDigest:digest(contexts),receipts,refusals,regionCoverage,
    nativeAdmission:null,optimizerSteps:0,learningClaim:null}});
  RegionExecutionHarness.replay(exported);
  return exported;
}

export async function verifyRegionSourceSessionV8({cases,family,seed=17,producerRevision=null,
    sessionId='source-session-v8',id=null}={}){
  demand(Array.isArray(cases)&&cases.length>=2&&cases.length<=16,'two through sixteen source cases required');
  demand(typeof family==='string'&&family&&cases.every(row=>row?.source===cases[0].source&&
    row?.entry===cases[0].entry),'one exact source, entry and family are required before collection');
  const {verifyRegionTrainingCase}=await import('./compiler-v8.js'),results=[];
  for(const [index,fixture]of cases.entries()){
    demand(!Object.hasOwn(fixture,'sessionCases'),'nested source-session collection is not supported');
    results.push(await verifyRegionTrainingCase({...fixture,family,seed,producerRevision,
      projectionOptions:{...fixture.projectionOptions,sessionId,programId:'program1',
        invocationId:'ingress'+(index+1),trackId:'worker1',realmId:'realm'+(index+1),
        realmPolicy:'fresh',triggerId:'outside'+(index+1)}}));
  }
  const dispositions=results.map((row,index)=>({index,status:row.status,phase:row.phase??null,
    reason:row.reason??null,sourceQualified:Boolean(row.exported)}));
  if(results.some(row=>!row.exported))return {id,family,status:'source-unqualified',
    phase:'component-source',declared:cases.length,components:dispositions,
    reason:'Every declared component must independently qualify before collection'};
  try{
    const exported=compose(results.map(row=>row.exported),{family,sessionId,seed,producerRevision});
    return {id,family,source:cases[0].source,entry:cases[0].entry,status:'locally_verified',
      profile:'source-qualified-session/1',declared:cases.length,components:dispositions,
      exported,regionCoverage:clone(exported.sidecar.regionCoverage)};
  }catch(error){return {id,family,status:error instanceof RangeError?'resource_limited':'unsupported',
    phase:'session-composition',declared:cases.length,components:dispositions,reason:error.message};}
}

export async function recheckRegionSourceSessionV8(exported,{nativeConsumer=null,nativePolicy=null,
    requireNative=false}={}){
  const side=exported?.sidecar,source=side?.sourceArtifact?.sidecar,collection=source?.collection;
  demand(side?.schema===SOURCE_SESSION_EVIDENCE_V8&&source?.schema===SOURCE_SESSION_ARTIFACT_V8&&
    collection?.schema==='semantic-source-session-collection/1'&&
    side.sourceArtifactDigest===digest(side.sourceArtifact)&&side.publicDigest===digest(exported.public)&&
    side.contextDigest===digest(exported.contexts),'source collection or public/context binding changed');
  const {recheckRegionEvidence}=await import('./compiler-v8.js');
  const checked=[];
  for(const component of collection.components){componentSource(component);
    checked.push(await recheckRegionEvidence(component));}
  const plan=collection.plan,rebuilt=compose(collection.components,{family:plan.family,
    sessionId:plan.sessionId,seed:plan.seed,producerRevision:plan.producerRevision});
  for(const key of ['public','contexts'])demand(equal(rebuilt[key],exported[key]),key+' differs from source collection');
  demand(['locally_verified','admitted'].includes(side.admission),
    'source session has an invalid admission disposition');
  if(side.admission==='locally_verified')demand(side.nativeAdmission===null,
    'locally verified source cannot retain a claimed native admission');
  else{
    // Checking a persisted receipt does not rerun the native consumer. Source-
    // only rechecks still return native.admitted=false below; callers needing
    // admission must invoke the independently pinned native gate again.
    const receipt=side.nativeAdmission,{validateV8NativeReceipt}=await import('./native-v8.js');
    validateV8NativeReceipt(exported,receipt,nativePolicy??{
      schema:'semantic-native-policy/8',consumerRepository:'werg/megatoken',
      consumerRevision:receipt?.consumerRevision,contractDigest:receipt?.contractDigest,
      fixtureDigest:receipt?.fixtureDigest,interoperabilityDigest:receipt?.interoperabilityDigest,
      tokenizerIdentity:receipt?.tokenizer?.identity,tokenizerSha256:receipt?.tokenizer?.sha256});
  }
  for(const key of Object.keys(rebuilt.sidecar))if(!['nativeAdmission','admission'].includes(key))
    demand(equal(rebuilt.sidecar[key],side[key]),'source collection evidence changed: '+key);
  let native={status:'untested',admitted:false};
  if(nativeConsumer){
    const {validateV8NativePolicy,validateV8NativeReceipt}=await import('./native-v8.js');
    validateV8NativePolicy(nativePolicy);native=await nativeConsumer(exported);
    validateV8NativeReceipt(exported,native,nativePolicy);
  }else demand(!requireNative,'exact V8 native admission is required');
  return {valid:true,sourceValidated:true,projectionValidated:true,replayValidated:true,
    source:{schema:SOURCE_SESSION_ARTIFACT_V8,components:checked,planDigest:digest(plan)},native,
    regionCoverage:clone(side.regionCoverage),completed:exported.public.timeline.filter(row=>row.kind==='invocation').length};
}
