// Production dataset export uses the same live source/native authority as the
// qualification runner. Temporary transport files never enter the producer tree.
import {randomUUID} from 'node:crypto';
import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadNativeV8Settings,createNativeV8Consumer} from '../src/corpus/native-admission-v8.mjs';

const temporaryDirectory=join(process.env.SEMANTIC_NATIVE_TEMP??tmpdir(),'semantic-v8-native-'+randomUUID());
const settings=loadNativeV8Settings({
  megatoken:process.env.MEGATOKEN_ROOT,
  tokenizer:process.env.MEGATOKEN_TOKENIZER_JSON,
  python:process.env.MEGATOKEN_PYTHON??'python3',
  policyFile:process.env.SEMANTIC_V8_NATIVE_POLICY??fileURLToPath(new URL('../contracts/semantic-native-policy-v8.json',import.meta.url)),
  temporaryDirectory
});

export const nativePolicy=settings.policy;
export const nativeConsumer=createNativeV8Consumer(settings);
export const close=()=>rmSync(temporaryDirectory,{recursive:true,force:true});
