// A separate evidence identity for direct v8 protocol source checking. Shared
// source observers are reused; this never admits values into historical public
// v6/v7 grammars or invokes a historical source projector.
import {createCompletionCapture,ownedCompletionObservations,compareCompletionObservations}
  from '../training/completion-reference.js';
export const PROTOCOL_COMPLETION_OBSERVATION_SCHEMA='source-protocol-completions/1';
export function createProtocolCompletionCapture(options){return createCompletionCapture(options);}
export function ownedProtocolCompletionObservations(bundle,source){return ownedCompletionObservations(bundle,source);}
export function compareProtocolCompletionObservations(expected,observed){
  return {...compareCompletionObservations(expected,observed),schema:PROTOCOL_COMPLETION_OBSERVATION_SCHEMA,
    referenceValues:'scalars-and-input-rooted-reference-or-symbol-identity'};
}
