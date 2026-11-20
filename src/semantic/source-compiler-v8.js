// V8's direct owned-journal client. The shared projector produces typed claims;
// only this V8 codec and lifecycle may turn them into public records or replay.
import {compileSourceProjection,verifySourceProjection} from './source-projection.js';
import {SelectedExecutionLifecycleV8} from './lifecycle-v8.js';
import {encodeDetailedRecord,decodeDetailedRecord} from './detail-v8.js';

export const SOURCE_PROJECTION_CLIENT_V8=Object.freeze({
  schema:'semantic-source-projection-client/1',compilerSchema:'semantic-source-compiler/8',
  createHarness:options=>new SelectedExecutionLifecycleV8(options),
  restore:packet=>SelectedExecutionLifecycleV8.restore(packet),
  replay:artifact=>SelectedExecutionLifecycleV8.replay(artifact),
  encodeRecord:(kind,fields)=>encodeDetailedRecord({kind,fields}),
  decodeRecord:decodeDetailedRecord
});

function optionsForV8(options){
  if(options.semanticRegions!==undefined&&options.semanticRegions!==false)
    throw new TypeError('V8 compact regions are certified after direct source detail');
  if(options.regionAdapter!==undefined&&options.regionAdapter!==null)
    throw new TypeError('Protocol source adapters use the separately qualified V8 source gate');
  return {...options,semanticRegions:false,projectionClient:SOURCE_PROJECTION_CLIENT_V8};
}

export function compileSourceWitnessV8(bundle,options={}){
  return compileSourceProjection(bundle,optionsForV8(options));
}
export function verifySourceProjectionV8(bundle,artifact,options={}){
  return verifySourceProjection(bundle,artifact,optionsForV8(options));
}
