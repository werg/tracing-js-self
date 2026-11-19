// Meter the real flat serving serializer, after immutable references expand.
// Public JSON snapshots, token estimates, and native framing are not substitutes.
import {causalLmV7Prompt,createAlgorithmContextResolver,encodeCausalLmV7Example} from './causal-lm-v7.js';
import {validateAlgorithmTokenizerEvidence} from './tokenizer.js';
import {hashAlgorithmData} from './program.js';
import {decodeAlgorithmRecord} from './trace-codec.js';
import {decodeDetailedRecord} from './detailed-v7.js';

const bytes=text=>Buffer.byteLength(text,'utf8');
const sum=items=>items.reduce((a,b)=>a+b,0);
function adapter(tokenizer,policy){
  if(!tokenizer)return null;
  validateAlgorithmTokenizerEvidence(tokenizer,policy);
  return {identity:tokenizer.identity.fingerprint,
    encode:text=>tokenizer.encode(text),decode:ids=>tokenizer.decode(ids)};
}

export async function auditFlatServingCosts(exported,{tokenizer=null,tokenizerPolicy=null,
    eosTokenId=null,maxContextTokens=1048576,retainTokenIds=true}={}){
  const episode=exported?.public,representation=episode?.representation;
  if(episode?.schema!=='semantic-execution/7'||episode.traceFormat!=='semantic-trace/7'||
    !['algorithm','detailed'].includes(representation))throw new TypeError('An actual v7 public execution is required');
  const targets=episode.timeline.filter(row=>row.mode==='generated');
  if(!Array.isArray(exported.contexts)||exported.contexts.length!==targets.length)
    throw new TypeError('One actual causal context per generated prediction is required');
  const codec=adapter(tokenizer,tokenizerPolicy);
  if(codec&&(!Number.isSafeInteger(eosTokenId)||eosTokenId<0))throw new TypeError('Exact serving EOS ID is required');
  const resolver=representation==='algorithm'?createAlgorithmContextResolver():null,rows=[];
  const decode=representation==='algorithm'?decodeAlgorithmRecord:decodeDetailedRecord;
  for(let index=0;index<targets.length;index++){
    const context=exported.contexts[index],target=targets[index].line;
    decode(target,{role:'generated'});
    if(context.representation!==representation)throw new TypeError('Serving context representation changed');
    // The serializer validates definitions and earlier publication availability.
    const prompt=causalLmV7Prompt(context,{representation,resolver});
    const encoded=codec?await encodeCausalLmV7Example(context,target,{tokenizer:codec,
      eosTokenId,maxContextTokens,representation,resolver}):null;
    if(encoded&&encoded.prompt!==prompt)throw new TypeError('Measured serving bytes differ from the actual encoder');
    rows.push({prediction:index,invocationId:context.invocationId??context.prefix?.invocationId,
      visibleThrough:context.visibleThrough,prompt,target,promptSha256:hashAlgorithmData(prompt),
      targetSha256:hashAlgorithmData(target),promptBytes:bytes(prompt),targetBytes:bytes(target),
      snapshotBytes:bytes(JSON.stringify(context)),promptTokens:encoded?.boundaries.promptTokens??null,
      generatedTokens:encoded?.boundaries.targetTokens??null,terminalTokens:encoded?.boundaries.terminalTokens??null,
      totalTokens:encoded?.costs.flatContextTokens??null,
      ...(encoded&&retainTokenIds?{inputIds:encoded.inputIds,labels:encoded.labels}:{}),
      detail:representation==='detailed'});
  }
  const generatedBytes=sum(rows.map(row=>row.targetBytes)),detailBytes=sum(rows.filter(row=>row.detail).map(row=>row.targetBytes));
  const generatedTokens=codec?sum(rows.map(row=>row.generatedTokens)):null;
  return {schema:'semantic-flat-serving-costs/1',path:'actual-semantic-causal-lm/3',representation,
    episodeDigest:hashAlgorithmData(episode),contextsDigest:hashAlgorithmData(exported.contexts),
    measurement:codec?'passed':'untested',byteMeasurement:'passed',
    tokenizer:codec?structuredClone(tokenizer.identity):null,eosTokenId:codec?eosTokenId:null,
    tokenReason:codec?null:'Exact pinned serving tokenizer and EOS were not supplied; bytes are not estimates',
    predictions:rows.length,bytes:{generated:generatedBytes,detailed:detailBytes,
      detailedShare:generatedBytes?detailBytes/generatedBytes:0,
      peakContext:rows.length?Math.max(...rows.map(row=>row.promptBytes)):0,
      cumulativeContext:sum(rows.map(row=>row.promptBytes)),
      cumulativePublicSnapshots:sum(rows.map(row=>row.snapshotBytes))},
    tokens:{generated:generatedTokens,terminal:codec?rows.length:null,
      observedAndContext:codec?sum(rows.map(row=>row.promptTokens)):null,
      peakContext:codec&&rows.length?Math.max(...rows.map(row=>row.promptTokens)):codec?0:null,
      cumulativeContext:codec?sum(rows.map(row=>row.promptTokens)):null,
      total:codec?sum(rows.map(row=>row.totalTokens)):null,
      detailedShare:codec&&generatedTokens?sum(rows.filter(row=>row.detail).map(row=>row.generatedTokens))/generatedTokens:null},
    accounting:{wholePrompts:true,wholeTargets:true,physicalSequence:'prompt tokens + target tokens + one EOS',
      additive:'Only these independently encoded physical segments are additive. Definitions, source, inputs, state and routing are included inside each whole prompt; their separately tokenized counts would not be additive.',
      contextReuse:'The flat resolver expands definitions and inputs on every prediction. No native cache discount is assumed.'},
    model:{status:'untested',completedExecution:null,nextStepAccuracy:null,latencyMs:null,failures:null,retries:null,
      tokensPerSuccessfulExecution:null,reason:'This is serializer accounting over checked teacher records, not a model run'},
    native:{status:'untested',reason:'Native physical framing, caching, fragmentation and serving latency require their own actual-run receipt'},rows};
}

