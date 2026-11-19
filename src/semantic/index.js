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
  recheckAlgorithmEvidence,checkAlgorithmCounterfactualPrefixes} from './compiler.js';
export {auditAlgorithmCosts,compareSemanticRepresentations} from './evaluation.js';
export {createAlgorithmTokenizer,validateAlgorithmTokenizerEvidence} from './tokenizer.js';
export {publicComprehensionTasks,scoreComprehensionResponses,validateComprehensionTaskset,
  comprehensionTasksetDigest} from './comprehension.js';
