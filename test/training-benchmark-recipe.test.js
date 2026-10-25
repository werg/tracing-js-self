import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'acorn';
import {benchmarkFamiliesV1,BENCHMARK_ALGORITHMS,BENCHMARK_RECIPE_NAME,BENCHMARK_RECIPE_VERSION,semanticRecipeFamilies} from '../src/training/recipe-fixtures.js';
import {effectfulFamilySplit,verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
import {verifyEffectfulSession} from '../src/training/effectful-session.js';
import {controlledEvaluationCase,evaluateSelectedCase} from '../src/training/selected-evaluation.js';
import {SelectedModelDriver} from '../src/training/model-driver.js';

const normalizedAst=source=>{
  const ast=parse(source,{ecmaVersion:'latest'});
  ast.body=ast.body.filter(statement=>!statement.directive);
  const clean=value=>Array.isArray(value)?value.map(clean):value&&typeof value==='object'?
    Object.fromEntries(Object.entries(value).filter(([key])=>!['start','end','loc'].includes(key)).map(([key,item])=>[key,clean(item)])):value;
  return JSON.stringify(clean(ast));
};

test('benchmark-v1 retains distinct canonical algorithms, ancestry and split',()=>{
  const families=benchmarkFamiliesV1();
  assert.equal(BENCHMARK_RECIPE_NAME,'benchmark-v1');
  assert.equal(BENCHMARK_RECIPE_VERSION,'semantic-source-benchmark/1');
  assert.equal(families.length,BENCHMARK_ALGORITHMS.length);
  const asts=BENCHMARK_ALGORITHMS.map(x=>normalizedAst('function run(a,b){'+x.body+'}'));
  const prior=semanticRecipeFamilies().map(x=>normalizedAst(x.pure.source));
  assert.equal(new Set(asts).size,asts.length);
  assert(asts.every(ast=>!prior.includes(ast)));
  const counts={train:0,validation:0,test:0};
  for(const [index,f] of families.entries()){
    const split=effectfulFamilySplit(f.family);counts[split]++;
    assert.equal(f.pure.family,f.family);
    for(const variant of [f.pure,f.callbacks,...f.repeated.cases]){
      assert.equal(variant.family,f.family);
      assert.deepEqual(variant.ancestorIds,['source-algorithm-v1:'+f.template]);
      assert.equal(effectfulFamilySplit(variant.family),split);
    }
    assert.equal(normalizedAst('function run(a,b){'+BENCHMARK_ALGORITHMS[index].body+'}'),asts[index]);
  }
  assert(counts.test>=2&&counts.validation>=2,JSON.stringify(counts));
  assert.equal(Object.values(counts).reduce((a,b)=>a+b,0),BENCHMARK_ALGORITHMS.length);
  assert.throws(()=>benchmarkFamiliesV1({representation:'explicit'}),/canonical semantic trace/);
});
test('benchmark-v1 generates executable pure, callback, repeated-input and recovery source paths',async()=>{
  const families=benchmarkFamiliesV1();
  for(const split of ['train','validation','test']){
    const family=families.find(item=>effectfulFamilySplit(item.family)===split);
    assert(family,`no ${split} family declared`);
    assert.match(family.pure.source,/function run\(a,b\)/);
    assert.match(family.callbacks.source,/host\.withCallback/);
    assert.equal(family.repeated.cases.length,2);
    assert(family.repeated.cases.every(item=>item.fixture.calls.some(call=>call.operation==='demo.readAsync')));
    assert(family.callbacks.fixture.calls.some(call=>call.operation==='demo.withCallback'));
    assert.deepEqual(family.pure.ancestorIds,['source-algorithm-v1:'+family.template]);
  }
  for(const split of ['train','validation','test']){
    const family=families.find(item=>effectfulFamilySplit(item.family)===split);
    const result=await verifyEffectfulTrainingCase(family.pure);
    assert.equal(result.status,'locally_verified',`${split}: ${result.reason}`);
    assert.equal(result.exported.sidecar.split,split);
    assert.deepEqual(result.exported.sidecar.ancestorIds,[family.family,'source-algorithm-v1:'+family.template]);
  }
  const arrayFamily=families.find(item=>item.template==='array-sum');
  const callback=await verifyEffectfulTrainingCase(arrayFamily.callbacks);
  assert.equal(callback.status,'locally_verified',callback.reason);
  const repeated=await verifyEffectfulSession(arrayFamily.repeated);
  assert.equal(repeated.status,'locally_verified',repeated.reason);
});

test('named bit and rotation algorithms retain their declared mathematical meaning',()=>{
  const run=name=>{
    const algorithm=BENCHMARK_ALGORITHMS.find(item=>item.name===name);
    return Function('a','b',algorithm.body);
  };
  assert.equal(run('gray-code')(13,2),(13^(13>>1))+2);
  assert.equal(run('array-rotate-left-checksum')([2,4,1],1),4+1*2+2*3+1);
});

test('array-result references agree with canonical selected execution',async()=>{
  const family=benchmarkFamiliesV1().find(item=>item.template==='array-sum');
  const admission=await verifyEffectfulTrainingCase(family.pure);
  assert.equal(admission.status,'locally_verified',admission.reason);
  const fixture=controlledEvaluationCase(admission.exported,{id:'array-sum-canonical'});
  const actual=await evaluateSelectedCase({schema:'semantic-evaluation-request/4',
    caseId:fixture.id,request:fixture.request,seed:17,representation:'compact'});
  assert.equal(actual.failure,null,JSON.stringify(actual.failure));
  assert.deepEqual(actual.outcome,fixture.expected);
  assert.equal(actual.firstSemanticInconsistency,null);
});
test('an unobservable completed graph retains the evaluation episode and effect receipts',async t=>{
  const family=benchmarkFamiliesV1().find(item=>item.template==='array-sum');
  const admitted=await verifyEffectfulTrainingCase(family.callbacks);
  assert.equal(admitted.status,'locally_verified',admitted.reason);
  const fixture=controlledEvaluationCase(admitted.exported,{id:'unobservable-completion'});
  const run=SelectedModelDriver.prototype.run;
  t.mock.method(SelectedModelDriver.prototype,'run',async function(...args){
    const result=await run.apply(this,args);
    // The driver permits this result when its ordinary graph materializer
    // cannot expose a completed rich value. Keep all other real run evidence.
    return {...result,observableGraph:null};
  });
  const result=await evaluateSelectedCase({schema:'semantic-evaluation-request/4',
    caseId:fixture.id,request:fixture.request,seed:17,representation:'compact'});
  assert.equal(result.outcome.state,null);
  assert.equal(result.failure,null);
  assert(result.episode.public.timeline.length>0);
  assert.deepEqual(result.outcome.effects,fixture.expected.effects);
  assert.deepEqual(result.outcome.callbacks,fixture.expected.callbacks);
  assert.deepEqual(result.outcome.cleanup,fixture.expected.cleanup);
});
