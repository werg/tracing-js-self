import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {lowerJavaScript,tryLowerJavaScript,AlgorithmLoweringError} from '../src/semantic/lower-js.js';
import {evaluateAlgorithm,encodeScalar} from '../src/semantic/operations.js';
import {normalizeAlgorithm} from '../src/semantic/normalize-algorithm.js';
import {canonicalAlgorithmString} from '../src/semantic/ir.js';
import {verifyOwnedSourceCase} from '../src/training/source-check.js';
import {SEMANTIC_EQUIVALENCE_FAMILIES,SEMANTIC_EQUIVALENCE_NEGATIVES} from '../fixtures/semantic-equivalence/families.js';

function inputGraph(args){
  const heap=new Map(),roots=args.map((value,index)=>{
    if(!Array.isArray(value))return encodeScalar(value);
    const id='array'+index;
    heap.set(id,{kind:'array',properties:new Map([
      ['length',encodeScalar(value.length)],...Object.entries(value).map(([key,item])=>[key,encodeScalar(item)])])});
    return ['ref',id];
  });return {roots,heap};
}
const evaluate=(core,args)=>{const {roots,heap}=inputGraph(args);return evaluateAlgorithm(core,roots,{heap});};
const native=(source,entry,args)=>new vm.Script(source+';'+entry+'(...inputs);').runInNewContext({inputs:args},{timeout:100});

test('declared equivalence families converge without source spelling or private allocation identities',()=>{
  for(const family of SEMANTIC_EQUIVALENCE_FAMILIES){
    const lowered=family.variants.map(variant=>lowerJavaScript({...variant,inputTypes:family.inputTypes}));
    const canonical=canonicalAlgorithmString(lowered[0].core);
    for(let index=0;index<lowered.length;index++){
      const {core,provenance}=lowered[index];
      assert.equal(canonicalAlgorithmString(core),canonical,family.id+'/'+family.variants[index].id);
      assert.deepEqual(normalizeAlgorithm(core),core,'normalization is idempotent');
      assert.deepEqual(lowerJavaScript({...family.variants[index],inputTypes:family.inputTypes}).core,core,'deterministic lowering');
      assert.equal(provenance.effectBoundaries.length,0);
      assert(provenance.rules.length>0);
      for(const args of family.cases){
        const actual=evaluate(core,args).completion;
        assert.deepEqual(actual,{kind:'return',value:encodeScalar(native(family.variants[index].source,'run',args))},
          family.id+'/'+family.variants[index].id);
      }
    }
    assert.equal(new Set(lowered.map(row=>row.provenance.sourceDigest)).size,lowered.length,
      'distinct source evidence remains distinct after semantic convergence');
  }
});

test('ordered folds agree with independent native execution over exhaustive small inputs and numeric edges',()=>{
  const family=SEMANTIC_EQUIVALENCE_FAMILIES.find(row=>row.id==='ordered-numeric-sum/1');
  const words=[[]];
  for(let length=1;length<=3;length++){
    const extend=prefix=>prefix.length===length?words.push(prefix):[-2,-0,1,2].forEach(value=>extend([...prefix,value]));
    extend([]);
  }
  for(const variant of family.variants){
    const core=lowerJavaScript(variant).core,script=new vm.Script(variant.source+';run(inputs);');
    for(const word of words){
      const expected=script.runInNewContext({inputs:word},{timeout:100});
      assert.deepEqual(evaluate(core,[word]).completion.value,encodeScalar(expected),variant.id+' '+String(word));
    }
  }
  const core=lowerJavaScript(family.variants[0]).core;
  assert.deepEqual(evaluate(core,[[1e16,1,-1e16]]).completion.value,['num',0]);
  assert.deepEqual(evaluate(core,[[1e16,-1e16,1]]).completion.value,['num',1]);
  assert.deepEqual(evaluate(core,[[-0]]).completion.value,['num',0]);
  assert.deepEqual(evaluate(core,[[Number.MAX_VALUE,Number.MAX_VALUE]]).completion.value,['num','+Infinity']);
});

