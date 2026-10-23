import test from 'node:test';
import assert from 'node:assert/strict';
import {observeProgram} from '../src/observational.js';

test('native observation captures executed expressions, branch and return',async()=>{
  const source='function f(a,b){const sum=a+b;if(sum>5)return Math.max(sum,5);return b;}';
  const r=await observeProgram({source,entry:'f',args:[3,4]});
  assert.equal(r.evidence.independentUninstrumentedV8,true,JSON.stringify(r));
  assert.deepEqual(r.observableGraph.roots.at(-1),['num',7]);
  assert(r.events.some(e=>e.kind==='branch'&&e.path==='then'));
  assert(r.events.some(e=>e.kind==='call'&&e.source.includes('Math.max')));
  assert.equal(r.profile,'trusted-v8-observation');
});

test('TypeScript exports can be traced with unchanged source',async()=>{
  const source='export function f(values: number[]): number { let s=0; for (const n of values) s+=n; return s; }';
  const r=await observeProgram({source,language:'ts',entry:'f',args:[[2,3,5]]});
  assert.equal(r.evidence.independentUninstrumentedV8,true,JSON.stringify(r));
  assert.deepEqual(r.observableGraph.roots.at(-1),['num',10]);
});

test('array mutations and returned aliases survive the observed state diff',async()=>{
  const source='function f(a){a.push(5);a.splice(0,1);a.length=1;return a;}';
  const r=await observeProgram({source,entry:'f',args:[[1,2,3]]});
  assert.equal(r.evidence.independentUninstrumentedV8,true,JSON.stringify(r));
  const array=r.observableGraph.objects.find(x=>x.kind==='array');
  assert.deepEqual(array.properties,[['0',['num',2]],['length',['num',1]]]);
  assert(r.events.some(e=>e.effects?.some(w=>w.key==='length')));
  assert(r.events.some(e=>e.effects?.some(w=>w.after?.[0]==='absent')));
  assert.equal(r.observableGraph.roots[0][1],r.observableGraph.roots[1][1]);
});
