// Historical wire boundary over shared selected-state and lifecycle semantics.
import {SelectedExecutionCore} from '../semantic/execution-lifecycle.js';
import {SemanticController} from './controller.js';
import {decodeWitness,encodeWitness,WITNESS_VERSION,EXECUTION_VERSION,
  CONTEXT_VERSION,CONTINUATION_VERSION,HARNESS_PROFILE} from './format.js';

export const HARNESS_ENVELOPE_VERSION=EXECUTION_VERSION;
export const HARNESS_SELECTED_TRACE_VERSION=WITNESS_VERSION;
export class SelectedExecutionHarness extends SelectedExecutionCore {
  static Controller=SemanticController;
  static contract=Object.freeze({executionVersion:EXECUTION_VERSION,
    traceVersion:WITNESS_VERSION,contextVersion:CONTEXT_VERSION,
    continuationVersion:CONTINUATION_VERSION,profile:HARNESS_PROFILE,
    checkpointVersion:'semantic-checkpoint/6',supervisionVersion:'semantic-supervision/2'});
  static encodeRecord(kind,fields){return encodeWitness(kind,fields);}
  static decodeRecord(record){return decodeWitness(record);}
}
