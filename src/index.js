// Public embedding API. Importing this module does not start a guest run.
// Language and host coverage remain those of the declared runtime profile.
export { Runtime, createRuntime } from './runtime.js';
export { encode, decode } from './values.js';
export { validateBundle, reconstruct, TraceValidationError } from './validation.js';
export { replayExact, TraceReplayError } from './replay.js';
export { causalPrefix } from './causal.js';
export {executeWithNativeServices} from './host/native-driver.js';
export {compileExternalEffectsJS} from './effect-javascript.js';
