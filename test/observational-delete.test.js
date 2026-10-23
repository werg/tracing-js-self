import test from 'node:test';
import assert from 'node:assert/strict';
import {observeProgram} from '../src/observational.js';

test('native instrumentation preserves delete target and records actual mutation',async()=>{
 const x=await observeProgram({source:
  'function run(seed){const o={a:seed,b:2};const had=delete o.a;return {o,had,keys:Object.keys(o)}}',
  entry:'run',args:[7]});
 assert.equal(x.evidence.independentUninstrumentedV8,true);
 assert(x.events.some(e=>e.kind==='write'&&
  x.source.text.slice(e.site.start,e.site.end).includes('delete o.a')));
 const obj=x.observableGraph.objects.find(x=>x.properties.some(p=>p[0]==='had'));
 assert(obj);
 assert.equal(obj.properties.find(p=>p[0]==='had')[1][1],true);
});

test('delete through Proxy executes the guest trap once and is nonperturbing',async()=>{
 const x=await observeProgram({source:
  'function run(seed){const o={a:seed};let calls=0;const p=new Proxy(o,{deleteProperty(t,k){calls++;return Reflect.deleteProperty(t,k)}});delete p.a;return {calls,o}}',
  entry:'run',args:[5]});
 assert.equal(x.evidence.independentUninstrumentedV8,true);
 const row=x.observableGraph.objects.find(x=>x.properties.some(p=>p[0]==='calls'));
 assert.equal(row.properties.find(p=>p[0]==='calls')[1][1],1);
});