/** Reduce actual model attempt measurements. Failures and retries remain in
 * the cost numerator; no successful execution means no cost-per-success value. */
export function summarizeModelInteractionCosts(attempts){
  if(!Array.isArray(attempts))throw new TypeError('Actual model attempts are required');
  const ids=new Set(),seenExecutions=new Set(),succeeded=new Set();
  for(const row of attempts){
    if(typeof row.id!=='string'||!row.id||ids.has(row.id)||typeof row.executionId!=='string'||!row.executionId||
      !['succeeded','failed','resource_limited'].includes(row.status)||
      !Number.isSafeInteger(row.promptTokens)||row.promptTokens<0||!Number.isSafeInteger(row.generatedTokens)||row.generatedTokens<0||
      !Number.isFinite(row.latencyMs)||row.latencyMs<0||!Number.isFinite(row.verificationMs)||row.verificationMs<0||
      row.retryOf!=null&&!ids.has(row.retryOf))throw new TypeError('Malformed actual model attempt');
    if(row.retryOf!=null&&attempts.find(other=>other.id===row.retryOf)?.executionId!==row.executionId)
      throw new TypeError('A retry must belong to the same execution');
    if(succeeded.has(row.executionId))throw new TypeError('An execution cannot continue after terminal success');
    ids.add(row.id);seenExecutions.add(row.executionId);
    if(row.status==='succeeded')succeeded.add(row.executionId);
  }
  const totalTokens=sum(attempts.map(row=>row.promptTokens+row.generatedTokens)),latencyMs=sum(attempts.map(row=>row.latencyMs)),
    verificationMs=sum(attempts.map(row=>row.verificationMs));
  return {schema:'semantic-model-interaction-costs/1',status:attempts.length?'measured':'untested',
    executions:seenExecutions.size,completedExecutions:succeeded.size,attempts:attempts.length,
    retries:attempts.filter(row=>row.retryOf!=null).length,failedAttempts:attempts.filter(row=>row.status!=='succeeded').length,
    totalTokens,latencyMs,verificationMs,
    tokensPerSuccessfulExecution:succeeded.size?totalTokens/succeeded.size:null,
    latencyPerSuccessfulExecution:succeeded.size?latencyMs/succeeded.size:null,
    qualification:'Supplied actual-run measurements; model identity and execution correctness must be established by the experiment receipt'};
}
