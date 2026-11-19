// Separate evidence identities for direct v8 protocol source checking. Shared
// source observers do not admit values into historical public v6/v7 grammars.
import {createCompletionCapture,ownedCompletionObservations,compareCompletionObservations}
  from '../training/completion-reference.js';
import {createNativeProtocolMetadata,createOwnedProtocolMetadata} from './protocol-metadata-v8.js';
export const PROTOCOL_COMPLETION_OBSERVATION_SCHEMA='source-protocol-completions/1';
export const PROTOCOL_METADATA_LIMITS=Object.freeze({snapshots:8192,bytes:4194304,snapshotBytes:1048576});
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
export function ownedProtocolSourceObservations(bundle,source){
  const observer=createOwnedProtocolMetadata(bundle),bounded=boundedMetadata(),metadata=bounded.receipts;
  const completions=ownedCompletionObservations(bundle,source,{onObservation:observation=>bounded.append(observer.observe(observation))});
  return {completions,metadata};
}
export function ownedProtocolCompletionObservations(bundle,source){return ownedProtocolSourceObservations(bundle,source).completions;}
export function compareProtocolCompletionObservations(expected,observed){
  return {...compareCompletionObservations(expected,observed),schema:PROTOCOL_COMPLETION_OBSERVATION_SCHEMA,
    referenceValues:'scalars-and-input-rooted-reference-or-symbol-identity'};
}
