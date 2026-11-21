// Private dataset identity. Public prediction records never carry provenance,
// final heaps, or verifier receipts. The payload is fixed before native
// admission; a separate receipt binding avoids a self-referential hash.
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {isDeepStrictEqual} from 'node:util';
import {TRAINING_PROFILE,TRAINING_PARSER} from '../training/profile.js';
import {verifyFrozenSplitIdentity,verifySourceRegistry,immutableSourceRegistry} from '../corpus/source-registry.mjs';
import {referenceIsolationIdentity} from '../corpus/reference-isolation.mjs';

const require=createRequire(import.meta.url);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function canonicalJson(value){
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalJson(value[key])).join(',')+'}';
}
export const identityDigest=value=>sha256(canonicalJson(value));
const exactHash=value=>sha256(typeof value==='string'?value:JSON.stringify(value));
const unique=items=>[...new Set(items)].sort();
const fail=message=>{throw new Error('Candidate identity evidence changed: '+message);};

export function effectfulFamilySplit(family,{seed=17}={}){
  if(typeof family!=='string'||!family)throw new TypeError('A stable source/task family is required before expansion');
  if(!Number.isSafeInteger(seed))throw new TypeError('The split seed must be a safe integer');
  const bucket=Number.parseInt(exactHash(seed+':'+family).slice(0,8),16)%100;
  return bucket<80?'train':bucket<90?'validation':'test';
}
export function defaultSplitIdentity(family,{seed=17}={}){
  return {schema:'semantic-split-identity/1',policy:'family-hash/1',seed,
    componentId:family,members:[family],split:effectfulFamilySplit(family,{seed}),registryDigest:null,holdout:null};
}
export function cloneSplitIdentity(value){
  const {registry,...fields}=value;
  return {...structuredClone(fields),...(registry?{registry:immutableSourceRegistry(registry)}:{})};
}
export function validateSplitIdentity(value,{family,seed}={}){
  if(value?.schema!=='semantic-split-identity/1'||!Number.isSafeInteger(value.seed)||
    value.seed!==seed||!Array.isArray(value.members)||value.members.some(x=>typeof x!=='string'||!x)||
    !value.members.includes(family)||!isDeepStrictEqual(unique(value.members),value.members))fail('split membership');
  if(value.policy==='family-hash/1'){
    if(!isDeepStrictEqual(value,defaultSplitIdentity(family,{seed})))fail('family split policy');
  }else if(value.policy==='source-components/1'){
    let registryDigest;
    try{registryDigest=verifySourceRegistry(value.registry).digest;}
    catch(error){fail('frozen source registry: '+error.message);}
    if(value.componentId!=='component:'+exactHash(value.members)||
      !/^[a-f0-9]{64}$/.test(value.registryDigest??'')||!value.registry||
      registryDigest!==value.registryDigest)fail('frozen registry digest');
    const heldOut=value.holdout!==null&&value.holdout!==undefined;
    if(heldOut&&(!['upstream-project','composition'].includes(value.holdout.kind)||
      typeof value.holdout.key!=='string'||!value.holdout.key))fail('holdout declaration');
    if(value.split!==(heldOut?'test':effectfulFamilySplit(value.componentId,{seed})))fail('component split policy');
    const component=value.registry.components?.find(item=>item.id===value.componentId);
    if(!component||!isDeepStrictEqual(component.members,value.members)||component.split!==value.split||
      !isDeepStrictEqual(component.holdout??null,value.holdout??null))fail('frozen component membership');
    try{verifyFrozenSplitIdentity(value,{family,seed});}catch(error){fail('frozen source registry: '+error.message);}
  }else fail('unknown split policy');
  return true;
}

let cachedEnvironment;
export function admissionEnvironment(){
  if(!cachedEnvironment){
    const root=new URL('../../',import.meta.url),files=[];
    function collect(directory,prefix){
      for(const item of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
        if(item.isDirectory())collect(new URL(item.name+'/',directory),prefix+item.name+'/');
        else if(/\.(?:js|mjs|json)$/.test(item.name))files.push([prefix+item.name,sha256(readFileSync(new URL(item.name,directory)))]);
      }
    }
    collect(new URL('src/',root),'src/');
    collect(new URL('catalog/',root),'catalog/');
    files.push(['tools/effectful-reference-worker.mjs',sha256(readFileSync(new URL('tools/effectful-reference-worker.mjs',root)))]);
    cachedEnvironment={schema:'semantic-execution-environment/1',
      node:process.versions.node,v8:process.versions.v8,platform:process.platform,arch:process.arch,
      timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
      parser:require('acorn/package.json').version,typescript:require('typescript/package.json').version,
      packageLockDigest:sha256(readFileSync(new URL('package-lock.json',root))),
      implementationDigest:identityDigest(files)};
  }
  return {...structuredClone(cachedEnvironment),
    timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale:Intl.DateTimeFormat().resolvedOptions().locale,referenceIsolation:referenceIsolationIdentity()};
}

