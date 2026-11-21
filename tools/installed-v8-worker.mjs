#!/usr/bin/env node
// Installed application client. This file is copied out of the packed package;
// its sole producer import is the supported public V8 entry.
import * as v8 from 'tracing-js-self/semantic/v8';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync,realpathSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';

const sha256=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');

// Decode the declared data transport here, rather than importing a checkout's
// private generation worker (which eagerly initializes legacy clients).
export function decodeInstalledFixtureTask(task){
  const decode=fixture=>{
    const {argsGraph,cases,...data}=fixture;
    assert.equal(argsGraph?.schema,'owned-graph/1');assert(Array.isArray(argsGraph.roots));assert(Array.isArray(argsGraph.objects));
    const table=new Map();
    for(const node of argsGraph.objects){
      assert(!table.has(node.id));assert(['array','object'].includes(node.kind));
      table.set(node.id,node.kind==='array'?[]:node.prototype===null?Object.create(null):{});
    }
    const value=tag=>{
      assert(Array.isArray(tag));
      switch(tag[0]){
        case 'ref':assert(table.has(tag[1]));return table.get(tag[1]);
        case 'undefined':return undefined;
        case 'null':return null;
        case 'bool':case 'str':return tag[1];
        case 'bigint':return BigInt(tag[1]);
        case 'num':return tag[1]==='-0'?-0:tag[1]==='NaN'?NaN:tag[1]==='+Infinity'?Infinity:tag[1]==='-Infinity'?-Infinity:tag[1];
        default:throw new TypeError('Unsupported installed fixture value tag: '+tag[0]);
      }
    };
    for(const node of argsGraph.objects)for(const property of node.properties){
      assert.equal(typeof property.key,'string');assert.notEqual(property.key,'__proto__');
      const length=node.kind==='array'&&property.key==='length';
      Object.defineProperty(table.get(node.id),property.key,{value:value(property.value),writable:true,
        enumerable:!length,configurable:!length});
    }
    return {...data,args:argsGraph.roots.map(value),...(cases?{cases:cases.map(decode)}:{})};
  };
  return {...task,fixture:decode(task.fixture)};
}

function canonicalReferenceCheck(fixture,reference){
  const expected=fixture.provenance?.canonicalExpected,binding=fixture.provenance?.canonicalExpectedBinding??null,
    expectsThrow=!!(expected&&typeof expected==='object'&&Object.hasOwn(expected,'error')),
    expectedKind=expectsThrow?'throw':'return';
  let agrees=reference.outcome.kind===expectedKind;
  if(agrees&&!expectsThrow){
    const graph=reference.outcome.graph,value=decodeInstalledFixtureTask({fixture:{argsGraph:{schema:'owned-graph/1',
      roots:[graph.roots.at(-1)],objects:graph.objects.map(node=>({...node,
        properties:node.properties.map(([key,value])=>({key,value}))}))}}}).fixture.args[0];
    if(binding!==null){
      const known=binding.schema==='exercism-javascript-expected/1'&&binding.kind==='bigint'||
        binding.schema==='exercism-grains-bigint/1';
      if(!known||typeof binding.decimal!=='string'||binding.decimal.length>10000||
        !/^-?(?:0|[1-9][0-9]*)$/.test(binding.decimal)||typeof expected!=='number'||
        !Number.isInteger(expected)||Number(binding.decimal)!==expected)
        throw new TypeError('Invalid exact canonical JavaScript expected-value binding');
      // Match the independently declared contextual binding used by the full
      // generation worker; never coerce an observed Number into a BigInt pass.
      if(fixture.family!=='exercism/javascript:grains'||
        !['square','total'].includes(fixture.provenance.canonicalProperty)||!/^(0|[1-9]\d*)$/.test(binding.decimal))
        throw new TypeError('Invalid exact Exercism JavaScript expected-value binding');
      agrees=typeof value==='bigint'&&value.toString()===binding.decimal;
    }else agrees=isDeepStrictEqual(value,expected);
  }
  return {status:agrees?'agreed':'disagreed',mode:expectsThrow?'error-completion-only':
    binding?'exact-bigint-return':'exact-return-value',expectedKind,observedKind:reference.outcome.kind};
}