test('numeric fold guards reject sparse, coercing, hooked, custom, nonfinite, and oversized arrays',()=>{
  const variant=SEMANTIC_EQUIVALENCE_FAMILIES[1].variants[0],core=lowerJavaScript(variant).core;
  for(const values of [[,2],['2',3],[NaN],[Infinity],Array(129).fill(1)])
    assert.throws(()=>evaluate(core,[values]),/dense|bound|finite|holes/);
  for(const extra of [{iterator:true},{proxy:true},{accessors:{0:true}},{prototype:null}]){
    const {roots,heap}=inputGraph([[1,2]]);Object.assign(heap.get('array0'),extra);
    assert.throws(()=>evaluateAlgorithm(core,roots,{heap}),/ordinary|prototype/);
  }
  const {roots,heap}=inputGraph([[1,2]]);heap.get('array0').properties.set('extra',['num',3]);
  assert.throws(()=>evaluateAlgorithm(core,roots,{heap}),/extra/);
});

test('negative pairs keep changed computations, source effects, aliases, error paths, and captures distinct',()=>{
  for(const fixture of SEMANTIC_EQUIVALENCE_NEGATIVES){
    if(fixture.expect==='distinct'){
      const left=lowerJavaScript({source:fixture.left,entry:fixture.entry}).core;
      const right=lowerJavaScript({source:fixture.right,entry:fixture.entry}).core;
      assert.notEqual(canonicalAlgorithmString(left),canonicalAlgorithmString(right),fixture.id);
    }else{
      const result=tryLowerJavaScript({source:fixture.source,entry:'run'});
      assert.equal(result.status,'refused',fixture.id);
      assert.equal(result.disposition,'detailed-fallback',fixture.id);
    }
  }
});

test('private scalarization preserves the computational relation and explicit numeric domain',()=>{
  const source='"use strict";function run(a,b){const previous=a+b;return previous*2;}';
  const {core}=lowerJavaScript({source,entry:'run'});
  assert.deepEqual(core.inputs,[{id:'a0',type:'number'},{id:'a1',type:'number'}]);
  assert.equal(core.steps[0].term.op,'multiply');
  assert.equal(core.steps[0].term.args[0].op,'add');
  assert.throws(()=>evaluate(core,['2',3]),/number input/,'coercing addition cannot inherit numeric normalization');
  assert.deepEqual(evaluate(core,[-0,-0]).completion.value,['num','-0']);
  const concat=lowerJavaScript({source:'"use strict";function run(x){return "value="+x;}',entry:'run'}).core;
  assert.deepEqual(evaluate(concat,[2n]).completion.value,['str','value=2']);
  for(const expression of ['box.n++','++box.n','box.n--','--box.n']){
    const update='"use strict";function run(){const box={n:"2"};return '+expression+';}';
    assert.deepEqual(evaluate(lowerJavaScript({source:update,entry:'run'}).core,[]).completion.value,
      encodeScalar(native(update,'run',[])),'update expressions perform ToNumeric');
  }
});

test('lexical shadowing and bounded helpers preserve bindings and argument evaluation',()=>{
  const source='"use strict";function twice(x){const temp=x*2;return temp;}function run(a){const value=a+1;{const value=a*4;}return twice(value);}';
  const direct='"use strict";function run(a){return (a+1)*2;}';
  assert.deepEqual(lowerJavaScript({source,entry:'run'}).core,lowerJavaScript({source:direct,entry:'run'}).core);
  assert.throws(()=>lowerJavaScript({source:'"use strict";function first(a,b){return a;}function run(){return first(3,1n/0n);}',entry:'run'}),AlgorithmLoweringError);
  const omitted='"use strict";function first(a,b){return a;}function run(x){return first(3,x+1);}';
  const constant='"use strict";function run(x){return 3;}';
  assert.deepEqual(lowerJavaScript({source:omitted,entry:'run',inputTypes:['number']}).core,
    lowerJavaScript({source:constant,entry:'run',inputTypes:['number']}).core);
});

test('representative folds and private-state sources retain owned replay and independent source checks',()=>{
  for(const family of SEMANTIC_EQUIVALENCE_FAMILIES.filter(row=>['ordered-numeric-sum/1','private-object-increment/1'].includes(row.id))){
    for(const variant of family.variants){
      const args=family.id==='ordered-numeric-sum/1'?[[2,3,4]]:[];
      const checked=verifyOwnedSourceCase({...variant,args,maxSteps:10000,maxGenerated:1024});
      assert.equal(checked.status,'locally_verified',variant.id+' '+checked.reason);
      assert.deepEqual(evaluate(lowerJavaScript(variant).core,args).completion.value,
        encodeScalar(native(variant.source,variant.entry,args)));
    }
  }
});
