import test from 'node:test';
import assert from 'node:assert/strict';
import {lowerJavaScriptV8} from '../src/semantic/lower-v8.js';
import {renderAlgorithmV8,renderAlgorithmV8Record,renderAlgorithmV8Term} from '../src/semantic/render-v8.js';
import {canonicalAlgorithmV8} from '../src/semantic/algorithm-v8.js';

test('v8 notation arms retain the same core, callback binding, traversal profile and order',()=>{
  const {core}=lowerJavaScriptV8({source:'"use strict";function run(xs){const offset=3;return xs.map(x=>x+offset);}',entry:'run'}),before=structuredClone(core);
  const formal=renderAlgorithmV8(core,{style:'formal'}),hybrid=renderAlgorithmV8(core),prose=renderAlgorithmV8(core,{style:'prose'});
  assert.match(formal,/map\(\$a0, \(item0, index0, items0\) => \(item0 \+ 3\)/);
  for(const text of [formal,hybrid,prose]){assert.match(text,/dense-primitive-array\/1/);assert.match(text,/ascending/);}
  assert.match(prose,/fresh array/);assert.deepEqual(core,before);
  assert.equal(renderAlgorithmV8(core,{style:'canonical'}),canonicalAlgorithmV8(core));
});
test('v8 renderers preserve early stop/default distinctions and repeated alias references',()=>{
  const get=body=>lowerJavaScriptV8({source:'"use strict";'+body,entry:'run'}).core;
  const find=renderAlgorithmV8(get('function run(xs){return xs.find(x=>x>2);}'),{style:'prose'});
  assert.match(find,/Stop at the first truthy/);assert.match(find,/original item/);assert.match(find,/otherwise return undefined/);
  const defaults=renderAlgorithmV8(get('function run(x=3){return x;}'),{style:'prose'});assert.match(defaults,/only if.*is undefined/);
  const aliases=renderAlgorithmV8(get('function run(){const o={x:1};return [o,o];}'));
  assert.match(aliases,/allocate \{"x": 1\}/);assert.match(aliases,/\[local0_0, local0_0\]/);
});
test('derived v8 record views retain literal keys and fallback envelopes losslessly',()=>{
  const term={op:'object',properties:[{key:'do not rename',value:{op:'literal',value:['num',4]}}]};
  assert.match(renderAlgorithmV8Term(term),/"do not rename"/);
  const envelope={kind:'algorithm',graph:{roots:[],objects:[]},claims:[]};
  assert.deepEqual(JSON.parse(renderAlgorithmV8Record(envelope)),envelope);
  assert.throws(()=>renderAlgorithmV8Term({op:'bound',depth:0,index:0}),/unbound/);
  assert.equal(renderAlgorithmV8Term({op:'bound',depth:0,index:0},{scopeArities:[1]}),'bound0_0');
});