export async function executeInstalledV8Task(encodedTask,{producerRevision,packageLockSha256}={}){
  const task=decodeInstalledFixtureTask(encodedTask),fixture=task.fixture;
  assert(['source','module'].includes(task.kind));assert.equal(task.traceVersion,8);
  const options={...fixture,producerRevision,taskId:fixture.id,nativePolicy:null,nativeConsumer:null};
  let originalSourceEvidence=null,result;
  if(fixture.preflightFailure)return {...fixture.preflightFailure,installedChecks:{source:'not-run',native:'untested',model:'untested'}};
  const canonical=fixture.provenance?.inputOrigin==='upstream-canonical'&&fixture.provenance.canonicalExpected!==undefined;
  if(task.kind==='source'&&(fixture.originalReferenceSource||canonical)){
    const input={source:fixture.originalReferenceSource??fixture.source,entry:fixture.entry,inputGraph:encodedTask.fixture.argsGraph,
      fixture:fixture.fixture??{calls:[]},randomSeed:fixture.randomSeed??fixture.seeds?.guestRng??null};
    const original=await v8.independentSourceReferenceV8(input,{timeoutMs:fixture.timeoutMs??10000}),
      transformed=await v8.independentSourceReferenceV8({...input,source:fixture.source},{timeoutMs:fixture.timeoutMs??10000});
    originalSourceEvidence={input,transformedSource:fixture.source,original,transformed,
      originalReferenceDigest:sha256(original),transformedReferenceDigest:sha256(transformed)};
    if(!isDeepStrictEqual(original,transformed))return {status:'original_source_mismatch',
      reason:'Pinned original and transformed source observations disagree',originalSourceEvidence,
      installedChecks:{source:'refused',native:'untested',model:'untested'}};
    const canonicalCheck=canonical?canonicalReferenceCheck(fixture,original):null;
    if(canonicalCheck){
      originalSourceEvidence.canonicalExpected=fixture.provenance.canonicalExpected;
      originalSourceEvidence.canonicalExpectedBinding=fixture.provenance.canonicalExpectedBinding??null;
      originalSourceEvidence.canonicalCheck=canonicalCheck;
      if(canonicalCheck.status!=='agreed')return {status:'canonical_mismatch',
        reason:'Pinned original source disagrees with independent canonical expected result',originalSourceEvidence,
        installedChecks:{source:'refused',native:'untested',model:'untested'}};
    }
    options.provenance={...fixture.provenance,originalSourceCheck:{status:'agreed',
      originalReferenceDigest:originalSourceEvidence.originalReferenceDigest,
      transformedReferenceDigest:originalSourceEvidence.transformedReferenceDigest,
      ...(canonicalCheck?{canonicalExpectation:{status:'agreed',outcomeKind:canonicalCheck.expectedKind,
        expectedValueBinding:fixture.provenance.canonicalExpectedBinding??null,
        ...(canonicalCheck.expectedKind==='throw'?{canonicalErrorMessageCompared:false}:{})}}:{})},
      ...(canonicalCheck?{canonicalCheck}:{})};
  }
  result=await(task.kind==='module'?v8.verifyRegionModuleTrainingCase(options):v8.verifyRegionTrainingCase(options));
  if(!result.exported&&/Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED/.test(result.reason??''))
    return {status:'installed_dependency_failure',reason:result.reason,candidate:result,
      ...(originalSourceEvidence?{originalSourceEvidence}:{}),installedChecks:{source:'failed',native:'untested',model:'untested'}};
  if(!result.exported)return {...result,...(originalSourceEvidence?{originalSourceEvidence}:{}),
    installedChecks:{source:'refused',native:'untested',model:'untested'}};
  try{
    const artifact=result.exported,checked=await v8.recheckRegionEvidence(artifact);
    assert.equal(checked.sourceValidated,true);assert.equal(checked.projectionValidated,true);assert.equal(checked.replayValidated,true);
    assert.equal(checked.native.admitted,false);assert.equal(artifact.sidecar.nativeAdmission,null);
    const environment=artifact.sidecar.sourceArtifact?.sidecar.environment;
    if(environment)assert.equal(environment.packageLockDigest,packageLockSha256,'source evidence must name this installed lock');
    const replay=v8.RegionExecutionHarness.replay(artifact),checkpoint=JSON.parse(JSON.stringify(replay.checkpoint())),
      restored=v8.RegionExecutionHarness.restore(checkpoint);
    assert.deepEqual(restored.exportEpisode(),artifact.public);
    for(const [id,activation]of replay.invocations)assert.deepEqual(
      v8.sharedRegionState(restored.invocations.get(id).controller),v8.sharedRegionState(activation.controller));
    const first=artifact.public.timeline.findIndex(row=>row.mode==='generated');assert(first>=0);
    const cutoff=first+1,prefix=v8.RegionExecutionHarness.replay({...artifact.public,
      timeline:artifact.public.timeline.slice(0,cutoff)},{requireTerminal:false}),
      continuation=v8.RegionExecutionHarness.restore(JSON.parse(JSON.stringify(prefix.checkpoint())));
    for(const row of artifact.public.timeline.slice(cutoff)){
      if(row.mode==='generated')continuation.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
      else continuation.importObserved(row);
      assert.deepEqual(continuation.timeline.at(-1),row);
    }
    assert.deepEqual(continuation.exportEpisode(),artifact.public);
    return {...result,...(originalSourceEvidence?{originalSourceEvidence}:{}),installedChecks:{
      source:'passed',sourceRechecked:true,publicReplayed:true,checkpointRestored:true,continuedFromPrefix:true,
      continuationCutoff:cutoff,packageLockSha256,sourceEnvironmentPresent:!!environment,
      contractDigest:v8.V8_CONTRACT_DIGEST,fixtureDigest:v8.V8_FIXTURE_DIGEST,
      interoperabilityDigest:v8.V8_INTEROPERABILITY_DIGEST,native:'untested',model:'untested',optimizerSteps:0}};
  }catch(error){return {status:'installed_validation_failed',reason:String(error.message),candidate:result,
    ...(originalSourceEvidence?{originalSourceEvidence}:{}),installedChecks:{source:'failed',native:'untested',model:'untested'}};}
}

