// Independent descriptor/metadata observers only. Registered modules must not
// import the owned runtime, source compiler, or public protocol evaluator.
export const PROTOCOL_METADATA_ADAPTERS_V8=Object.freeze([]);
import {createMemoryObservationAdapterV8} from './protocol-memory-observation-v8.js';
import {createConstructionObservationAdapterV8} from './protocol-construction-observations-v8.js';
import {createIteratorObservationAdapterV8} from './protocol-iterator-observations-v8.js';
import {createPromiseObservationAdapterV8} from './protocol-promise-observations-v8.js';
export const PROTOCOL_OBSERVATION_ADAPTERS_V8=Object.freeze([createMemoryObservationAdapterV8,createConstructionObservationAdapterV8,createIteratorObservationAdapterV8,createPromiseObservationAdapterV8]);
