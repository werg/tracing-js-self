// Explicit public operation/state extensions. Registration changes the pinned
// contract and requires independent consumer parity before production admission.
import {MEMORY_PROFILE_V8,MEMORY_RECORD_FIELDS,validateMemoryRecordV8,applyMemoryRecordV8,restoreMemoryStateV8} from './protocol-memory-v8.js';
import {isBinaryMemoryKind} from '../binary-memory-validation.js';
import {CONSTRUCTION_RECORD_FIELDS,validateConstructionRecordV8,applyConstructionRecordV8,restoreConstructionStateV8,
  constructionReservedIdentitiesV8,hasConstructionStateV8,assertConstructionNextV8,assertConstructionCallV8,
  constructionCallReceiverV8} from './protocol-construction-v8.js';
import {hasConstructionSourceCallableV8} from './protocol-construction-source-inventory-v8.js';
import {ITERATOR_PROFILE_V8,ITERATOR_RECORD_FIELDS,validateIteratorRecordV8,applyIteratorRecordV8,
  restoreIteratorStateV8,hasIteratorStateV8} from './protocol-iterator-v8.js';
import {ENUMERATION_PROFILE_V8,ENUMERATION_RECORD_FIELDS,validateEnumerationRecordV8,applyEnumerationRecordV8,
  restoreEnumerationStateV8,hasEnumerationStateV8} from './protocol-enumeration-v8.js';
import {PROMISE_JOIN_PROFILE_V8,PROMISE_JOIN_RECORD_FIELDS,validatePromiseJoinRecordV8,
  applyPromiseJoinRecordV8,restorePromiseJoinStateV8,assertPromiseJoinNextV8,
  allowsPromiseJoinInternalSchedulerV8,allowsPromiseJoinWithoutStackV8,allowsPromiseJoinDetailedCallV8} from './protocol-promise-join-v8.js';
import {PRIMITIVE_CONVERSION_PROFILE_V8,PRIMITIVE_CONVERSION_RECORD_FIELDS,validatePrimitiveConversionRecordV8,applyPrimitiveConversionRecordV8,restorePrimitiveConversionStateV8,assertPrimitiveConversionNextV8} from './protocol-primitive-conversion-v8.js';
import {NUMBER_RECORD_FIELDS,validateNumberRecordV8,applyNumberRecordV8,restoreNumberStateV8,assertNumberNextV8} from './protocol-number-v8.js';
import {GENERATOR_PROFILE_V8,GENERATOR_RECORD_FIELDS,GENERATOR_INTRINSICS_V8,validateGeneratorRecordV8,
  applyGeneratorRecordV8,restoreGeneratorStateV8,hasGeneratorStateV8,assertGeneratorCallV8,
  assertGeneratorNextV8,resolveGeneratorIntrinsicV8} from './protocol-generator-v8.js';
import {PROXY_PROFILE_V8,PROXY_RECORD_FIELDS,validateProxyRecordV8,applyProxyRecordV8,restoreProxyStateV8,hasProxyStateV8,assertProxyNextV8} from './protocol-proxy-v8.js';
import {PROMISE_EXECUTOR_PROFILE_V8,PROMISE_EXECUTOR_RECORD_FIELDS,validatePromiseExecutorRecordV8,applyPromiseExecutorRecordV8,
  restorePromiseExecutorStateV8,assertPromiseExecutorNextV8,assertPromiseExecutorCallV8,
  allowsPromiseExecutorInternalSchedulerV8,allowsPromiseExecutorDetailedCallV8} from './protocol-promise-executor-v8.js';
import {MODULE_NAMESPACE_PROFILE_V8,MODULE_NAMESPACE_RECORD_FIELDS,validateModuleNamespaceRecordV8,
  applyModuleNamespaceRecordV8,restoreModuleNamespaceStateV8,assertModuleNamespaceNextV8,
  assertModuleNamespaceTransitionV8} from './protocol-module-namespace-v8.js';
import {ASYNC_CALL_PROFILE_V8,ASYNC_CALL_RECORD_FIELDS,validateAsyncCallRecordV8,applyAsyncCallRecordV8,
  restoreAsyncCallStateV8,assertAsyncCallV8,assertAsyncCallNextV8,
  allowsAsyncCallInternalSchedulerV8,allowsAsyncCallWithoutStackV8} from './protocol-async-call-v8.js';
import {MODULE_SCHEDULER_PROFILE_V8,MODULE_SCHEDULER_RECORD_FIELDS,validateModuleSchedulerRecordV8,applyModuleSchedulerRecordV8,
  validateBoundModuleSchedulerStateV8,assertBoundModuleSchedulerNextV8} from './protocol-module-scheduler-v8.js';
