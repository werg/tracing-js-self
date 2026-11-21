// Direct mixed source certification: owned events, independent original-source
// execution and public replay are separate authorities. Nothing here runs in
// the selected serving machine.
import {isDeepStrictEqual as eq} from 'node:util';
import {createSourceAdmissionClient} from './source-admission.js';
import {bindSourceAdmissionIdentity,verifySourceAdmissionIdentity} from './source-identity.js';
import {SOURCE_ADMISSION_CONTRACT_V8} from './source-admission-v8.js';
import {compileEffectfulRegionWitnessV8} from './effectful-teacher-v8.js';
import {createPromiseJoinTeacherV8} from './protocol-promise-join-source-v8.js';
import {RegionExecutionHarness} from './region-harness.js';
import {hashAlgorithmData} from './program.js';
import {REGION_EXECUTION_VERSION,REGION_TRACE_VERSION,REGION_CONTEXT_VERSION,REGION_PROFILE} from './regions.js';
import {validateV8NativePolicy,validateV8NativeReceipt} from './native-v8.js';

export const PROTOCOL_HOST_EVIDENCE_V8='semantic-protocol-host-region-evidence/1';
const copy=structuredClone,fail=message=>{throw new TypeError('Protocol host source: '+message);};
const contract={...SOURCE_ADMISSION_CONTRACT_V8,execution:REGION_EXECUTION_VERSION,
  trace:REGION_TRACE_VERSION,context:REGION_CONTEXT_VERSION,harness:REGION_PROFILE};

export function compileProtocolHostSourceV8(bundle,options={}){
  const compiled=compileEffectfulRegionWitnessV8(bundle,{...options,realmPolicy:'retained',
    sessionId:'protocol-host-source',allowHost:true,extensions:[createPromiseJoinTeacherV8()]}),artifact=compiled.exported;
  const generated=artifact.public.timeline.filter(row=>row.mode==='generated'),
    protocols=generated.filter(row=>row.kind==='protocol');
  if(!protocols.length)fail('source has no independently projected protocol work');
  const protocolBytes=protocols.reduce((sum,row)=>sum+Buffer.byteLength(row.fields.line),0),
    detailedBytes=generated.reduce((sum,row)=>sum+Buffer.byteLength(row.fields.line),0);
  Object.assign(artifact.sidecar,{schema:PROTOCOL_HOST_EVIDENCE_V8,representation:'mixed',
    profile:REGION_PROFILE,protocolExtensions:['promise-join/1'],
    publicDigest:hashAlgorithmData(artifact.public),contextDigest:hashAlgorithmData(artifact.contexts),
    regionCoverage:{compactRegions:0,detailedRegions:generated.length,compactRecords:0,
      detailedRecords:generated.length,protocolRecords:protocols.length,compactBytes:0,
      detailedBytes,protocolBytes,detailTokenShare:null,tokenMeasurement:'untested'},
    nativeAdmission:null,optimizerSteps:0,learningClaim:null});
  return compiled;
}
function verifyProjection(bundle,artifact,options={}){
  const expected=compileProtocolHostSourceV8(bundle,options).exported;
  for(const key of ['public','contexts'])if(!eq(expected[key],artifact[key]))fail(key+' differs from current-event source projection');
  for(const key of ['schema','compiler','representation','protocolExtensions','regionCoverage','publicDigest','contextDigest'])
    if(!eq(expected.sidecar[key],artifact.sidecar[key]))fail('source projection changed: '+key);
  RegionExecutionHarness.replay(artifact);
  return {valid:true,publicDigest:hashAlgorithmData(artifact.public),
    certificates:expected.sidecar.compiler.certificates.length,
    generatedRecords:expected.sidecar.compiler.generatedRecords,nativeReplayDispatches:0};
}
const source=createSourceAdmissionClient({compileProjection:compileProtocolHostSourceV8,verifyProjection,
  bindIdentity:artifact=>bindSourceAdmissionIdentity(artifact,contract),
  verifyIdentity:(artifact,options)=>verifySourceAdmissionIdentity(artifact,contract,options),
  receiptSchema:'semantic-protocol-host-source-admission/1'});
export async function verifyProtocolHostTrainingCaseV8(fixture){
  const result=await source.verifyTrainingCase({...fixture,nativeConsumer:null,nativePolicy:null,
    projectionOptions:{...fixture.projectionOptions,semanticRegions:false,localStateCompaction:false}});
  if(result.exported){
    const side=result.exported.sidecar;
    // The source authority's split is part of its immutable identity. Dataset
    // preparation separately binds the complete V8 family registry below it.
    side.sourceAdmission={split:side.split,splitIdentity:copy(side.splitIdentity)};
    delete side.split;delete side.splitIdentity;side.family=side.sourceFamily;
  }
  return {...result,profile:'protocol-host-source/1',representation:'mixed',
    ...(result.exported?{regionCoverage:copy(result.exported.sidecar.regionCoverage)}:{})};
}
export async function recheckProtocolHostEvidenceV8(artifact,{nativeConsumer=null,nativePolicy=null,requireNative=false}={}){
  if(artifact?.sidecar?.schema!==PROTOCOL_HOST_EVIDENCE_V8)fail('wrong source evidence schema');
  const admission=artifact.sidecar.sourceAdmission;
  if(!admission||Object.keys(admission).length!==2||!Object.hasOwn(admission,'split')||
    !Object.hasOwn(admission,'splitIdentity'))fail('original source admission split is missing');
  const sourceView={...artifact,sidecar:{...artifact.sidecar,...copy(admission)}};
  const checked=await source.recheckAdmission(sourceView,{requireAdmitted:false});
  const replay=RegionExecutionHarness.replay(artifact);let native={status:'untested',admitted:false};
  if(nativeConsumer){validateV8NativePolicy(nativePolicy);native=await nativeConsumer(artifact);
    validateV8NativeReceipt(artifact,native,nativePolicy);}
  else if(requireNative)fail('exact V8 native admission must be rechecked by the pinned consumer');
  return {valid:true,sourceValidated:true,projectionValidated:true,replayValidated:true,source:checked,native,
    regionCoverage:copy(artifact.sidecar.regionCoverage),completed:replay.invocations.size};
}
