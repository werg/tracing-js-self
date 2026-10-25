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

test('benchmark-v1 retains distinct declared source algorithms with stable family ancestry and hash splits',()=>{
  const explicit=benchmarkFamiliesV1(),compact=benchmarkFamiliesV1({representation:'compact'});
  assert.equal(BENCHMARK_RECIPE_NAME,'benchmark-v1');assert.equal(BENCHMARK_RECIPE_VERSION,'semantic-source-benchmark/1');
  assert.equal(explicit.length,BENCHMARK_ALGORITHMS.length);assert.equal(compact.length,explicit.length);
  assert.deepEqual(explicit.map(x=>x.family),compact.map(x=>x.family));
  const asts=BENCHMARK_ALGORITHMS.map(x=>normalizedAst('function run(a,b){'+x.body+'}'));
  const oldAsts=semanticRecipeFamilies().map(x=>normalizedAst(x.pure.source));
  assert.equal(new Set(asts).size,asts.length,'catalogue contains normalized-AST duplicate algorithms');
  assert(asts.every(ast=>!oldAsts.includes(ast)),'new family duplicates an old recipe AST');
  const counts={train:0,validation:0,test:0};
  for(const [i,f] of explicit.entries()){
    const split=effectfulFamilySplit(f.family);counts[split]++;
    assert.equal(f.family,compact[i].family);assert.equal(f.pure.family,f.family);
    for(const variant of [f.pure,f.callbacks,...f.repeated.cases]){
      assert.equal(variant.family,f.family);assert.deepEqual(variant.ancestorIds,['source-algorithm-v1:'+f.template]);
      assert.equal(effectfulFamilySplit(variant.family),split);
    }
    assert.equal(normalizedAst('function run(a,b){'+BENCHMARK_ALGORITHMS[i].body+'}'),asts[i]);
  }
  assert(counts.test>=2&&counts.validation>=2,JSON.stringify(counts));
  assert.equal(Object.values(counts).reduce((a,b)=>a+b,0),BENCHMARK_ALGORITHMS.length);
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

test('array-result reference graphs evaluate consistently in explicit compact and outcome-only forms',async()=>{
  const family=benchmarkFamiliesV1().find(item=>item.template==='array-sum');
  const compactFamily=benchmarkFamiliesV1({representation:'compact'}).find(item=>item.template==='array-sum');
  const admitted=await verifyEffectfulTrainingCase(family.pure);
  const compactAdmitted=await verifyEffectfulTrainingCase(compactFamily.pure);
  assert.equal(admitted.status,'locally_verified',admitted.reason);
  assert.equal(compactAdmitted.status,'locally_verified',compactAdmitted.reason);
  const fixture=controlledEvaluationCase(admitted.exported,{id:'array-sum-representation-parity'});
  const compactFixture=controlledEvaluationCase(compactAdmitted.exported,{id:fixture.id});
  Object.assign(fixture.request.controlledSelectionsByRepresentation,
    compactFixture.request.controlledSelectionsByRepresentation);
  for(const representation of ['explicit','compact','outcome-only']){
    const result=await evaluateSelectedCase({schema:'semantic-evaluation-request/4',
      caseId:fixture.id,request:fixture.request,seed:17,representation});
    assert.equal(result.failure,null,`${representation}: ${JSON.stringify(result.failure)}`);
    assert.deepEqual(result.outcome,fixture.expected,representation);
    assert.equal(result.firstSemanticInconsistency,null,representation);
  }
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
    caseId:fixture.id,request:fixture.request,seed:17,representation:'explicit'});
  assert.equal(result.outcome.state,null);
  assert.equal(result.failure,null);
  assert(result.episode.public.timeline.length>0);
  assert.deepEqual(result.outcome.effects,fixture.expected.effects);
  assert.deepEqual(result.outcome.callbacks,fixture.expected.callbacks);
  assert.deepEqual(result.outcome.cleanup,fixture.expected.cleanup);
});
