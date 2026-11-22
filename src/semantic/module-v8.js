// Original module semantics and generated owned execution are separate gates.
// Native ESM is a reference only; all public traces execute generated owned JS.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {posix} from 'node:path';
import {types,isDeepStrictEqual} from 'node:util';
import {linkEvaluatedModules} from '../evaluated-modules.js';
import {buildExperimentalModuleNamespacePlanFromLinker} from './module-namespace-state-v8.js';
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
const namespaceHostScalar=value=>value===undefined||value===null||typeof value==='boolean'||
  typeof value==='string'||typeof value==='number'&&Number.isFinite(value)||typeof value==='bigint';

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
  const experimentalNamespacePlan=fixture.experimentalNamespacePlan??false,args=fixture.args??[],
    calls=fixture.calls??null;
  if(typeof experimentalNamespacePlan!=='boolean')fail('experimentalNamespacePlan must be boolean');
  if(experimentalNamespacePlan&&(!Array.isArray(args)||args.some(value=>!namespaceHostScalar(value))||calls!==null))
    fail('experimental namespace source profile requires scalar entry args and a single call');
  return {modules,entryModule,exportName:fixture.exportName??'run',args,calls,
    ...(experimentalNamespacePlan?{experimentalNamespacePlan:true}:{})};
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
function namespaceObservationAgreement(reference,sourceArtifact,moduleNamespacePlan){
  if(!moduleNamespacePlan)return true;
  const observed=reference?.namespaceObservations;
  if(observed?.schema!=='semantic-module-namespace-observations/1'||!Array.isArray(observed.rows))return false;
  const claims=sourceArtifact?.sidecar?.compiler?.claims;
  if(!Array.isArray(claims))return false;
  const records=claims.filter(row=>row.kind==='protocol'&&
    (row.record?.kind?.startsWith('namespace.')||row.record?.kind?.startsWith('cell.'))).map(row=>row.record);
  const fileByNamespaceId=new Map();
  const normalized=[];
  for(const row of records){
    if(row.kind==='namespace.create'){
      fileByNamespaceId.set(row.namespaceId,row.moduleFile);
      normalized.push({kind:row.kind,moduleFile:row.moduleFile});
      continue;
    }
    if(row.kind==='cell.initialize'||row.kind==='cell.write'){
      normalized.push({kind:row.kind,cell:row.cell,loweredName:row.loweredName,value:row.value});
      continue;
    }
    const moduleFile=fileByNamespaceId.get(row.namespaceId);
    if(!moduleFile)return false;
    if(row.kind==='namespace.keys')normalized.push({kind:row.kind,moduleFile,names:row.names});
    else if(row.kind==='namespace.read')normalized.push({kind:row.kind,moduleFile,exportName:row.exportName,value:row.value});
    else if(row.kind==='namespace.descriptor')normalized.push({kind:row.kind,moduleFile,exportName:row.exportName,value:row.value});
    else return false;
  }
  return isDeepStrictEqual(normalized,observed.rows);
}
function moduleProjectionRefusal(linked,request={}){
  if(linked.metadata.requiresModuleNamespace===true&&
     !(request.experimentalNamespacePlan===true&&linked.metadata.namespaceSourcePlan&&
       linked.metadata.namespaceExecutionVariant==='synchronous-no-source-jobs/1'&&
       linked.metadata.evaluationStrategy==='dependency-concatenation'))
    return {status:'projection_refused',phase:'module-projection',
      category:'unsupported.module-namespace-projection',sourceProfile:MODULE_REGION_PROFILE,
      moduleLink:'passed',ownedRuntimeProfile:linked.profile,
      moduleNamespace:'owned-internal',moduleReference:'untested',
      publicProjection:'unqualified',nativeQualification:'unqualified',
      reason:'Owned module namespace exotics require the explicit experimental source/native plan gate'};
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
  const refused=moduleProjectionRefusal(prepared.linked,prepared.request);
  if(refused)return {...identity,...refused};
  const reference=await independentModuleRegionReference(prepared.referenceInput);
  if(reference.status!=='passed')return {...identity,status:reference.status,phase:'module-reference',
    sourceProfile:MODULE_REGION_PROFILE,reason:reference.reason};
  const {request,linked,referenceInput}=prepared,graphDigest=hashAlgorithmData(request.modules);
  const namespacePlan=linked.metadata.namespaceSourcePlan?
    buildExperimentalModuleNamespacePlanFromLinker(linked):undefined;
  const moduleEvidence={schema:'semantic-module-evidence/1',profile:MODULE_REGION_PROFILE,
    request:{modules:request.modules,entryModule:request.entryModule,exportName:request.exportName,
      inputGraph:referenceInput.inputGraph,calls:referenceInput.calls,
      ...(request.experimentalNamespacePlan?{experimentalNamespacePlan:true}:{})},graphDigest,
    generatedSourceDigest:hashAlgorithmData(linked.source),metadata:linked.metadata,referenceInput,reference,
    originalTypeScriptClaim:'provenance only; generated JavaScript semantics are checked',
    adapterMeaning:'native ESM outcome compared with owned linked code; experimental namespace source records remain unadmitted until independent native replay'};
  const ancestorIds=[...new Set([...(fixture.ancestorIds??[]),'module-graph:'+graphDigest,
    ...Object.values(request.modules).map(source=>'module-source:'+hashAlgorithmData(source))])];
  const {moduleNamespacePlan:_untrustedNamespacePlan,...callerProjectionOptions}=fixture.projectionOptions??{};
  const result=await verifyRegionTrainingCase({...fixture,source:linked.source,entry:linked.entryFunction,
    args:[linked.entryInput],fixture:fixture.fixture??{calls:[]},ancestorIds,
    projectionOptions:{...callerProjectionOptions,
      ...(namespacePlan?{moduleNamespacePlan:namespacePlan}:{})},
    provenance:{...fixture.provenance,moduleEvidence}});
  if(!result.exported)return {...identity,...result,sourceProfile:MODULE_REGION_PROFILE,moduleReference:'passed'};
  if(!outcomeAgreement(reference.outcome,result.exported.sidecar.sourceArtifact.sidecar.reference.outcome))
    return {...identity,status:'failed',phase:'module-correspondence',sourceProfile:MODULE_REGION_PROFILE,
      reason:'Native original module graph and owned linked JavaScript differ'};
  if(namespacePlan&&!namespaceObservationAgreement(reference,result.exported.sidecar.sourceArtifact,namespacePlan))
    return {...identity,status:'failed',phase:'module-namespace-correspondence',sourceProfile:MODULE_REGION_PROFILE,
      reason:'Original ESM namespace observations and source-owned namespace actions differ'};
  return {...identity,...result,sourceProfile:MODULE_REGION_PROFILE,moduleReference:'passed',
    moduleCorrespondence:'passed',moduleGraphDigest:graphDigest};
}

