// Original module semantics and generated owned execution are separate gates.
// Native ESM is a reference only; all public traces execute generated owned JS.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {posix} from 'node:path';
import {types,isDeepStrictEqual} from 'node:util';
import {linkEvaluatedModules} from '../evaluated-modules.js';
import {compileBoundedTypeScript} from '../typescript.js';
import {encodeNativeGraph} from '../host/graph-codec.js';
import {generationEnvironment} from '../corpus/generation-process.mjs';
import {verifyRegionTrainingCase} from './compiler-v8.js';
import {hashAlgorithmData} from './program.js';
import {compareObservableGraphs} from './observables.js';

export const MODULE_REGION_PROFILE='evaluated-module-regions/1';
const worker=fileURLToPath(new URL('../../tools/module-region-reference-worker.mjs',import.meta.url));
const fail=message=>{throw new TypeError('Module regions: '+message);};
const copy=structuredClone;

function normalizedRequest(fixture){
  const input=fixture.modules;
  if(!input||types.isProxy(input)||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))
    fail('declared own-data module graph required');
  const modules=Object.create(null);
  for(const key of Reflect.ownKeys(input)){
    if(typeof key!=='string')fail('module path must be a string');
    const descriptor=Object.getOwnPropertyDescriptor(input,key),id=key.startsWith('/')?key.slice(1):key;
    if(!descriptor||!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='string'||
      !id||posix.normalize(id)!==id||id.startsWith('../')||/[\\?#\0]/.test(id)||Object.hasOwn(modules,id))
      fail('module paths and sources must be canonical own data');
    modules[id]=descriptor.value;
  }
  const originalEntry=fixture.moduleEntry??fixture.entryModule;
  if(typeof originalEntry!=='string')fail('module entry required');
  const entryModule=originalEntry.startsWith('/')?originalEntry.slice(1):originalEntry;
  return {modules,entryModule,exportName:fixture.exportName??'run',args:fixture.args??[],calls:fixture.calls??null};
}
function prepare(fixture){
  const request=normalizedRequest(fixture),linked=linkEvaluatedModules(request);
  // The native reference evaluates original JavaScript (or pinned TS output)
  // as ESM, independently of the owned module-to-cell/linking transformation.
  const emitted=Object.fromEntries(Object.entries(request.modules).map(([id,source])=>[id,
    compileBoundedTypeScript(source,{path:id}).javascript]));
  const graph=encodeNativeGraph([linked.entryInput],{maxBytes:1048576});
  return {request,linked,referenceInput:{modules:emitted,entryModule:request.entryModule,
    exportName:request.exportName,calls:request.calls?.map(({exportName})=>({exportName}))??null,inputGraph:graph}};
}

export async function independentModuleRegionReference(referenceInput,{timeoutMs=1000,processTimeoutMs=10000}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>10000||
    !Number.isSafeInteger(processTimeoutMs)||processTimeoutMs<timeoutMs||processTimeoutMs>60000)
    fail('bounded module reference deadlines required');
  return new Promise(resolve=>{
    const child=spawn(process.execPath,['--no-warnings','--experimental-vm-modules',worker],
      {stdio:['pipe','pipe','pipe'],shell:false,env:generationEnvironment()});
    let stdout='',stderr='',finished=false;
    const finish=result=>{if(finished)return;finished=true;clearTimeout(timer);child.kill('SIGKILL');resolve(result);};
    const timer=setTimeout(()=>finish({schema:'semantic-module-reference/1',status:'resource_limited',
      reason:'Native module reference process deadline exceeded'}),processTimeoutMs);
    child.stdout.on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>2097152)
      finish({schema:'semantic-module-reference/1',status:'resource_limited',reason:'Module reference output bound'});});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4096);});
    child.once('error',error=>finish({schema:'semantic-module-reference/1',status:'failed',reason:error.message}));
    child.stdin.on('error',()=>{});
    child.once('close',code=>{if(finished)return;
      try{if(code!==0)throw new Error('Reference worker failed: '+stderr);finish(JSON.parse(stdout));}
      catch(error){finish({schema:'semantic-module-reference/1',status:'failed',reason:error.message});}});
    child.stdin.end(JSON.stringify({...referenceInput,timeoutMs}));
  });
}
function outcomeAgreement(left,right){
  const anchors=graph=>graph.roots.slice(0,-1).filter(value=>value[0]==='ref').map(value=>value[1]);
  return left?.kind===right?.kind&&compareObservableGraphs(left.graph,right.graph,
    {leftInputIds:anchors(left.graph),rightInputIds:anchors(right.graph)}).equal;
}
function moduleProjectionRefusal(linked){
  if(linked.metadata.requiresModuleNamespace===true)
    return {status:'projection_refused',phase:'module-projection',
      category:'unsupported.module-namespace-projection',sourceProfile:MODULE_REGION_PROFILE,
      moduleLink:'passed',ownedRuntimeProfile:linked.profile,
      moduleNamespace:'owned-internal',moduleReference:'untested',
      publicProjection:'unqualified',nativeQualification:'unqualified',
      reason:'Owned module namespace exotics have no qualified public/native heap projection'};
  if(linked.metadata.evaluationStrategy!=='async-dependency-scheduler')return null;
  // Owned generator/Promise execution is a distinct implementation milestone.
  // A generic generator projection cannot establish public/native module
  // dependency counts, retained cells, completion jobs, or failure propagation.
  return {status:'projection_refused',phase:'module-projection',
    category:'unsupported.module-scheduler-projection',sourceProfile:MODULE_REGION_PROFILE,
    moduleLink:'passed',ownedRuntimeProfile:linked.profile,
    evaluationStrategy:linked.metadata.evaluationStrategy,moduleReference:'untested',
    publicProjection:'unqualified',nativeQualification:'unqualified',
    reason:'Owned parallel top-level-await or cyclic async module scheduling has no qualified public/native module-state projection'};
}