import {PROMISE_ADOPTION_PROFILE_V8,PROMISE_ADOPTION_RECORD_FIELDS,validatePromiseAdoptionRecordV8,applyPromiseAdoptionRecordV8,
  restorePromiseAdoptionStateV8,assertPromiseAdoptionNextV8,allowsPromiseAdoptionInternalSchedulerV8,
  allowsPromiseAdoptionWithoutStackV8} from './protocol-promise-adoption-v8.js';
import {hasAsyncIterationSourceCallableV8} from './async-iteration-source-v8.js';
import {PROMISE_OBJECT_PROFILE_V8,PROMISE_OBJECT_RECORD_FIELDS,validatePromiseObjectRecordV8,
  applyPromiseObjectRecordV8,restorePromiseObjectStateV8} from './protocol-promise-object-v8.js';
import {INTRINSIC_ERROR_PROFILE_V8,INTRINSIC_ERROR_RECORD_FIELDS,validateIntrinsicErrorRecordV8,
  applyIntrinsicErrorRecordV8,restoreIntrinsicErrorStateV8} from './protocol-intrinsic-error-v8.js';
export const PROTOCOL_MACHINE_ADAPTERS_V8=Object.freeze([Object.freeze({
  id:PROMISE_OBJECT_PROFILE_V8,recordFields:PROMISE_OBJECT_RECORD_FIELDS,
  validateRecord:validatePromiseObjectRecordV8,applyRecord:applyPromiseObjectRecordV8,
  stateField:'promiseObjects',ordinaryHeapKinds:['promise'],
  hasRichState:node=>node.kind==='intrinsic',restoreState:restorePromiseObjectStateV8
}),Object.freeze({
  id:INTRINSIC_ERROR_PROFILE_V8,recordFields:INTRINSIC_ERROR_RECORD_FIELDS,
  validateRecord:validateIntrinsicErrorRecordV8,applyRecord:applyIntrinsicErrorRecordV8,
  restoreState:restoreIntrinsicErrorStateV8
}),Object.freeze({
  id:MODULE_SCHEDULER_PROFILE_V8,recordFields:MODULE_SCHEDULER_RECORD_FIELDS,
  validateRecord:validateModuleSchedulerRecordV8,applyRecord:applyModuleSchedulerRecordV8,
  restoreState:controller=>validateBoundModuleSchedulerStateV8(controller),
  assertNext:assertBoundModuleSchedulerNextV8,hasRichState:node=>node.kind==='module-scheduler',
  allowsInternalScheduler:controller=>Boolean(controller.moduleSchedulerPlan)
}),Object.freeze({
  id:ASYNC_CALL_PROFILE_V8,recordFields:ASYNC_CALL_RECORD_FIELDS,validateRecord:validateAsyncCallRecordV8,
  applyRecord:applyAsyncCallRecordV8,restoreState:(controller,_snapshot,api)=>restoreAsyncCallStateV8(controller,api),
  assertNext:assertAsyncCallNextV8,assertCall:assertAsyncCallV8,
  hasSourceCallable:hasAsyncIterationSourceCallableV8,
  hasRichState:node=>node.asyncFunction!==undefined||node.asyncCall!==undefined,
  allowsInternalScheduler:allowsAsyncCallInternalSchedulerV8,allowsWithoutStack:allowsAsyncCallWithoutStackV8
}),Object.freeze({
  id:MODULE_NAMESPACE_PROFILE_V8,recordFields:MODULE_NAMESPACE_RECORD_FIELDS,
  validateRecord:validateModuleNamespaceRecordV8,applyRecord:applyModuleNamespaceRecordV8,
  hasRichState:node=>node.kind==='module-namespace',restoreState:restoreModuleNamespaceStateV8,
  assertNext:assertModuleNamespaceNextV8,assertTransition:assertModuleNamespaceTransitionV8
}),Object.freeze({
  id:MEMORY_PROFILE_V8,recordFields:MEMORY_RECORD_FIELDS,validateRecord:validateMemoryRecordV8,applyRecord:applyMemoryRecordV8,
  hasRichState:node=>isBinaryMemoryKind(node.kind),
  restoreState:(controller,_snapshot,api)=>restoreMemoryStateV8(controller,api)
}),Object.freeze({
  id:'class-construction/1',recordFields:CONSTRUCTION_RECORD_FIELDS,validateRecord:validateConstructionRecordV8,
  applyRecord:applyConstructionRecordV8,stateField:'construction',restoreState:restoreConstructionStateV8,
  reservedIdentities:constructionReservedIdentitiesV8,hasRichState:hasConstructionStateV8,
  assertNext:assertConstructionNextV8,assertCall:assertConstructionCallV8,callReceiver:constructionCallReceiverV8,
  hasSourceCallable:hasConstructionSourceCallableV8
}),Object.freeze({
  id:ITERATOR_PROFILE_V8,recordFields:ITERATOR_RECORD_FIELDS,validateRecord:validateIteratorRecordV8,
  applyRecord:applyIteratorRecordV8,hasRichState:hasIteratorStateV8,
  restoreState:(controller,_snapshot,api)=>restoreIteratorStateV8(controller,api)
}),Object.freeze({
  id:ENUMERATION_PROFILE_V8,recordFields:ENUMERATION_RECORD_FIELDS,validateRecord:validateEnumerationRecordV8,
  applyRecord:applyEnumerationRecordV8,hasRichState:hasEnumerationStateV8,
  restoreState:(controller,_snapshot,api)=>restoreEnumerationStateV8(controller,api)
}),Object.freeze({
  id:PROMISE_JOIN_PROFILE_V8,recordFields:PROMISE_JOIN_RECORD_FIELDS,
  validateRecord:record=>validatePromiseJoinRecordV8(record),applyRecord:applyPromiseJoinRecordV8,
  assertNext:assertPromiseJoinNextV8,hasRichState:node=>node.kind==='promise',
  allowsInternalScheduler:allowsPromiseJoinInternalSchedulerV8,allowsWithoutStack:allowsPromiseJoinWithoutStackV8,
  allowsDetailedCall:allowsPromiseJoinDetailedCallV8,
  restoreState:(controller,_snapshot,api)=>restorePromiseJoinStateV8(controller,api)
}),Object.freeze({
  id:PRIMITIVE_CONVERSION_PROFILE_V8,recordFields:PRIMITIVE_CONVERSION_RECORD_FIELDS,validateRecord:validatePrimitiveConversionRecordV8,
  applyRecord:applyPrimitiveConversionRecordV8,stateField:'primitiveConversions',restoreState:restorePrimitiveConversionStateV8,assertNext:assertPrimitiveConversionNextV8
}),Object.freeze({
  id:'number-conversion/1',recordFields:NUMBER_RECORD_FIELDS,validateRecord:validateNumberRecordV8,
  applyRecord:applyNumberRecordV8,stateField:'numberConversions',restoreState:restoreNumberStateV8,assertNext:assertNumberNextV8
}),Object.freeze({
  id:GENERATOR_PROFILE_V8,recordFields:GENERATOR_RECORD_FIELDS,validateRecord:validateGeneratorRecordV8,
  applyRecord:applyGeneratorRecordV8,hasRichState:hasGeneratorStateV8,ordinaryHeapKinds:['generator'],
  intrinsicPrototypes:GENERATOR_INTRINSICS_V8,resolveIntrinsicProperty:resolveGeneratorIntrinsicV8,
  assertNext:assertGeneratorNextV8,assertCall:assertGeneratorCallV8,
  restoreState:(controller,_snapshot,api)=>restoreGeneratorStateV8(controller,api)
}),Object.freeze({
  id:PROXY_PROFILE_V8,recordFields:PROXY_RECORD_FIELDS,validateRecord:validateProxyRecordV8,
  applyRecord:applyProxyRecordV8,hasRichState:hasProxyStateV8,stateField:'proxyCalls',
  restoreState:restoreProxyStateV8,assertNext:assertProxyNextV8
}),Object.freeze({
  id:PROMISE_EXECUTOR_PROFILE_V8,recordFields:PROMISE_EXECUTOR_RECORD_FIELDS,validateRecord:validatePromiseExecutorRecordV8,
  applyRecord:applyPromiseExecutorRecordV8,stateField:'promiseExecutors',restoreState:restorePromiseExecutorStateV8,
  assertNext:assertPromiseExecutorNextV8,assertCall:assertPromiseExecutorCallV8,
  hasRichState:node=>node.promiseResolver!==undefined,
  allowsInternalScheduler:allowsPromiseExecutorInternalSchedulerV8,allowsDetailedCall:allowsPromiseExecutorDetailedCallV8
}),Object.freeze({
  id:PROMISE_ADOPTION_PROFILE_V8,recordFields:PROMISE_ADOPTION_RECORD_FIELDS,validateRecord:validatePromiseAdoptionRecordV8,
  applyRecord:applyPromiseAdoptionRecordV8,restoreState:(controller,_snapshot,api)=>restorePromiseAdoptionStateV8(controller,api),
  assertNext:assertPromiseAdoptionNextV8,hasRichState:node=>node.adoption!==undefined,
  allowsInternalScheduler:allowsPromiseAdoptionInternalSchedulerV8,allowsWithoutStack:allowsPromiseAdoptionWithoutStackV8
})]);
