#!/usr/bin/env node
// Internal process worker. Inputs are trusted authored/pinned candidates only;
// process bounds and environment scrubbing do not make Node vm a sandbox.
import {deserialize} from 'node:v8';
import {isDeepStrictEqual} from 'node:util';
import {atomicWrite} from '../src/corpus/campaign-store.mjs';
import {identityHash} from '../src/corpus/campaign-store.mjs';
import {createNativeConsumer} from '../src/corpus/native-admission-client.mjs';
import {verifyEffectfulTrainingCase,independentEffectfulReference} from '../src/training/effectful-admit.js';
import {verifyEffectfulSession} from '../src/training/effectful-session.js';
import {encodeNativeGraph,decodeOwnedGraph} from '../src/host/graph-codec.js';
import {decodeGenerationTask} from '../src/corpus/generation-process.mjs';
import {canonicalJavaScriptExpected} from '../src/corpus/owned-exercism.mjs';
import {canonicalReturnMatches} from '../src/corpus/exercism-language-bindings.mjs';

const chunks=[];let inputBytes=0;
for await(const chunk of process.stdin){inputBytes+=chunk.length;
  if(inputBytes>33554432)throw new RangeError('Generation worker input bound exceeded');chunks.push(chunk);}
const {task:encodedTask,output,maxOutputBytes}=deserialize(Buffer.concat(chunks));
const task=decodeGenerationTask(encodedTask);
let result,phase='candidate';
try{
  const nativeConsumer=createNativeConsumer(task.native),options={...task.fixture,
    producerRevision:task.producerRevision,nativeConsumer,nativePolicy:task.native?.policy??null,
    taskId:task.fixture.id};
  if(options.preflightFailure)result={...options.preflightFailure,
    failure:{source:options.source,originalSource:options.originalReferenceSource,
      inputGraph:encodeNativeGraph(options.args??[]),provenance:options.provenance}};
  else if(task.kind==='source'){
    if(options.originalReferenceSource){
      phase='original-reference';
      const referenceInput={source:options.originalReferenceSource,entry:options.entry,
        inputGraph:encodeNativeGraph(options.args??[]),fixture:options.fixture,
        randomSeed:options.randomSeed??options.seeds?.guestRng??null};
      const original=await independentEffectfulReference(referenceInput,{timeoutMs:options.timeoutMs??10000});
      const transformed=await independentEffectfulReference({...referenceInput,source:options.source},
        {timeoutMs:options.timeoutMs??10000});
      if(!isDeepStrictEqual(original,transformed))result={status:'original_source_mismatch',
        reason:'Pinned original and transformed source observations disagree',
        failure:{referenceInput,transformedSource:options.source,original,transformed}};
      const expected=options.provenance?.canonicalExpected;
      let canonicalExpectation=null;
      if(!result&&expected!==undefined&&options.provenance?.inputOrigin==='upstream-canonical'){
        const expectsThrow=!!(expected&&typeof expected==='object'&&Object.hasOwn(expected,'error'));
        const outcomeKind=expectsThrow?'throw':'return';
        let agrees=original.outcome.kind===outcomeKind;
        if(agrees&&!expectsThrow){
          const graph=original.outcome.graph;
          const value=decodeOwnedGraph(JSON.stringify({schema:'owned-graph/1',roots:[graph.roots.at(-1)],
            objects:graph.objects.map(object=>({...object,
              properties:object.properties.map(([key,value])=>({key,value}))}))}))[0];
          const binding=options.provenance?.canonicalExpectedBinding??null;
          if(binding)canonicalJavaScriptExpected(expected,binding);
          const contextualBinding=binding?.schema==='exercism-javascript-expected/1'?
            {schema:'exercism-grains-bigint/1',decimal:binding.decimal}:binding;
          agrees=canonicalReturnMatches(value,expected,contextualBinding,
            {family:options.family,property:options.provenance?.canonicalProperty});
        }
        const canonicalCheck={status:agrees?'agreed':'disagreed',
          mode:expectsThrow?'error-completion-only':options.provenance?.canonicalExpectedBinding?
            'exact-bigint-return':'exact-return-value',
          expectedKind:outcomeKind,observedKind:original.outcome.kind};
        options.provenance={...options.provenance,canonicalCheck};
        if(!agrees)result={status:'canonical_mismatch',
          reason:'Pinned original source disagrees with independent canonical expected result',
          failure:{referenceInput,original,canonicalExpected:expected,
            canonicalExpectedBinding:options.provenance?.canonicalExpectedBinding??null,canonicalCheck}};
        else canonicalExpectation={status:'agreed',outcomeKind,
          expectedValueBinding:options.provenance?.canonicalExpectedBinding??null,
          // Language-neutral error descriptions do not assert JS exception
          // wording. The independent original/owned gates still compare the
          // actual observable exception name/message exactly.
          ...(expectsThrow?{canonicalErrorMessageCompared:false}:{})};
      }
      if(!result)options.provenance={...options.provenance,originalSourceCheck:{status:'agreed',
        originalReferenceDigest:identityHash(original),transformedReferenceDigest:identityHash(transformed),
        ...(canonicalExpectation?{canonicalExpectation}:{})}};
    }
    if(!result){
      phase='owned-verification';
      if(task.traceVersion===8){const {verifyRegionTrainingCase}=await import('../src/semantic/compiler-v8.js');
        result=await verifyRegionTrainingCase(options);}
      else if(task.traceVersion===7){const {verifyAlgorithmTrainingCase}=await import('../src/semantic/compiler.js');
        result=await verifyAlgorithmTrainingCase(options);}
      else if(task.traceVersion===undefined||task.traceVersion===6)result=await verifyEffectfulTrainingCase(options);
      else throw new Error('Unknown generation trace version');
    }
  }
  else if(task.kind==='session')result=await verifyEffectfulSession(options);
  else throw new Error('Unknown generation task kind');
}catch(error){result={status:phase==='original-reference'?'original_reference_failure':'collection_failed',
  phase,reason:String(error.message??error),failure:{source:task.fixture.source,originalSource:task.fixture.originalReferenceSource,
    inputGraph:encodeNativeGraph(task.fixture.args??[]),provenance:task.fixture.provenance}};}
let bytes=Buffer.from(JSON.stringify(result)+'\n');
if(bytes.length>maxOutputBytes)bytes=Buffer.from(JSON.stringify({status:'worker_output_limit',
  reason:'Generated evidence exceeded '+maxOutputBytes+' bytes'})+'\n');
atomicWrite(output,bytes);
process.stdout.write(JSON.stringify({peakRssBytes:process.resourceUsage().maxRSS*1024})+'\n');