export async function verifyRegionModuleTrainingCase(fixture){
  const identity=Object.fromEntries(['id','family','moduleEntry','entryModule','exportName','ancestorIds']
    .filter(key=>Object.hasOwn(fixture,key)).map(key=>[key,copy(fixture[key])]));
  let prepared;
  try{prepared=prepare(fixture);}catch(error){return {...identity,status:'unsupported',phase:'module-link',
    sourceProfile:MODULE_REGION_PROFILE,reason:error.message};}
  identity.modules=copy(prepared.request.modules);
  const refused=moduleProjectionRefusal(prepared.linked);
  if(refused)return {...identity,...refused};
  const reference=await independentModuleRegionReference(prepared.referenceInput);
  if(reference.status!=='passed')return {...identity,status:reference.status,phase:'module-reference',
    sourceProfile:MODULE_REGION_PROFILE,reason:reference.reason};
  const {request,linked,referenceInput}=prepared,graphDigest=hashAlgorithmData(request.modules);
  const moduleEvidence={schema:'semantic-module-evidence/1',profile:MODULE_REGION_PROFILE,
    request:{modules:request.modules,entryModule:request.entryModule,exportName:request.exportName,
      inputGraph:referenceInput.inputGraph,calls:referenceInput.calls},graphDigest,
    generatedSourceDigest:hashAlgorithmData(linked.source),metadata:linked.metadata,referenceInput,reference,
    originalTypeScriptClaim:'provenance only; generated JavaScript semantics are checked',
    adapterMeaning:'native ESM outcome compared with owned linked code; no native guest execution in the producer'};
  const ancestorIds=[...new Set([...(fixture.ancestorIds??[]),'module-graph:'+graphDigest,
    ...Object.values(request.modules).map(source=>'module-source:'+hashAlgorithmData(source))])];
  const result=await verifyRegionTrainingCase({...fixture,source:linked.source,entry:linked.entryFunction,
    args:[linked.entryInput],fixture:fixture.fixture??{calls:[]},ancestorIds,
    provenance:{...fixture.provenance,moduleEvidence}});
  if(!result.exported)return {...identity,...result,sourceProfile:MODULE_REGION_PROFILE,moduleReference:'passed'};
  if(!outcomeAgreement(reference.outcome,result.exported.sidecar.sourceArtifact.sidecar.reference.outcome))
    return {...identity,status:'failed',phase:'module-correspondence',sourceProfile:MODULE_REGION_PROFILE,
      reason:'Native original module graph and owned linked JavaScript differ'};
  return {...identity,...result,sourceProfile:MODULE_REGION_PROFILE,moduleReference:'passed',
    moduleCorrespondence:'passed',moduleGraphDigest:graphDigest};
}

/** Re-run the native ESM reference and linker from source-bound private proof.
 * This is called by production v8 rechecking, never by the model serializer. */
export async function recheckModuleRegionEvidence(sourceArtifact){
  const evidence=sourceArtifact?.sidecar?.sourceProvenance?.upstream?.moduleEvidence;
  if(evidence===undefined)return {status:'untested',applicable:false};
  if(evidence.schema!=='semantic-module-evidence/1'||evidence.profile!==MODULE_REGION_PROFILE)
    fail('module evidence version');
  const {decodeOwnedGraph}=await import('../host/graph-codec.js');
  const [input]=decodeOwnedGraph(JSON.stringify(evidence.request.inputGraph));
  const request={...evidence.request,args:evidence.request.calls?[]:input.args,
    calls:evidence.request.calls?.map((call,index)=>({...call,args:input.calls[index].args}))??null};
  const prepared=prepare(request),side=sourceArtifact.sidecar;
  const refused=moduleProjectionRefusal(prepared.linked);
  if(refused)throw Object.assign(new TypeError('Module regions: '+refused.reason),refused);
  if(evidence.graphDigest!==hashAlgorithmData(prepared.request.modules)||
    evidence.generatedSourceDigest!==hashAlgorithmData(prepared.linked.source)||
    side.referenceInput.source!==prepared.linked.source||side.referenceInput.entry!==prepared.linked.entryFunction||
    !isDeepStrictEqual(prepared.referenceInput,evidence.referenceInput)||
    !isDeepStrictEqual(prepared.linked.metadata,evidence.metadata))fail('module graph, transformation, inputs or provenance changed');
  const reference=await independentModuleRegionReference(prepared.referenceInput);
  if(reference.status!=='passed'||!isDeepStrictEqual(reference,evidence.reference)||
    !outcomeAgreement(reference.outcome,side.reference.outcome))fail('independent original-module outcome changed');
  return {status:'passed',applicable:true,graphDigest:evidence.graphDigest};
}
