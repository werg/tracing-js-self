import {writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
if(!process.env.TRACING_JS_SELF_ROOT||!process.env.V8_DATASET_CAPTURE)throw new Error('TRACING_JS_SELF_ROOT and V8_DATASET_CAPTURE are required');
const adapter=await import(pathToFileURL(join(resolve(process.env.TRACING_JS_SELF_ROOT),'tools/semantic-v8-native-adapter.mjs')));
export const nativePolicy=adapter.nativePolicy;
export const close=adapter.close;
let sequence=0;
export async function nativeConsumer(artifact){
  const id=String(++sequence).padStart(3,'0'),bytes=JSON.stringify(artifact)+'\n',sha256=createHash('sha256').update(bytes).digest('hex'),directory=resolve(process.env.V8_DATASET_CAPTURE);
  writeFileSync(join(directory,id+'.json'),bytes,{flag:'wx'});
  const receipt=await adapter.nativeConsumer(artifact);
  if(receipt.sourceVerification.artifactSha256!==sha256)throw new Error('Exact native input hash differs');
  writeFileSync(join(directory,id+'.receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  appendFileSync(join(directory,'bindings.jsonl'),JSON.stringify({id,sha256,datasetBindingDigest:receipt.datasetBindingDigest,sourceId:artifact.sidecar.splitIdentity.sourceId})+'\n');
  return receipt;
}