export function normalizeSeeds(seeds={},split=17,guestRng=null){
  if(seeds.guestRng!==undefined&&seeds.guestRng!==guestRng)
    throw new TypeError('The declared guest RNG seed must match the executed fixture');
  const result={generation:null,input:null,schedule:null,optimizer:null,...seeds,guestRng,split};
  if(Object.values(result).some(value=>value!==null&&!Number.isSafeInteger(value)))
    throw new TypeError('Candidate seeds must be safe integers or explicit null');
  return result;
}
function identityPayload(exported,contract){
  const side=exported.sidecar;
  if(side.evidenceKind!=='deterministic-engineering'||side.optimizerSteps!==0||
    side.learnedSuccess!==undefined&&side.learnedSuccess!==null)
    fail('teacher evidence kind, optimizer steps or unmeasured learned success');
  if(typeof side.sourceFamily!=='string'||!side.sourceFamily||side.sourceLineage!==side.sourceFamily||
    side.sourceProvenance?.family!==side.sourceFamily||side.sourceProvenance?.license!==side.license||
    side.sourceProvenance?.trustTier!==side.trustTier||
    side.projectionOptions&&side.projectionOptions.sourceLineage!==side.sourceFamily||
    !Array.isArray(side.ancestorIds)||side.ancestorIds.some(x=>typeof x!=='string'||!x)||
    !side.ancestorIds.includes(side.sourceFamily)||new Set(side.ancestorIds).size!==side.ancestorIds.length)
    fail('source family, lineage, license or ancestors');
  validateSplitIdentity(side.splitIdentity,{family:side.sourceFamily,seed:side.sourceProvenance.seed});
  if(side.split!==side.splitIdentity.split||side.seeds?.split!==side.splitIdentity.seed)fail('split assignment');
  if(side.archive&&side.seeds?.guestRng!==(side.archive.initialState.control.a0.randomSeed??null))
    fail('guest RNG seed differs from executed fixture');
  if(side.splitIdentity.policy==='source-components/1'){
    if(side.ancestorIds.some(id=>!side.splitIdentity.members.includes(id)))fail('ancestor outside frozen component');
    if(side.referenceInput.source!==undefined&&!side.splitIdentity.registry.sources.some(row=>
      row.family===side.sourceFamily&&row.sourceSha256===exactHash(side.referenceInput.source)))
      fail('source bytes absent from frozen family');
  }
  if(!isDeepStrictEqual(side.environment,admissionEnvironment()))fail('runtime, dependency or verifier environment');
  if(!contract||typeof contract.identitySchema!=='string'||typeof contract.execution!=='string'||
    typeof contract.trace!=='string'||typeof contract.context!=='string'||typeof contract.harness!=='string'||
    !/^[0-9a-f]{64}$/.test(contract.digest??'')||!/^[0-9a-f]{64}$/.test(contract.fixtureDigest??''))
    fail('source admission contract');
  return {schema:contract.identitySchema,episodeDigest:exactHash(exported.public),
    source:{provenance:side.sourceProvenance,referenceInputDigest:identityDigest(side.referenceInput)},
    lineage:{sourceFamily:side.sourceFamily,sourceLineage:side.sourceLineage,fixtureFamily:side.fixtureFamily,
      taskId:side.taskId,ancestorIds:side.ancestorIds},split:side.splitIdentity,
    execution:{profile:TRAINING_PROFILE,parser:TRAINING_PARSER,execution:contract.execution,
      trace:contract.trace,context:contract.context,harness:contract.harness,representation:side.representation,
      capabilities:side.capabilityProfile,limits:side.executionLimits,
      projectionOptions:side.projectionOptions??null,completionPolicy:'complete-root-and-observed-callbacks/1'},
    seeds:side.seeds,environment:side.environment,
    certification:{producerRevision:side.producerRevision,catalogDigest:side.catalogDigest,
      evidenceKind:side.evidenceKind,optimizerSteps:side.optimizerSteps,learnedSuccess:null,
      schemaDigest:contract.digest,fixtureDigest:contract.fixtureDigest,
      archiveDigest:side.archive?exactHash(side.archive):null,
      referenceDigest:identityDigest(side.reference),effectsDigest:identityDigest(side.effects),
      compilerDigest:side.compiler?identityDigest(side.compiler):null,
      replayDigest:side.replay?identityDigest(side.replay):null,
      componentIdentities:side.collection?.components.map(component=>component.sidecar.identityDigest)??[],
      nativePolicy:side.nativePolicy??null}};
}
export function bindSourceAdmissionIdentity(exported,contract){
  const payload=identityPayload(exported,contract);
  exported.sidecar.identity=structuredClone(payload);
  exported.sidecar.identityDigest=identityDigest(payload);
  return exported.sidecar.identityDigest;
}
export function verifySourceAdmissionIdentity(exported,contract,{expectedIdentityDigest=null}={}){
  const side=exported?.sidecar;
  if(!side?.identity||side.identityDigest!==identityDigest(side.identity)||
    expectedIdentityDigest!==null&&side.identityDigest!==expectedIdentityDigest)fail('immutable payload digest');
  if(!isDeepStrictEqual(side.identity,identityPayload(exported,contract)))fail('immutable payload');
  return side.identityDigest;
}
