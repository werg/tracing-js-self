import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeNativeGraph,decodeOwnedGraph,materializeOwnedGraph,validateOwnedGraph,
  materializeHostArguments,ownedCallbackId} from '../src/host/materialize.js';

test('owned graph preserves aliases, cycles, sparse arrays and special scalars',()=>{
  const shared={n:NaN,z:-0,b:3n,u:undefined};
  const list=new Array(4);list[2]=shared;shared.list=list;
  const graph=encodeNativeGraph([shared,shared,list,Infinity,-Infinity]);
  const [first,second,array,pos,neg]=decodeOwnedGraph(JSON.stringify(graph));
  assert.equal(first,second);assert.equal(first.list,array);assert.equal(array[2],first);
  assert.equal(0 in array,false);assert.equal(array.length,4);
  assert(Number.isNaN(first.n));assert(Object.is(first.z,-0));assert.equal(first.b,3n);
  assert(Object.hasOwn(first,'u'));assert.equal(pos,Infinity);assert.equal(neg,-Infinity);
});

test('graph snapshot is immutable and has checked owned version provenance',()=>{
  const heap={o1:{kind:'object',version:2,properties:{self:{value:['ref','o1']},
    value:{value:['undefined']}}}};
  const request=materializeHostArguments(heap,[['ref','o1'],['ref','o1']],{codec:'owned-graph/1'});
  heap.o1.properties.value.value=['num',42];
  const roots=decodeOwnedGraph(request.payload);
  assert.equal(roots[0],roots[1]);assert.equal(roots[0].self,roots[0]);
  assert.equal(roots[0].value,undefined);assert.equal(request.graphVersions[0].version,2);
  assert(Object.isFrozen(request.graphVersions[0]));
});

test('graph codecs refuse getters, proxies, forged identities and quota violations',()=>{
  let calls=0;
  assert.throws(()=>encodeNativeGraph([{get value(){calls++;return 7;}}]),/accessor/);
  assert.throws(()=>encodeNativeGraph([new Proxy({},{ownKeys(){calls++;return [];}})]),/plain data/);
  assert.equal(calls,0);
  const graph=encodeNativeGraph([{value:1}]);
  graph.roots[0]=['ref','foreign'];assert.throws(()=>validateOwnedGraph(graph),/Dangling/);
  assert.throws(()=>encodeNativeGraph(['oversized'],{maxBytes:4}),/payload/);
  assert.throws(()=>materializeOwnedGraph({},[['num',-0]]),/Noncanonical/);
  assert.throws(()=>materializeOwnedGraph({},[['bigint','01']]),/Noncanonical/);
});

test('callback slots stay opaque and cannot become graph data functions',()=>{
  const heap={o1:{kind:'closure',code:'handler',properties:{}}};
  const snapshot=materializeOwnedGraph(heap,[['ref','o1']],{callbackIndices:[0]});
  assert.deepEqual(decodeOwnedGraph(snapshot.payload,{callbackIndices:[0]}),[{$ownedCallback:'o1'}]);
  assert.throws(()=>decodeOwnedGraph(snapshot.payload),/scalar/);
  assert.throws(()=>materializeOwnedGraph(heap,[['ref','o1']]),/data identities/);
});

test('nested declared callbacks are branded and ordinary lookalike data cannot forge them',()=>{
  const heap={o1:{kind:'closure',properties:{}},o2:{kind:'array',properties:{
    length:{value:['num',1]},0:{value:['ref','o1']}}}};
  const snap=materializeOwnedGraph(heap,[['ref','o2']],{callbackGraph:true});
  const args=decodeOwnedGraph(snap.payload,{callbackGraph:true});
  assert.equal(ownedCallbackId(args[0][0]),'o1');
  assert.equal(ownedCallbackId({$ownedCallback:'o1'}),null);
  assert.equal(ownedCallbackId(structuredClone(args[0][0])),null);
  assert.throws(()=>decodeOwnedGraph(snap.payload),/scalar/);
});
