#!/usr/bin/env node
// Model calls receive only public prefix token IDs; expectations are compared
// outside generation using the unchanged selected execution scorer/contract.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createCausalLmSelector,CAUSAL_LM_BRIDGE_VERSION} from '../src/training/causal-lm-bridge.js';
import {recheckEffectfulAdmission} from '../src/training/effectful-admit.js';
import {controlledEvaluationCase,evaluateSelectedCase} from '../src/training/selected-evaluation.js';

const args=new Map();
const keys=['--episode','--adapter','--checkpoint','--origin','--arm','--max-context',
  '--max-new-tokens','--timeout-ms','--seed','--out'];
for(let i=2;i<process.argv.length;i+=2){
  const key=process.argv[i],value=process.argv[i+1];
  if(!keys.includes(key)||args.has(key)||!value)throw new TypeError('Unknown, duplicate or missing argument: '+key);
  args.set(key,value);
}
for(const key of keys)if(!args.has(key))throw new TypeError('Missing '+key);
if(existsSync(resolve(args.get('--out'))))throw new TypeError('Evaluation output already exists');
if(!['fixed-weights','trained'].includes(args.get('--origin')))throw new TypeError('Only actual model evaluation origins are supported');
const timeoutMs=Number(args.get('--timeout-ms'));
if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>3600000)throw new TypeError('Use an explicit bounded evaluation deadline');
const raw=readFileSync(resolve(args.get('--episode'))),exported=JSON.parse(raw);
const admission=await recheckEffectfulAdmission(exported,{requireAdmitted:false});
const frozen=controlledEvaluationCase(exported,{id:exported.sidecar.taskId});
delete frozen.request.controlledSelectionsByRepresentation;
const path=resolve(args.get('--adapter')),{runtime,tokenizer,eosTokenId,modelDeclaration}=await import(pathToFileURL(path));
if(!modelDeclaration||typeof modelDeclaration.repository!=='string'||!modelDeclaration.repository||
  !/^[0-9a-f]{40}$/.test(modelDeclaration.revision??'')||
  typeof modelDeclaration.license!=='string'||!modelDeclaration.license||
  modelDeclaration.checkpointIdentity!==args.get('--checkpoint'))
  throw new TypeError('Adapter needs a frozen model repository/revision, license and exact checkpoint declaration');
const select=createCausalLmSelector({runtime,tokenizer,eosTokenId,
  checkpointIdentity:args.get('--checkpoint'),arm:args.get('--arm'),
  maxContextTokens:Number(args.get('--max-context')),maxNewTokens:Number(args.get('--max-new-tokens'))});
let result;
try{
  result=await evaluateSelectedCase({schema:'semantic-evaluation-request/4',caseId:frozen.id,
    seed:Number(args.get('--seed')),representation:'compact',request:frozen.request},
    {origin:args.get('--origin'),checkpointIdentity:args.get('--checkpoint'),select,timeoutMs});
}finally{await select.close?.();}
const wholeTaskSuccess=!result.failure&&result.rejections.length===0&&
  Object.values(result.hardGates).every(value=>value===0)&&isDeepStrictEqual(result.outcome,frozen.expected);
const sha=value=>createHash('sha256').update(value).digest('hex');
const report={schema:CAUSAL_LM_BRIDGE_VERSION,scope:'complete-selected-execution',
  origin:args.get('--origin'),arm:args.get('--arm'),wholeTaskSuccess,
  episodeSha256:sha(raw),adapterSha256:sha(readFileSync(path)),sourceAdmission:admission,
  identityDigest:exported.sidecar.identityDigest,splitIdentity:exported.sidecar.splitIdentity,
  tokenizerIdentity:tokenizer.identity,modelDeclaration,nativeAdmissionClaim:false,optimizerSteps:0,
  originalEmissions:select.metrics(),result};
writeFileSync(resolve(args.get('--out')),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({output:args.get('--out'),wholeTaskSuccess,arm:args.get('--arm'),
  originalGeneratedTokens:report.originalEmissions.generatedTokens,nativeAdmissionClaim:false})+'\n');
if(!wholeTaskSuccess)process.exitCode=1;
