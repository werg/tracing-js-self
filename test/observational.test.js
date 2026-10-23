import test from 'node:test';
import assert from 'node:assert/strict';
import {observeProgram} from '../src/observational.js';

test('native observation captures executed expressions, branch and return',async()=>{
  const source='function f(a,b){const sum=a+b;if(sum>5)return Math.max(sum,5);return b;}';
  const r=await observeProgram({source,entry:'f',args:[3,4]});
  assert.equal(r.evidence.independentUninstrumentedV8,true,JSON.stringify(r));
  assert.deepEqual(r.observableGraph.roots.at(-1),['num',7]);
  assert(r.events.some(e=>e.kind==='branch'&&e.path==='then'));
  assert(r.events.some(e=>e.kind==='call'&&
    source.slice(e.site.start,e.site.end).includes('Math.max')));
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


test('class methods, constructor and lexical iteration report effective operations',async()=>{
  const source=[
    'class Counter {',
    '  constructor(n){this.n=n;}',
    '  inc(){this.n++;return this.n;}',
    '}',
    'function f(n){let out=[];for(const x of [n,n+1]){let c=new Counter(x);out.push(c.inc());}return out;}'
  ].join('\n');
  const r=await observeProgram({source,entry:'f',args:[3]});
  assert.equal(r.evidence.independentUninstrumentedV8,true,JSON.stringify(r));
  assert.equal(r.events.filter(e=>e.kind==='loop').length,2);
  assert(r.events.some(e=>e.kind==='enter'&&e.name==='constructor'));
  assert(r.events.some(e=>e.kind==='enter'&&e.name==='inc'));
  assert.deepEqual(r.observableGraph.objects.find(o=>o.kind==='array').properties
    .filter(([k])=>k==='0'||k==='1'),[['0',['num',4]],['1',['num',5]]]);
});

test('Map, Set, Date, RegExp content participates in real-world end-state comparison',async()=>{
  const source='function f(){const m=new Map();m.set("k",3);const s=new Set();s.add(7);return [m,s,new Date(0),/ab+/gi];}';
  const r=await observeProgram({source,entry:'f'});
  assert.equal(r.evidence.independentUninstrumentedV8,true,JSON.stringify(r));
  const kinds=new Set(r.observableGraph.objects.map(x=>x.kind));
  for(const name of ['map','set','date','regexp'])assert(kinds.has(name),name);
  assert(r.events.some(e=>e.effects?.some(x=>x.key==='[[Entries]]')));
});

test('getters, setters and proxy traps are executed without a snapshot-induced getter call',async()=>{
  const source=[
    'function f(){',
    ' let calls=0;',
    ' const target={x:1};',
    ' Object.defineProperty(target,"value",{get(){calls++;return this.x+1;},set(v){calls++;this.x=v;}});',
    ' const p=new Proxy(target,{get(o,k,r){return Reflect.get(o,k,r);}});',
    ' const v=p.value;target.value=8;return [v,target.x,calls];',
    '}'
  ].join('\n');
  const r=await observeProgram({source,entry:'f'});
  assert.equal(r.evidence.independentUninstrumentedV8,true,JSON.stringify(r));
  const arr=r.observableGraph.objects.find(o=>o.kind==='array');
  assert.deepEqual(arr.properties.filter(([k])=>k!=='length'),
    [['0',['num',2]],['1',['num',8]],['2',['num',2]]]);
  assert(r.events.some(e=>e.kind==='enter'&&e.name.includes('get')));
  assert(r.events.some(e=>e.kind==='enter'&&e.name.includes('set')));
  assert(r.events.some(e=>e.kind==='enter'&&e.name.includes('get')));
});

test('await and resume follow the actual async computation',async()=>{
  const source='async function f(x){const a=await Promise.resolve(x+1);return a*2;}';
  const r=await observeProgram({source,entry:'f',args:[4]});
  assert.equal(r.evidence.independentUninstrumentedV8,true,JSON.stringify(r));
  assert.deepEqual(r.observableGraph.roots.at(-1),['num',10]);
  assert(r.events.some(e=>e.kind==='await'));
  assert(r.events.some(e=>e.kind==='resume'));
});
