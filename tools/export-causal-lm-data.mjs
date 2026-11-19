#!/usr/bin/env node
// Fresh source certification and exact tokenizer masks for the conventional arm.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {buildCausalLmExamples,CAUSAL_LM_BRIDGE_VERSION} from '../src/training/causal-lm-bridge.js';

const args=new Map();
for(let i=2;i<process.argv.length;i+=2){
  const key=process.argv[i],value=process.argv[i+1];
  if(!['--episode','--tokenizer-module','--max-context','--out'].includes(key)||args.has(key)||!value)
    throw new TypeError('Usage: export-causal-lm-data.mjs --episode FILE --tokenizer-module FILE --max-context N --out NEW_DIRECTORY');
  args.set(key,value);
}
for(const name of ['--episode','--tokenizer-module','--max-context','--out'])
  if(!args.has(name))throw new TypeError('Missing '+name);
const raw=readFileSync(resolve(args.get('--episode'))),exported=JSON.parse(raw);
const modulePath=resolve(args.get('--tokenizer-module'));
const {tokenizer,eosTokenId}=await import(pathToFileURL(modulePath));
const examples=await buildCausalLmExamples(exported,{tokenizer,eosTokenId,
  maxContextTokens:Number(args.get('--max-context'))});
const sha=value=>createHash('sha256').update(value).digest('hex');
const payload=examples.map(row=>JSON.stringify(row)).join('\n')+'\n';
const manifest={schema:CAUSAL_LM_BRIDGE_VERSION,traceFormat:'semantic-trace/6',
  inputSha256:sha(raw),tokenizerModuleSha256:sha(readFileSync(modulePath)),
  tokenizerIdentity:tokenizer.identity,eosTokenId,encoding:'independent-prefix-and-target-segments',
  examples:examples.length,generatedTokens:examples.reduce((n,row)=>n+row.boundaries.targetTokens,0),
  terminalTokens:examples.length,promptTokens:examples.reduce((n,row)=>n+row.boundaries.promptTokens,0),
  maxFlatContextTokens:Math.max(...examples.map(row=>row.costs.flatContextTokens)),
  dataset:{file:'examples.jsonl',sha256:sha(payload)},identityDigest:exported.sidecar.identityDigest,
  splitIdentity:exported.sidecar.splitIdentity,scope:'conventional-causal-lm-diagnostic',
  nativeAdmissionClaim:false,optimizerSteps:0,learnedSuccess:null};
const output=resolve(args.get('--out'));mkdirSync(output);
writeFileSync(resolve(output,'examples.jsonl'),payload,{flag:'wx'});
writeFileSync(resolve(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({output,examples:examples.length,tokenizerIdentity:tokenizer.identity,
  nativeAdmissionClaim:false,optimizerSteps:0})+'\n');