/** Re-run the native ESM reference and linker from source-bound private proof.
 * This is called by production v8 rechecking, never by the model serializer. */
export async function recheckModuleRegionEvidence(artifact){
  // Protocol-region callers pass the outer evidence so its actually published
  // program plan is checked. Legacy module callers may still pass the direct
  // source artifact; namespace admission requires the outer timeline form.
  const outerSide=artifact?.sidecar;
  const sourceArtifact=outerSide?.sourceArtifact?.sidecar?.sourceProvenance?
    outerSide.sourceArtifact:artifact;
  const side=sourceArtifact?.sidecar;
  const evidence=side?.sourceProvenance?.upstream?.moduleEvidence;
  if(evidence===undefined)return {status:'untested',applicable:false};
  if(evidence.schema!=='semantic-module-evidence/1'||evidence.profile!==MODULE_REGION_PROFILE)
    fail('module evidence version');
  const {decodeOwnedGraph}=await import('../host/graph-codec.js');
  const [input]=decodeOwnedGraph(JSON.stringify(evidence.request.inputGraph));
  const request={...evidence.request,args:evidence.request.calls?[]:input.args,
    calls:evidence.request.calls?.map((call,index)=>({...call,args:input.calls[index].args}))??null};
  const prepared=prepare(request);
  const publicArtifact=artifact?.public?.timeline?artifact:sourceArtifact;
  const publicProgram=publicArtifact?.public?.timeline?.find(row=>row.kind==='program');
  const publicPlan=publicProgram?.fields?.regionProgram?.moduleNamespacePlan;
  const expectedPlan=prepared.request.experimentalNamespacePlan&&prepared.linked.metadata.namespaceSourcePlan?
    buildExperimentalModuleNamespacePlanFromLinker(prepared.linked):undefined;
  if(expectedPlan!==undefined&&!publicProgram)
    fail('experimental namespace proof requires the published public region program');
  if(expectedPlan!==undefined&&!isDeepStrictEqual(publicPlan,expectedPlan))
    fail('public module namespace plan differs from freshly relinked source');
  if(expectedPlan===undefined&&publicPlan!==undefined)
    fail('public module namespace plan has no explicit source request');
  const refused=moduleProjectionRefusal(prepared.linked,prepared.request);
  if(refused)throw Object.assign(new TypeError('Module regions: '+refused.reason),refused);
  if(evidence.graphDigest!==hashAlgorithmData(prepared.request.modules)||
    evidence.generatedSourceDigest!==hashAlgorithmData(prepared.linked.source)||
    side.referenceInput.source!==prepared.linked.source||side.referenceInput.entry!==prepared.linked.entryFunction||
    !isDeepStrictEqual(prepared.referenceInput,evidence.referenceInput)||
    !isDeepStrictEqual(prepared.linked.metadata,evidence.metadata))fail('module graph, transformation, inputs or provenance changed');
  const reference=await independentModuleRegionReference(prepared.referenceInput);
  if(reference.status!=='passed'||!isDeepStrictEqual(reference,evidence.reference)||
    !outcomeAgreement(reference.outcome,side.reference.outcome))fail('independent original-module outcome changed');
  if(expectedPlan&&!namespaceObservationAgreement(reference,sourceArtifact,expectedPlan))
    fail('fresh original ESM namespace observations differ from source-owned actions');
  return {status:'passed',applicable:true,graphDigest:evidence.graphDigest};
}
