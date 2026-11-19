// This qualifies only exact text metering. The native release gate is separate.
import {readFileSync} from 'node:fs';
import {createAlgorithmTokenizer} from '../src/semantic/tokenizer.js';
import {loadV8NativePolicy} from '../src/semantic/native-v8.js';

const consumerRoot=process.env.MEGATOKEN_ROOT,tokenizerJson=process.env.MEGATOKEN_TOKENIZER_JSON;
if(!consumerRoot||!tokenizerJson)throw new Error('MEGATOKEN_ROOT and MEGATOKEN_TOKENIZER_JSON are required');
const pins=process.env.SEMANTIC_V8_TOKENIZER_POLICY?
  JSON.parse(readFileSync(process.env.SEMANTIC_V8_TOKENIZER_POLICY,'utf8')):
  loadV8NativePolicy(process.env.SEMANTIC_V8_NATIVE_POLICY);
const policy=Object.fromEntries(['consumerRevision','tokenizerIdentity','tokenizerSha256'].map(key=>[key,pins[key]]));
const meter=await createAlgorithmTokenizer({python:process.env.MEGATOKEN_PYTHON??'python3',consumerRoot,tokenizerJson,policy});
export const tokenizerEvidence={identity:meter.identity,qualification:meter.qualification};
export const tokenizer={identity:meter.identity.fingerprint,encode:text=>meter.encode(text),
  decode:ids=>meter.decode(ids),close:()=>meter.close()};
export const eosTokenId=156892;
