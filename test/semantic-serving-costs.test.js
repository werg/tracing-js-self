import test from 'node:test';
import assert from 'node:assert/strict';
import {AlgorithmExecutionHarness} from '../src/semantic/harness.js';
import {evaluateTerm} from '../src/semantic/operations.js';
import {auditFlatServingCosts,summarizeModelInteractionCosts} from '../src/semantic/serving-costs.js';
const fixture=()=>{
  const harness=new AlgorithmExecutionHarness({source:'"use strict";function run(a){return a+1;}',entry:'run',args:[4]}),contexts=[];
  while(!harness.controller.completion){
    contexts.push(harness.modelContext());
    const step=harness.controller.nextStep();harness.select(step.kind==='compute'?{...step,
      result:evaluateTerm(step.term,harness.controller.environment())}:{kind:step.kind,
      value:evaluateTerm(step.value,harness.controller.environment())});
  }
  return {public:harness.exportEpisode(),contexts};
};
const policy={consumerRevision:'a'.repeat(40),tokenizerIdentity:'b'.repeat(64),tokenizerSha256:'c'.repeat(64)};
const byteCodec={identity:{fingerprint:policy.tokenizerIdentity,tokenizerSha256:policy.tokenizerSha256,
  name:'byte test fixture',revision:'test',codecVersion:'test',vocabSize:257},
  qualification:{schema:'semantic-codec-meter/1',status:'qualified',scope:'byte-exact-token-meter-only',
    consumerRevision:policy.consumerRevision,consumerClean:true,nativeAdmission:false,tokenizersVersion:'0.23.3',
    codecSourceSha256:'d'.repeat(64),pythonVersion:'test fixture'},
  encode:text=>[...Buffer.from(text)],decode:ids=>Buffer.from(ids).toString('utf8')};

test('flat serving costs count expanded definitions on every actual prompt',async()=>{
  const report=await auditFlatServingCosts(fixture());
  assert.equal(report.measurement,'untested');
  assert.equal(report.tokens.total,null);
  assert.equal(report.model.completedExecution,null);
  assert.equal(report.native.status,'untested');
  assert.ok(report.bytes.cumulativeContext>report.bytes.cumulativePublicSnapshots);
  for(const row of report.rows){assert.match(row.prompt,/function run/);assert.match(row.prompt,/inputGraph/);}
  assert.equal(report.rows.length,2);
});

test('metered whole serving segments exactly include EOS without component-token addition',async()=>{
  const report=await auditFlatServingCosts(fixture(),{tokenizer:byteCodec,tokenizerPolicy:policy,eosTokenId:256});
  assert.equal(report.measurement,'passed');
  assert.equal(report.tokens.total,report.tokens.cumulativeContext+report.tokens.generated+report.tokens.terminal);
  for(const row of report.rows){
    assert.equal(row.inputIds.length,row.totalTokens);
    assert.equal(row.inputIds.at(-1),256);
    assert.equal(row.labels.filter(id=>id!==-100).length,row.generatedTokens+1);
    assert.ok(row.labels.slice(0,row.promptTokens).every(id=>id===-100));
  }
  await assert.rejects(auditFlatServingCosts(fixture(),{tokenizer:byteCodec,tokenizerPolicy:policy}),/EOS/);
  const changed=fixture();delete changed.contexts[0].program;
  await assert.rejects(auditFlatServingCosts(changed),/not publicly published/);
});

test('failed attempts and retries contribute to per-success costs',()=>{
  const a={id:'a',executionId:'run',status:'failed',promptTokens:100,generatedTokens:10,latencyMs:30,verificationMs:2};
  const b={...a,id:'b',status:'succeeded',retryOf:'a'};
  const report=summarizeModelInteractionCosts([a,b]);
  assert.equal(report.completedExecutions,1);assert.equal(report.retries,1);
  assert.equal(report.tokensPerSuccessfulExecution,220);assert.equal(report.verificationMs,4);
  assert.equal(summarizeModelInteractionCosts([a]).tokensPerSuccessfulExecution,null);
  assert.throws(()=>summarizeModelInteractionCosts([{...a,retryOf:'missing'}]),/Malformed/);
});

test('actual selector accounts for repeated prompts and failed generation attempts',async()=>{
  const {createCausalLmV7Selector}=await import('../src/semantic/causal-lm-v7.js');
  const exported=fixture(),context=exported.contexts[0];let attempts=0;
  const tokenizer={identity:policy.tokenizerIdentity,encode:byteCodec.encode,decode:byteCodec.decode},
    checkpointIdentity='e'.repeat(64);
  const runtime={initialize:async request=>({...request,tokenizerIdentity:tokenizer.identity}),
    generate:async()=>{if(attempts++===0)throw new Error('temporary generation failure');
      return {tokenIds:[...Buffer.from(exported.public.timeline.find(row=>row.mode==='generated').line),256],stopReason:'eos'};}};
  const select=createCausalLmV7Selector({runtime,tokenizer,checkpointIdentity,eosTokenId:256,
    maxContextTokens:100000,maxNewTokens:10000});
  await select.initialize({checkpointIdentity,seed:1});
  await assert.rejects(select(context),/temporary/);await select(context);
  const metrics=select.metrics();
  assert.equal(metrics.predictionAttempts,2);assert.equal(metrics.failedAttempts,1);assert.equal(metrics.retries,1);
  assert.equal(metrics.unknownGenerationCostAttempts,1);
  assert.equal(metrics.promptTokens,metrics.peakContextTokens*2);
  assert.ok(metrics.generationMs>=0);assert.ok(metrics.verificationMs>=0);
});
