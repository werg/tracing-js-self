// Separate evidence identities for direct v8 protocol source checking. Shared
// source observers do not admit values into historical public v6/v7 grammars.
import {createCompletionCapture,ownedCompletionObservations,compareCompletionObservations}
  from '../training/completion-reference.js';
import {createNativeProtocolMetadata,createOwnedProtocolMetadata} from './protocol-metadata-v8.js';
import {PROTOCOL_OBSERVATION_ADAPTERS_V8} from './protocol-observation-extensions-v8.js';
export const PROTOCOL_COMPLETION_OBSERVATION_SCHEMA='source-protocol-completions/1';
export const PROTOCOL_METADATA_LIMITS=Object.freeze({snapshots:8192,bytes:4194304,snapshotBytes:1048576});
/** Trusted, statically registered producer extensions; never serving input. */
export function prepareProtocolObservationExtensionsV8({source,mode='completions',side='native',bundle=null,
  adapters=PROTOCOL_OBSERVATION_ADAPTERS_V8}={}){
  if(mode!=='completions')return {ids:[],globals:{},metadataAdapters:[],instrument:text=>text,initializeRealm(){}};
  const selected=adapters.map(adapter=>typeof adapter==='function'?adapter({source,mode,side,bundle}):adapter).filter(Boolean);
  const globals={},metadataAdapters=[],ids=[];
  for(const adapter of selected){
    if(typeof adapter.id!=='string'||!adapter.id||ids.includes(adapter.id))throw new TypeError('Distinct observation extension identity required');
    ids.push(adapter.id);
    for(const [name,value]of Object.entries(adapter.globals??{})){
      if(!/^__tracingProtocol[A-Za-z0-9_$]+$/.test(name)||Object.hasOwn(globals,name))
        throw new TypeError('Observation extension global must have a distinct reserved name');
      globals[name]=value;
    }
    if(adapter.metadataAdapter)metadataAdapters.push(adapter.metadataAdapter);
  }
  return {ids,globals,metadataAdapters,assignmentValue(observation){
    for(const adapter of selected){const value=adapter.ownedAssignmentValue?.(observation);if(value!==undefined&&value!==null)return value;}
    return undefined;
  },initializeRealm(evaluate){
    if(typeof evaluate!=='function')throw new TypeError('Independent realm initializer requires an evaluator');
    for(const adapter of selected)adapter.initializeRealm?.(evaluate);
  },instrument(text){
    for(const adapter of selected)if(adapter.instrument){text=adapter.instrument(text);
      if(typeof text!=='string')throw new TypeError('Observation instrumentation must return source text');}
    return text;
  }};
}
function boundedMetadata(){let bytes=0;const receipts=[];return {receipts,append(row){
  const size=Buffer.byteLength(JSON.stringify(row),'utf8');
  if(receipts.length>=PROTOCOL_METADATA_LIMITS.snapshots||size>PROTOCOL_METADATA_LIMITS.snapshotBytes||bytes+size>PROTOCOL_METADATA_LIMITS.bytes)
    throw new RangeError('Independent protocol metadata observation bound');
  bytes+=size;receipts.push(row);
}};}
export function createProtocolCompletionCapture(options){
  const completion=createCompletionCapture(options),metadata=createNativeProtocolMetadata(options),bounded=boundedMetadata(),receipts=bounded.receipts;
  return {...completion,metadata:receipts,setIntrinsicPrototypes:metadata.setIntrinsicPrototypes,
    capture(site,kind,value){const result=completion.capture(site,kind,value);bounded.append(metadata.observe(site,kind,value));return result;}};
}
export function ownedProtocolSourceObservations(bundle,source,{adapters=PROTOCOL_OBSERVATION_ADAPTERS_V8}={}){
  const extensions=prepareProtocolObservationExtensionsV8({source,side:'owned',bundle,adapters});
  const observer=createOwnedProtocolMetadata(bundle,{adapters:extensions.metadataAdapters}),bounded=boundedMetadata(),metadata=bounded.receipts;
  const completions=ownedCompletionObservations(bundle,source,{assignmentValue:extensions.assignmentValue,
    onObservation:observation=>bounded.append(observer.observe(observation))});
  return {completions,metadata};
}
export function ownedProtocolCompletionObservations(bundle,source){return ownedProtocolSourceObservations(bundle,source).completions;}
export function compareProtocolCompletionObservations(expected,observed){
  return {...compareCompletionObservations(expected,observed),schema:PROTOCOL_COMPLETION_OBSERVATION_SCHEMA,
    referenceValues:'scalars-and-input-rooted-reference-or-symbol-identity'};
}
