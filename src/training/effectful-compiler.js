// Historical witness client for the shared typed owned-source projector. The
// projector has no dependency on this codec or selected-harness implementation.
import {SelectedExecutionHarness} from './harness-v4.js';
import {encodeWitness,decodeWitness} from './format.js';
import {compileSourceProjection,verifySourceProjection} from '../semantic/source-projection.js';
export {ownedEffectfulOutcome} from '../semantic/source-projection.js';
const client=Object.freeze({schema:'semantic-source-projection-client/1',
  compilerSchema:'semantic-effectful-compiler/5',
  createHarness:options=>new SelectedExecutionHarness(options),
  restore:packet=>SelectedExecutionHarness.restore(packet),
  replay:artifact=>SelectedExecutionHarness.replay(artifact),
  encodeRecord:encodeWitness,decodeRecord:decodeWitness});
export const compileEffectfulWitness=(bundle,options={})=>
  compileSourceProjection(bundle,{...options,projectionClient:client});
export const verifyEffectfulProjection=(bundle,artifact,options={})=>
  verifySourceProjection(bundle,artifact,{...options,projectionClient:client});
