// Explicit public V8 entry. Export implementations directly: importing the
// aggregate index would also initialize its historical wire clients.
// Source checking, native admission and learned success remain separate gates.
export {DETAIL_RECORD_MAX_BYTES_V8,encodeDetailedRecord,decodeDetailedRecord} from './detail-v8.js';
export {SemanticControllerV8} from './controller-v8.js';
export {SelectedExecutionLifecycleV8,V8_LIFECYCLE_CONTRACT} from './lifecycle-v8.js';
export {compileSourceWitnessV8,verifySourceProjectionV8} from './source-compiler-v8.js';
export {verifySourceTrainingCaseV8,recheckSourceAdmissionV8,SOURCE_ADMISSION_CONTRACT_V8} from './source-admission-v8.js';

export {ALGORITHM_V8_SCHEMA,ALGORITHM_V8_PROFILE,ALGORITHM_V8_LIMITS,ALGORITHM_V8_OPERATION_METADATA,
  validateAlgorithmV8,validateTermV8,evaluateAlgorithmV8,evaluateTermV8,checkAlgorithmV8Claims} from './algorithm-v8.js';
export {lowerJavaScriptV8,tryLowerJavaScriptV8} from './lower-v8.js';
export {renderAlgorithmV8,renderAlgorithmV8Term,renderAlgorithmV8Record} from './render-v8.js';
export {REGION_PROGRAM_VERSION,REGION_EXECUTION_VERSION,REGION_TRACE_VERSION,REGION_CONTEXT_VERSION,
  REGION_CONTINUATION_VERSION,REGION_PROFILE,defineRegionProgram,validateRegionProgram,
  analyzeRegionEffects,sharedRegionState,cloneRegionController,regionEntry,evaluateLocalRegion,encodeRegionRecord,decodeRegionRecord} from './regions.js';
export {RegionExecutionHarness} from './region-harness.js';
export {encodePureRegionRecord,decodePureRegionRecord} from './pure-region-v8.js';
export {verifyRegionTrainingCase,projectRegionWitness,recheckRegionEvidence,admitRegionEvidence,checkRegionCounterfactualPrefixes} from './compiler-v8.js';
export {CAUSAL_LM_V8_BRIDGE_VERSION,validateRegionContext,decodeCausalLmV8Target,causalLmV8Prompt,
  encodeCausalLmV8Example,validateRegionTrainingContexts,buildCausalLmV8Examples,createCausalLmV8Selector,
  commitCausalLmV8Selection,auditRegionServingCosts} from './causal-lm-v8.js';
export {createNativeV8ProcessSelector,createNativeV8PythonSelector} from './native-process-v8.js';
export {RegionSelectedModelDriver,runSelectedRegionExecution} from './selected-execution-v8.js';
export {prepareRegionExecutionCase,freezeRegionExecutionStudy,validateRegionExecutionStudy,
  scoreSelectedRegionExecution,runFrozenRegionExecutionStudy} from './execution-study-v8.js';
export {V8_CONTRACT_DIGEST,V8_FIXTURE_DIGEST,V8_INTEROPERABILITY_DIGEST,V8_NATIVE_CHECKS,validateV8NativePolicy,
  loadV8NativePolicy,validateV8NativeReceipt} from './native-v8.js';
export {SEMANTIC_V8_DEFINITION,semanticV8Contract} from './contract-v8.js';
export {buildRegionFamilyRegistry,verifyRegionFamilyRegistry,regionSplitIdentity,verifyRegionSplitIdentity,
  verifyRegionDatasetBinding,validateRegionFamilyAssignments} from './family-registry-v8.js';
export {regionFamilyMembership,prepareRegionFamilyRegistry,resolveRegionFamilyRegistry,bindRegionFamilySplit,
  buildRegionDataset,exportRegionDatasetJSONL} from './dataset-v8.js';
export {MODULE_REGION_PROFILE,independentModuleRegionReference,verifyRegionModuleTrainingCase,
  recheckModuleRegionEvidence} from './module-v8.js';
export {OPERATION_METADATA,OPERATION_METADATA_VERSION,operationMetadata} from './operation-metadata.js';

export {PROTOCOL_RECORD_V8_SCHEMA,PROTOCOL_RECORD_V8_FIELDS,encodeProtocolRecordV8,decodeProtocolRecordV8,
  validateProtocolRecordV8,validateProtocolValueV8,validateProtocolKeyV8,validateProtocolDescriptorV8} from './protocol-codec-v8.js';
export {PROTOCOL_STATE_V8_SCHEMA,PROTOCOL_STATE_V8_FIELDS,PROTOCOL_V8_LIMITS,createProtocolStateV8,
  applyProtocolRecordV8,snapshotProtocolStateV8,restoreProtocolStateV8,protocolReservedIdentitiesV8,
  assertProtocolDetailCompatible,protocolOrdinaryHeapViewV8} from './protocol-state-v8.js';
export {PROTOCOL_SOURCE_ARTIFACT_V8_SCHEMA,PROTOCOL_REGION_EVIDENCE_V8_SCHEMA,
  verifyProtocolRegionTrainingCase,projectProtocolRegionWitness,recheckProtocolRegionEvidence} from './protocol-source-v8.js';
export {MEMORY_PROFILE_V8,MEMORY_RECORD_FIELDS,MEMORY_HEAP_FIELDS_V8} from './protocol-memory-v8.js';
export {ITERATOR_PROFILE_V8,ITERATOR_RECORD_FIELDS,ITERATOR_HEAP_FIELDS} from './protocol-iterator-v8.js';
export {CONSTRUCTION_STATE_V8_SCHEMA,CONSTRUCTION_RECORD_FIELDS,CONSTRUCTION_STATE_V8_FIELDS,
  CALLABLE_STATE_V8_FIELDS,CONSTRUCTION_FRAME_V8_FIELDS} from './protocol-construction-v8.js';
export {CONSTRUCTION_SOURCE_PROFILE_V8} from './protocol-construction-source-v8.js';
export {NUMBER_STATE_V8_SCHEMA,NUMBER_RECORD_FIELDS,NUMBER_OPERATION_FIELDS} from './protocol-number-v8.js';
export {NUMBER_SOURCE_PROFILE_V8} from './protocol-number-source-v8.js';
export {GENERATOR_PROFILE_V8,GENERATOR_RECORD_FIELDS,GENERATOR_HEAP_FIELDS} from './protocol-generator-v8.js';
export {GENERATOR_SOURCE_PROFILE_V8} from './protocol-generator-source-v8.js';
export {PROMISE_JOIN_PROFILE_V8,PROMISE_JOIN_STATE_V8,PROMISE_JOIN_RECORD_FIELDS} from './protocol-promise-join-v8.js';
export {PROMISE_EXECUTOR_PROFILE_V8,PROMISE_EXECUTOR_STATE_V8,PROMISE_EXECUTOR_RECORD_FIELDS} from './protocol-promise-executor-v8.js';
export {PROXY_PROFILE_V8,PROXY_STATE_V8_SCHEMA,PROXY_RECORD_FIELDS,PROXY_HEAP_FIELDS} from './protocol-proxy-v8.js';
export {PROXY_SOURCE_PROFILE_V8} from './protocol-proxy-source-v8.js';
export {ARRAY_MAP_SOURCE_PROFILE_V8} from './protocol-array-map-source-v8.js';
