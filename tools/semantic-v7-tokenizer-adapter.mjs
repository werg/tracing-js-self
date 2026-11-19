// Production causal-LM export uses the exact same Ling byte codec as native v7.
import {createAlgorithmTokenizer} from '../src/semantic/tokenizer.js';
import {loadV7NativePolicy} from '../src/semantic/native-v7.js';

const consumerRoot=process.env.MEGATOKEN_ROOT,tokenizerJson=process.env.MEGATOKEN_TOKENIZER_JSON;
if(!consumerRoot||!tokenizerJson)
  throw new Error('MEGATOKEN_ROOT and MEGATOKEN_TOKENIZER_JSON must identify the pinned consumer and tokenizer');
const native=loadV7NativePolicy(process.env.SEMANTIC_V7_NATIVE_POLICY);
const policy=Object.fromEntries(['consumerRevision','tokenizerIdentity','tokenizerSha256']
  .map(key=>[key,native[key]]));
const meter=await createAlgorithmTokenizer({python:process.env.MEGATOKEN_PYTHON??'python3',
  consumerRoot,tokenizerJson,policy});
export const tokenizerEvidence={identity:meter.identity,qualification:meter.qualification};
export const tokenizer={identity:meter.identity.fingerprint,encode:text=>meter.encode(text),
  decode:ids=>meter.decode(ids),close:()=>meter.close()};
// Ling's pinned im_end token. The pinned tokenizer file and byte round trips are checked above.
export const eosTokenId=156892;
