// Direct V8 lifecycle boundary. State, effects, callbacks, journal acknowledgments
// and recovery use the neutral core; no older wire envelope is manufactured.
import {SelectedExecutionCore} from './execution-lifecycle.js';
import {SemanticControllerV8} from './controller-v8.js';
import {encodeDetailedRecord,decodeDetailedRecord} from './detail-v8.js';

export const V8_LIFECYCLE_CONTRACT=Object.freeze({executionVersion:'semantic-lifecycle/8',
    traceVersion:'semantic-trace/8',contextVersion:'semantic-context/8',
    continuationVersion:'semantic-continuation/8',profile:'selected-harness/8',
    checkpointVersion:'semantic-checkpoint/8',supervisionVersion:'semantic-supervision/8'});

export class SelectedExecutionLifecycleV8 extends SelectedExecutionCore {
  static Controller=SemanticControllerV8;
  static contract=V8_LIFECYCLE_CONTRACT;
  static encodeRecord(kind,fields){return encodeDetailedRecord({kind,fields});}
  static decodeRecord(record){return decodeDetailedRecord(record);}
}
