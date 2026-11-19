// Explicit public operation/state extensions. Registration changes the pinned
// contract and requires independent consumer parity before production admission.
import {MEMORY_PROFILE_V8,MEMORY_RECORD_FIELDS,validateMemoryRecordV8,applyMemoryRecordV8,restoreMemoryStateV8} from './protocol-memory-v8.js';
import {isBinaryMemoryKind} from '../binary-memory-validation.js';
import {CONSTRUCTION_RECORD_FIELDS,validateConstructionRecordV8,applyConstructionRecordV8,restoreConstructionStateV8,
  constructionReservedIdentitiesV8,hasConstructionStateV8,assertConstructionNextV8,assertConstructionCallV8} from './protocol-construction-v8.js';
import {hasConstructionSourceCallableV8} from './protocol-construction-source-inventory-v8.js';
import {ITERATOR_PROFILE_V8,ITERATOR_RECORD_FIELDS,validateIteratorRecordV8,applyIteratorRecordV8,
  restoreIteratorStateV8,hasIteratorStateV8} from './protocol-iterator-v8.js';
import {PROMISE_JOIN_PROFILE_V8,PROMISE_JOIN_RECORD_FIELDS,validatePromiseJoinRecordV8,
  applyPromiseJoinRecordV8,restorePromiseJoinStateV8,assertPromiseJoinNextV8,
  allowsPromiseJoinInternalSchedulerV8,allowsPromiseJoinWithoutStackV8,allowsPromiseJoinDetailedCallV8} from './protocol-promise-join-v8.js';
import {NUMBER_RECORD_FIELDS,validateNumberRecordV8,applyNumberRecordV8,restoreNumberStateV8,assertNumberNextV8} from './protocol-number-v8.js';
import {GENERATOR_PROFILE_V8,GENERATOR_RECORD_FIELDS,GENERATOR_INTRINSICS_V8,validateGeneratorRecordV8,
  applyGeneratorRecordV8,restoreGeneratorStateV8,hasGeneratorStateV8,assertGeneratorCallV8,
  assertGeneratorNextV8,resolveGeneratorIntrinsicV8} from './protocol-generator-v8.js';
export const PROTOCOL_MACHINE_ADAPTERS_V8=Object.freeze([Object.freeze({
  id:MEMORY_PROFILE_V8,recordFields:MEMORY_RECORD_FIELDS,validateRecord:validateMemoryRecordV8,applyRecord:applyMemoryRecordV8,
  hasRichState:node=>isBinaryMemoryKind(node.kind),
  restoreState:(controller,_snapshot,api)=>restoreMemoryStateV8(controller,api)
}),Object.freeze({
  id:'class-construction/1',recordFields:CONSTRUCTION_RECORD_FIELDS,validateRecord:validateConstructionRecordV8,
  applyRecord:applyConstructionRecordV8,stateField:'construction',restoreState:restoreConstructionStateV8,
  reservedIdentities:constructionReservedIdentitiesV8,hasRichState:hasConstructionStateV8,
  assertNext:assertConstructionNextV8,assertCall:assertConstructionCallV8,hasSourceCallable:hasConstructionSourceCallableV8
}),Object.freeze({
  id:ITERATOR_PROFILE_V8,recordFields:ITERATOR_RECORD_FIELDS,validateRecord:validateIteratorRecordV8,
  applyRecord:applyIteratorRecordV8,hasRichState:hasIteratorStateV8,
  restoreState:(controller,_snapshot,api)=>restoreIteratorStateV8(controller,api)
}),Object.freeze({
  id:PROMISE_JOIN_PROFILE_V8,recordFields:PROMISE_JOIN_RECORD_FIELDS,
  validateRecord:record=>validatePromiseJoinRecordV8(record),applyRecord:applyPromiseJoinRecordV8,
  assertNext:assertPromiseJoinNextV8,hasRichState:node=>node.kind==='promise',
  allowsInternalScheduler:allowsPromiseJoinInternalSchedulerV8,allowsWithoutStack:allowsPromiseJoinWithoutStackV8,
  allowsDetailedCall:allowsPromiseJoinDetailedCallV8,
  restoreState:(controller,_snapshot,api)=>restorePromiseJoinStateV8(controller,api)
}),Object.freeze({
  id:'number-conversion/1',recordFields:NUMBER_RECORD_FIELDS,validateRecord:validateNumberRecordV8,
  applyRecord:applyNumberRecordV8,stateField:'numberConversions',restoreState:restoreNumberStateV8,assertNext:assertNumberNextV8
}),Object.freeze({
  id:GENERATOR_PROFILE_V8,recordFields:GENERATOR_RECORD_FIELDS,validateRecord:validateGeneratorRecordV8,
  applyRecord:applyGeneratorRecordV8,hasRichState:hasGeneratorStateV8,ordinaryHeapKinds:['generator'],
  intrinsicPrototypes:GENERATOR_INTRINSICS_V8,resolveIntrinsicProperty:resolveGeneratorIntrinsicV8,
  assertNext:assertGeneratorNextV8,assertCall:assertGeneratorCallV8,
  restoreState:(controller,_snapshot,api)=>restoreGeneratorStateV8(controller,api)
})]);
