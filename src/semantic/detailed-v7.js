// Versioned detailed witnesses for the selected detailed execution profile.
// This codec deliberately does not accept or emit the legacy source-shaped
// witness grammar: every v7 detail is a canonical typed JSON record.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {SelectedExecutionHarness} from '../training/harness-v4.js';
import {SelectedModelDriver} from '../training/model-driver.js';
import {validateWitness,WITNESS_SCHEMA,WITNESS_VERSION} from '../training/format.js';
import {hashAlgorithmData} from './program.js';
import {stableAlgorithmJSON} from './ir.js';

export const DETAILED_TRACE_VERSION='semantic-trace/7';
export const DETAILED_EXECUTION_VERSION='semantic-execution/7';
export const DETAILED_CONTEXT_VERSION='semantic-context/7';
export const DETAILED_CONTINUATION_VERSION='semantic-continuation/7';
export const DETAILED_PREFIX_VERSION='selected-inference-prefix/3';
export const DETAILED_PROFILE='selected-detailed/1';
export const DETAILED_EVIDENCE_SCHEMA='semantic-algorithm-evidence/2';
export const DETAILED_CONTEXT_FIELDS=Object.freeze([
  'schema','representation','prefix','visibleThrough','prefixDigest'
]);
const fail=message=>{throw new TypeError('Invalid selected-detailed/1 projection: '+message);};
const own=(value,key)=>Object.hasOwn(value,key);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  [Object.prototype,null].includes(Object.getPrototypeOf(value));
const sha=value=>hashAlgorithmData(value);
// Private source artifacts are evidence packets whose persisted identity is
// their ordinary JSON representation, including omitted undefined fields.
const privateDigest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const legacyForbidden=new Set(['code','input','observe','value-open','value-part','value-close']);
const logicalFragments=new Set(['value-open','value-part','value-close']);
const maxRecordBytes=65536;

function validateDetailedFields(kind,fields,{role='any'}={}){
  if(!Object.hasOwn(WITNESS_SCHEMA,kind)||!plain(fields))fail('record kind or fields');
  if(!['generated','observed','any'].includes(role))fail('record role');
  if(logicalFragments.has(kind))fail('legacy logical fragments are not v7 details');
  if(role==='generated'&&legacyForbidden.has(kind))fail('host-controlled or non-record kind cannot be generated');
  if(role==='observed'&&kind!=='observe')fail('observed detail must carry an observation');
  try{validateWitness(kind,fields);}catch(error){fail(error.message);}
  return {kind,fields};
}