async function main(){
  let input='',bytes=0;for await(const chunk of process.stdin){bytes+=chunk.length;
    if(bytes>33554432)throw new RangeError('Installed worker input bound');input+=chunk;}
  const request=JSON.parse(input),entry=import.meta.resolve('tracing-js-self/semantic/v8'),
    root=realpathSync(fileURLToPath(new URL('../../',entry)));
  assert.equal(root,realpathSync(request.packageRoot));assert.match(root,/\/node_modules\/tracing-js-self$/);
  for(const route of ['tracing-js-self/semantic','tracing-js-self/training'])
    await assert.rejects(import(route),error=>error.code==='ERR_MODULE_NOT_FOUND');
  let result;
  if(request.mode==='recheck'){
    let nativeCalls=0;
    try{
      await v8.recheckRegionEvidence(request.candidate,{nativePolicy:v8.loadV8NativePolicy(),
        nativeConsumer:async()=>{nativeCalls++;return {admitted:true};}});
      result={status:'unexpectedly_accepted',nativeCalls};
    }catch(error){result={status:'refused',reason:String(error.message),code:error.code??null,nativeCalls};}
  }else{
    const lock=readFileSync(new URL('../../npm-shrinkwrap.json',entry));
    try{result=await executeInstalledV8Task(request.task,{producerRevision:request.producerRevision,packageLockSha256:sha256(lock)});}
    catch(error){result={status:'installed_worker_failure',reason:String(error.message),phase:'installed-public-entry'};}
  }
  let payload=Buffer.from(JSON.stringify(result)+'\n');
  if(payload.length>request.maxOutputBytes)payload=Buffer.from(JSON.stringify({status:'worker_output_limit',
    reason:'Installed evidence exceeded '+request.maxOutputBytes+' bytes'})+'\n');
  const temporary=request.output+'.tmp';writeFileSync(temporary,gzipSync(payload));renameSync(temporary,request.output);
  process.stdout.write(JSON.stringify({peakRssBytes:process.resourceUsage().maxRSS*1024,entry,
    packageRoot:root,legacyClients:'absent'})+'\n');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))await main();
