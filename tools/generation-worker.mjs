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
      if(!result&&expected!==undefined&&options.provenance?.inputOrigin==='upstream-canonical'){
        const expectsError=expected&&typeof expected==='object'&&Object.hasOwn(expected,'error');
        let matches=original.outcome.kind===(expectsError?'throw':'return');
        if(matches&&!expectsError){
          const graph=original.outcome.graph;
          const value=decodeOwnedGraph(JSON.stringify({schema:'owned-graph/1',roots:[graph.roots.at(-1)],
            objects:graph.objects.map(object=>({...object,
              properties:object.properties.map(([key,value])=>({key,value}))}))}))[0];
          matches=isDeepStrictEqual(value,expected);
        }
        // Canonical error prose is language-neutral: pinned JS proof messages
        // can differ (including case and wording). Require the error completion
        // here; original/transform/owned comparisons bind its exact JS graph.
        const canonicalCheck={status:matches?'agreed':'disagreed',
          mode:expectsError?'error-completion-only':'exact-return-value',
          expectedKind:expectsError?'throw':'return',observedKind:original.outcome.kind};
        options.provenance={...options.provenance,canonicalCheck};
        if(!matches)result={status:'canonical_mismatch',
          reason:'Pinned original source disagrees with independent canonical expected result',
          failure:{referenceInput,original,canonicalExpected:expected,canonicalCheck}};
      }
      if(!result)options.provenance={...options.provenance,originalSourceCheck:{status:'agreed',
        originalReferenceDigest:identityHash(original),transformedReferenceDigest:identityHash(transformed)}};
    }
    if(!result){phase='owned-verification';result=await verifyEffectfulTrainingCase(options);}
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