function publicJSON(value,ancestors=new Set()){
  if(value===null||typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number'&&Number.isFinite(value)&&!Object.is(value,-0))return value;
  if(!value||typeof value!=='object'||ancestors.has(value))fail('noncanonical JSON data');
  ancestors.add(value);
  let result;
  if(Array.isArray(value)){
    if(Object.keys(value).length!==value.length)fail('sparse JSON array');
    result=value.map(item=>publicJSON(item,ancestors));
  }else{
    if(!plain(value))fail('non-data JSON object');
    result={};
    for(const key of Object.keys(value).sort())if(value[key]!==undefined)
      result[key]=publicJSON(value[key],ancestors);
  }
  ancestors.delete(value);return result;
}

/** Encode exactly `{kind,fields}` so detailed fields named `kind` remain data. */
export function encodeDetailedRecord(record,{role='any'}={}){
  if(!plain(record)||Object.keys(record).length!==2||!own(record,'kind')||!own(record,'fields'))
    fail('wrapper must contain exactly kind and fields');
  const {kind,fields}=validateDetailedFields(record.kind,record.fields,{role});
  const line='detail '+stableAlgorithmJSON({kind,fields});
  if(Buffer.byteLength(line,'utf8')>maxRecordBytes)fail('record byte budget');
  return line;
}

/** Decode only canonical v7 `detail ` records; legacy lines are never relabeled. */
export function decodeDetailedRecord(line,{role='any'}={}){
  if(typeof line!=='string'||!line.startsWith('detail ')||/[\r\n]/.test(line)||
    Buffer.byteLength(line,'utf8')>maxRecordBytes)fail('single canonical v7 detail record required');
  let body;
  try{body=JSON.parse(line.slice(7));}catch{fail('detail JSON');}
  if(!plain(body)||Object.keys(body).length!==2||!own(body,'kind')||!own(body,'fields'))
    fail('detail wrapper fields');
  validateDetailedFields(body.kind,body.fields,{role});
  if(encodeDetailedRecord(body,{role})!==line)fail('noncanonical detail record');
  return structuredClone(body);
}

function translatedRow(row){
  const copy=structuredClone(row);
  copy.schema=DETAILED_EXECUTION_VERSION;
  if(copy.kind==='semantic'){
    const {kind,fields}=decodeLegacySemantic(copy.line,'generated');
    copy.traceFormat=DETAILED_TRACE_VERSION;
    copy.line=encodeDetailedRecord({kind,fields},{role:'generated'});
  }else if(copy.kind==='result'){
    const {kind,fields}=decodeLegacySemantic(copy.line,'observed');
    copy.line=encodeDetailedRecord({kind,fields},{role:'observed'});
  }
  if(copy.kind==='model-context'&&copy.selectedState){
    copy.selectedState.schema=DETAILED_CONTINUATION_VERSION;
  }
  return publicJSON(copy);
}

function decodeLegacySemantic(line,role){
  // Only private, independently rechecked v6 source evidence enters here.
  // This decoder is not on any v7 public validation or serving path.
  const {decodeWitness}=legacyCodec;
  const {kind,fields}=decodeWitness(line);
  validateDetailedFields(kind,fields,{role});
  return {kind,fields};
}
// Keep the old decoder isolated in this private reprojection module.
import * as legacyCodec from '../training/format.js';

function sourceInfo(timeline,invocationId){
  const invocation=timeline.find(row=>row.kind==='invocation'&&row.invocationId===invocationId);
  if(!invocation)fail('causal context has no prior invocation');
  const realmId=invocation.realmId,realmInvocations=new Set(timeline.filter(row=>
    row.kind==='invocation'&&row.realmId===realmId).map(row=>row.invocationId));
  const realmPrograms=new Set(timeline.filter(row=>row.kind==='invocation'&&row.realmId===realmId)
    .map(row=>row.programId));
  const realmTracks=new Set(timeline.filter(row=>row.kind==='invocation'&&row.realmId===realmId)
    .map(row=>row.track));
  const realmSubscriptions=new Set(timeline.filter(row=>row.kind==='handler'&&row.realmId===realmId)
    .map(row=>row.subscriptionId));
  return row=>row.kind==='program'&&realmPrograms.has(row.programId)||realmInvocations.has(row.invocationId)||
    realmSubscriptions.has(row.subscriptionId)||
    ['source-read','source-evict'].includes(row.kind)&&realmTracks.has(row.track)&&realmPrograms.has(row.programId);
}

function translatePrefix(prefix){
  if(prefix?.schema!=='selected-inference-prefix/2')fail('private source replay did not produce the expected v6 inference prefix');
  const translated=structuredClone(prefix);
  translated.schema=DETAILED_PREFIX_VERSION;
  translated.representation='detailed';
  translated.traceFormat=DETAILED_TRACE_VERSION;
  translated.committed=prefix.committed.map(translatedRow);
  translated.realmCommitted=prefix.realmCommitted.map(translatedRow);
  const realmDigests=new Map();
  const relevant=sourceInfo(prefix.realmCommitted,prefix.invocationId);
  for(const row of translated.realmCommitted){
    if(row.kind!=='model-context'||!own(row,'selectedState'))continue;
    const prior=prefix.realmCommitted.filter(item=>item.sequence<=row.visibleThrough&&relevant(item))
      .map(translatedRow);
    row.realmPrefixDigest=hashAlgorithmData(prior);
    realmDigests.set(row.sequence,row.realmPrefixDigest);
  }
  translated.committed=translated.committed.map(row=>
    row.kind==='model-context'&&realmDigests.has(row.sequence)?
      {...row,realmPrefixDigest:realmDigests.get(row.sequence)}:row);
  return translated;
}

function makeDetailedContext(prefix){
  const translated=translatePrefix(prefix);
  const visibleThrough=Math.max(0,...translated.realmCommitted.map(row=>row.sequence));
  const context={schema:DETAILED_CONTEXT_VERSION,representation:'detailed',prefix:translated,
    visibleThrough,prefixDigest:hashAlgorithmData(translated)};
  return publicJSON(context);
}

function contextForTarget(sourceExport,targetIndex,target){
  const prior={...sourceExport.public,timeline:sourceExport.public.timeline.slice(0,targetIndex)};
  const harness=SelectedExecutionHarness.replay({public:prior},{requireTerminal:false});
  harness.prepareModelContext(target.invocationId);
  const driver=new SelectedModelDriver({harness,select:()=>{throw new Error('Context derivation cannot select a record');}});
  try{return makeDetailedContext(driver.prefix(target.invocationId));}
  finally{driver.close();}
}

function recomputeDetailedModelContexts(timeline){
  for(const row of timeline){
    if(row.kind!=='model-context'||!own(row,'selectedState'))continue;
    const relevant=sourceInfo(timeline,row.invocationId);
    const prior=timeline.filter(item=>item.sequence<=row.visibleThrough&&relevant(item));
    row.realmPrefixDigest=hashAlgorithmData(prior);
  }
}

function validateV7Public(publicData){
  if(!plain(publicData)||publicData.schema!==DETAILED_EXECUTION_VERSION||
    publicData.profile!==DETAILED_PROFILE||publicData.traceFormat!==DETAILED_TRACE_VERSION||
    publicData.contextFormat!==DETAILED_CONTEXT_VERSION||publicData.representation!=='detailed'||
    !Array.isArray(publicData.timeline)||!publicData.timeline.length)fail('public v7 envelope');
  let sequence=0;
  for(const row of publicData.timeline){
    if(!plain(row)||row.schema!==DETAILED_EXECUTION_VERSION||!Number.isSafeInteger(row.sequence)||
      row.sequence<=sequence||!['generated','observed'].includes(row.mode))fail('v7 timeline authority or sequence');
    sequence=row.sequence;
    if(row.kind==='semantic'){
      if(row.mode!=='generated'||row.traceFormat!==DETAILED_TRACE_VERSION)
        fail('v7 semantic target authority');
      decodeDetailedRecord(row.line,{role:'generated'});
    }else if(row.kind==='result'){
      if(row.mode!=='observed')fail('result must be observed');
      decodeDetailedRecord(row.line,{role:'observed'});
    }
    if(row.kind==='model-context'&&own(row,'selectedState')){
      if(row.selectedState?.schema!==DETAILED_CONTINUATION_VERSION||
        !/^[0-9a-f]{64}$/.test(row.realmPrefixDigest??'')||row.visibleThrough!==row.sequence-1)
        fail('model-context selected-state binding');
    }
  }
  return true;
}

function validateContext(context){
  if(!plain(context)||Object.keys(context).length!==DETAILED_CONTEXT_FIELDS.length||
    DETAILED_CONTEXT_FIELDS.some(key=>!own(context,key))||context.schema!==DETAILED_CONTEXT_VERSION||
    context.representation!=='detailed'||!Number.isSafeInteger(context.visibleThrough)||context.visibleThrough<0||
    !/^[0-9a-f]{64}$/.test(context.prefixDigest??''))fail('full detailed context envelope');
  const prefix=context.prefix;
  if(!plain(prefix)||prefix.schema!==DETAILED_PREFIX_VERSION||prefix.representation!=='detailed'||
    prefix.traceFormat!==DETAILED_TRACE_VERSION)fail('detailed context prefix identity');
  const prefixFields=['schema','representation','traceFormat','programId','entry','source','sourceDigest',
    'invocationId','trackId','realmId','committed','realmCommitted','completionPolicy','maxOutstanding',
    'taskRevision','parentInvocationId','receiver','closureId','activation','selectedState'];
  if(Object.keys(prefix).length!==prefixFields.length||prefixFields.some(key=>!own(prefix,key)))
    fail('unexpected or missing inference prefix fields');
  if(context.visibleThrough!==Math.max(0,...prefix.realmCommitted.map(row=>row.sequence)))
    fail('context cutoff');
  if(hashAlgorithmData(prefix)!==context.prefixDigest)fail('context prefix digest');
  // Prefix records are public causal inputs only; each line is checked using
  // the strict v7 detail grammar and observed records retain their authority.
  for(const row of [...prefix.committed,...prefix.realmCommitted]){
    if(row.schema!==DETAILED_EXECUTION_VERSION)fail('legacy record inside v7 context');
    if(row.kind==='semantic')decodeDetailedRecord(row.line,{role:'generated'});
    if(row.kind==='result')decodeDetailedRecord(row.line,{role:'observed'});
  }
  return true;
}

/**
 * Reproject an independently certified private v6 source artifact into a new
 * v7 detailed episode. The v6 packet is accepted only as private source
 * evidence; every public target, context and digest is newly derived.
 */
export function projectDetailedV7(sourceArtifact,{fallback=null,maxTargets=4096}={}){
  if(sourceArtifact?.public?.schema!=='semantic-execution/6'||
    sourceArtifact.public.traceFormat!==WITNESS_VERSION||sourceArtifact.public.contextFormat!=='semantic-context/6'||
    sourceArtifact.sidecar?.referenceStatus!=='agreed'||!sourceArtifact.sidecar?.archive)
    fail('a privately certified complete v6 source artifact is required');
  if(!Number.isSafeInteger(maxTargets)||maxTargets<1)fail('target cap');
  // This replay validates the original record order, decisions and observed
  // results before the old public packet is used as private projection input.
  SelectedExecutionHarness.replay(sourceArtifact);
  const timeline=sourceArtifact.public.timeline.map(translatedRow);
  recomputeDetailedModelContexts(timeline);
  const publicData=publicJSON({schema:DETAILED_EXECUTION_VERSION,profile:DETAILED_PROFILE,
    traceFormat:DETAILED_TRACE_VERSION,contextFormat:DETAILED_CONTEXT_VERSION,
    representation:'detailed',timeline,
    completion:structuredClone(sourceArtifact.public.completion),
    claims:structuredClone(sourceArtifact.public.claims),
    firstViolation:structuredClone(sourceArtifact.public.firstViolation)});
  validateV7Public(publicData);
  const targets=[];
  for(let i=0;i<sourceArtifact.public.timeline.length;i++){
    const row=sourceArtifact.public.timeline[i];
    if(row.kind!=='semantic')continue;
    if(targets.length>=maxTargets)fail('target cap exceeded; partial episodes cannot be projected');
    targets.push(publicJSON({sequence:row.sequence,invocationId:row.invocationId,
      context:contextForTarget(sourceArtifact,i,row)}));
  }
  if(!targets.length)fail('certified detailed episode has no generated semantic targets');
  const contexts=targets.map(item=>item.context);
  const publicDigest=hashAlgorithmData(publicData),contextDigest=hashAlgorithmData(contexts);
  const artifactDigest=privateDigest(sourceArtifact);
  const exported={public:publicData,contexts,sidecar:{schema:DETAILED_EVIDENCE_SCHEMA,
    admission:'locally_verified',referenceStatus:'agreed',representation:DETAILED_TRACE_VERSION,
    profile:DETAILED_PROFILE,sourceDigest:sourceArtifact.sidecar.sourceProvenance?.sourceDigest??null,
    sourceArtifact:structuredClone(sourceArtifact),sourceArtifactDigest:artifactDigest,
    publicDigest,contextDigest,nativeAdmission:null,nativeBinding:null,
    nativeAdmissionStatus:'unavailable',optimizerSteps:0,learningClaim:null,
    fallback:fallback?structuredClone(fallback):null}};
  validateDetailedProjection(exported);
  return exported;
}

/** Strict v7 structural and digest validator; no v6 artifact is a v7 episode. */
export function validateDetailedProjection(exported){
  validateV7Public(exported?.public);
  const side=exported?.sidecar;
  if(!plain(side)||side.schema!==DETAILED_EVIDENCE_SCHEMA||side.representation!==DETAILED_TRACE_VERSION||
    side.profile!==DETAILED_PROFILE||!['locally_verified','admitted'].includes(side.admission)||side.referenceStatus!=='agreed'||
    side.optimizerSteps!==0||side.learningClaim!==null||side.sourceArtifact?.public?.schema!=='semantic-execution/6'||
    side.sourceArtifactDigest!==privateDigest(side.sourceArtifact)||
    side.publicDigest!==hashAlgorithmData(exported.public)||!Array.isArray(exported.contexts)||
    side.contextDigest!==hashAlgorithmData(exported.contexts))fail('private source or digest binding');
  if(side.sourceDigest!==side.sourceArtifact.sidecar.sourceProvenance?.sourceDigest)fail('source digest binding');
  const targets=exported.public.timeline.filter(row=>row.kind==='semantic');
  if(exported.contexts.length!==targets.length)
    fail('one public context per generated target required');
  for(const [index,context] of exported.contexts.entries()){
    if(context?.prefix?.invocationId!==targets[index].invocationId||
      context.visibleThrough>=targets[index].sequence)
      fail('context target alignment');
    validateContext(context);
  }
  return {valid:true,publicDigest:side.publicDigest,contextDigest:side.contextDigest,
    sourceArtifactDigest:side.sourceArtifactDigest,targets:exported.contexts.length};
}

/** Rebuild from the exact private source evidence and refuse changed bytes. */
export function verifyDetailedProjection(exported){
  validateDetailedProjection(exported);
  const rebuilt=projectDetailedV7(exported.sidecar.sourceArtifact,{fallback:exported.sidecar.fallback,
    maxTargets:Math.max(1,exported.contexts.length)});
  if(!isDeepStrictEqual(rebuilt.public,exported.public)||
    !isDeepStrictEqual(rebuilt.contexts,exported.contexts)||
    rebuilt.sidecar.publicDigest!==exported.sidecar.publicDigest||
    rebuilt.sidecar.contextDigest!==exported.sidecar.contextDigest)
    throw new Error('Detailed v7 public projection or causal context changed');
  return {valid:true,publicDigest:exported.sidecar.publicDigest,
    contextDigest:exported.sidecar.contextDigest,sourceArtifactDigest:exported.sidecar.sourceArtifactDigest};
}

export function detailedContextForSequence(exported,sequence){
  validateDetailedProjection(exported);
  const targetIndex=exported.public.timeline.filter(row=>row.kind==='semantic')
    .findIndex(item=>item.sequence===sequence);
  const context=targetIndex<0?undefined:exported.contexts[targetIndex];
  if(!context)fail('no prepared causal context for target sequence '+sequence);
  return structuredClone(context);
}
