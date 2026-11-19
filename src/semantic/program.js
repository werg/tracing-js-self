// Trusted, immutable definitions are constructed from source before execution.
// Model-selected records never supply source authorization or routing evidence.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {lowerJavaScript} from './lower-js.js';
import {lowerEffectfulJavaScript} from './lower-effects.js';
import {normalizeAlgorithm} from './normalize-algorithm.js';
import {algorithmDigest,stableAlgorithmJSON,validateAlgorithm} from './ir.js';

export const ALGORITHM_PROGRAM_VERSION='semantic-algorithm-program/1';
export const ALGORITHM_EXECUTION_VERSION='semantic-execution/7';
export const ALGORITHM_CONTEXT_VERSION='semantic-context/7';
export const ALGORITHM_CONTINUATION_VERSION='semantic-continuation/7';
export const ALGORITHM_TRACE_VERSION='semantic-trace/7';
export const hashAlgorithmData=value=>createHash('sha256')
  .update(typeof value==='string'?value:stableAlgorithmJSON(value)).digest('hex');
function freeze(value){
  if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}
  return value;
}
export function defineAlgorithmProgram({source,entry}={}){
  let lowered,pureRefusal;
  try{lowered=lowerJavaScript({source,entry});}
  catch(error){pureRefusal=error.message;
    try{lowered=lowerEffectfulJavaScript({source,entry});}
    catch(effectError){const refusal=new TypeError('No certified algorithm profile: '+pureRefusal+'; '+effectError.message);
      refusal.category='unsupported.algorithm-profile';throw refusal;}}
  const core=normalizeAlgorithm(lowered.core);validateAlgorithm(core);
  const body={schema:ALGORITHM_PROGRAM_VERSION,traceFormat:ALGORITHM_TRACE_VERSION,
    source,entry,sourceDigest:hashAlgorithmData(source),core,coreDigest:algorithmDigest(core),
    boundaries:structuredClone(lowered.provenance?.boundaries??[]),
    profile:lowered.provenance?.profile??'bounded-pure-algorithm/1'};
  return {program:freeze({...body,definitionDigest:hashAlgorithmData(body)}),
    provenance:structuredClone(lowered.provenance)};
}
export function validateAlgorithmProgram(program){
  if(!program||program.schema!==ALGORITHM_PROGRAM_VERSION)throw new TypeError('Algorithm program version');
  const expected=defineAlgorithmProgram({source:program.source,entry:program.entry}).program;
  if(!isDeepStrictEqual(program,expected))throw new TypeError('Algorithm source, definition or boundary authorization changed');
  return true;
}
