// Candidate algorithm API. Production admission remains gated independently
// from the deterministic JavaScript implementation and its source evidence.
export {ALGORITHM_VERSION,ALGORITHM_PROFILE,ALGORITHM_LIMITS,ALGORITHM_INPUT_TYPES,
  validateAlgorithm,validateTerm,canonicalAlgorithmString,algorithmDigest} from './ir.js';
export {OPERATION_REGISTRY,evaluateTerm,evaluateAlgorithm,checkAlgorithmClaim,checkAlgorithmClaims,
  validateAlgorithmInputs,encodeAlgorithmScalar,decodeAlgorithmScalar} from './operations.js';
export {normalizeAlgorithm} from './normalize-algorithm.js';
export {lowerJavaScript,tryLowerJavaScript,AlgorithmLoweringError} from './lower-js.js';
export {lowerEffectfulJavaScript,SERIAL_EFFECT_PROFILE} from './lower-effects.js';
export {OBSERVATION_CONTRACT_VERSION,canonicalObservableGraph,compareObservableGraphs,
  canonicalObservables,compareObservables} from './observables.js';
export {createTransformationReceipt,verifyTransformationReceipt,validateTransformationReceipt} from './provenance.js';
export {ALGORITHM_TRACE_VERSION,encodeAlgorithmRecord,decodeAlgorithmRecord,validateAlgorithmRecord,
  encodeAlgorithmTerm,encodeAlgorithmValue,algorithmTraceGrammar} from './trace-codec.js';
export {renderAlgorithm,renderAlgorithmRecord,renderAlgorithmTerm} from './render-algorithm.js';
export {ALGORITHM_EXECUTION_VERSION,ALGORITHM_CONTEXT_VERSION,ALGORITHM_CONTINUATION_VERSION,
  defineAlgorithmProgram,validateAlgorithmProgram} from './program.js';
export {AlgorithmController,validateAlgorithmTrace} from './controller.js';
export {AlgorithmExecutionHarness} from './harness.js';
export {compileAlgorithmWitness,verifyAlgorithmProjection,verifyAlgorithmTrainingCase,
  recheckAlgorithmEvidence,admitAlgorithmEvidence,checkAlgorithmCounterfactualPrefixes} from './compiler.js';
export {encodeDetailedRecord,decodeDetailedRecord,projectDetailedV7,verifyDetailedProjection,
  validateDetailedProjection,detailedContextForSequence,DETAILED_PROFILE} from './detailed-v7.js';
export {buildSemanticFamilyRegistry,verifySemanticFamilyRegistry,semanticSplitIdentity,
  verifySemanticSplitIdentity,validateSemanticFamilyAssignments} from './family-registry.js';
export {causalLmV7Prompt,createAlgorithmContextResolver,encodeCausalLmV7Example,buildCausalLmV7Examples,
  createCausalLmV7Selector,CAUSAL_LM_V7_BRIDGE_VERSION} from './causal-lm-v7.js';
export {prepareSemanticFamilyRegistry,bindSemanticFamilySplit,buildSemanticV7Dataset} from './dataset-v7.js';
export {loadV7NativePolicy,validateV7NativePolicy,validateV7NativeReceipt} from './native-v7.js';
export {auditAlgorithmCosts,compareSemanticRepresentations} from './evaluation.js';
export {createAlgorithmTokenizer,validateAlgorithmTokenizerEvidence} from './tokenizer.js';
export {publicComprehensionTasks,scoreComprehensionResponses,validateComprehensionTaskset,
  comprehensionTasksetDigest} from './comprehension.js';
// Explicit v8 candidate; historical v7 admission and production defaults retain
// their original identities until the coordinated promotion gates pass.
export {ALGORITHM_V8_SCHEMA,ALGORITHM_V8_PROFILE,ALGORITHM_V8_LIMITS,ALGORITHM_V8_OPERATION_METADATA,
  validateAlgorithmV8,validateTermV8,evaluateAlgorithmV8,evaluateTermV8,checkAlgorithmV8Claims} from './algorithm-v8.js';
export {lowerJavaScriptV8,tryLowerJavaScriptV8} from './lower-v8.js';
export {renderAlgorithmV8,renderAlgorithmV8Term,renderAlgorithmV8Record} from './render-v8.js';
export {REGION_PROGRAM_VERSION,REGION_EXECUTION_VERSION,REGION_TRACE_VERSION,REGION_CONTEXT_VERSION,
  REGION_CONTINUATION_VERSION,REGION_PROFILE,defineRegionProgram,validateRegionProgram,
  analyzeRegionEffects,sharedRegionState,regionEntry,evaluateLocalRegion,encodeRegionRecord,decodeRegionRecord} from './regions.js';
export {RegionExecutionHarness} from './region-harness.js';
export {encodePureRegionRecord,decodePureRegionRecord} from './pure-region-v8.js';
export {verifyRegionTrainingCase,projectRegionWitness,recheckRegionEvidence,admitRegionEvidence,checkRegionCounterfactualPrefixes} from './compiler-v8.js';
export {CAUSAL_LM_V8_BRIDGE_VERSION,validateRegionContext,decodeCausalLmV8Target,causalLmV8Prompt,
  encodeCausalLmV8Example,validateRegionTrainingContexts,buildCausalLmV8Examples,createCausalLmV8Selector,
  auditRegionServingCosts} from './causal-lm-v8.js';
export {V8_CONTRACT_DIGEST,V8_FIXTURE_DIGEST,V8_NATIVE_CHECKS,validateV8NativePolicy,
  loadV8NativePolicy,validateV8NativeReceipt} from './native-v8.js';
export {SEMANTIC_V8_DEFINITION,semanticV8Contract} from './contract-v8.js';
export {buildRegionFamilyRegistry,verifyRegionFamilyRegistry,regionSplitIdentity,verifyRegionSplitIdentity,
  verifyRegionDatasetBinding,validateRegionFamilyAssignments} from './family-registry-v8.js';
export {regionFamilyMembership,prepareRegionFamilyRegistry,resolveRegionFamilyRegistry,bindRegionFamilySplit,
  buildRegionDataset,exportRegionDatasetJSONL} from './dataset-v8.js';
export {MODULE_REGION_PROFILE,independentModuleRegionReference,verifyRegionModuleTrainingCase,
  recheckModuleRegionEvidence} from './module-v8.js';
export {OPERATION_METADATA,OPERATION_METADATA_VERSION,operationMetadata} from './operation-metadata.js';
export {auditFlatServingCosts} from './serving-costs.js';
