import test from 'node:test';
import assert from 'node:assert/strict';
import {importGraph,realizeGraph,describeGraph,describeOwnedGraph} from '../src/training/graph.js';
import {validatePublishedGraph} from '../src/training/public-graph.js';

function importRoots(roots) {
  const state={heap:{}};
  let sequence=0;
  const encoded=importGraph(state,roots,()=>`o${++sequence}`);
  return {state,encoded};
}

test('holes, present undefined, aliases, cycles and null prototypes round-trip',()=>{
  const sparse=new Array(4);
  sparse[1]=undefined;
  const record=Object.create(null);
  record.array=sparse;
  record.again=sparse;
  record.self=record;
  const {state,encoded}=importRoots([record,record,sparse]);
  const published=describeOwnedGraph(state.heap,encoded);
  assert.equal(validatePublishedGraph(published),true);
  assert.equal(published.objects[0].prototype,null);
  const reconstructed=realizeGraph(state.heap,encoded);
  assert.equal(Object.getPrototypeOf(reconstructed[0]),null);
  assert.equal(reconstructed[0],reconstructed[1]);
  assert.equal(reconstructed[0].array,reconstructed[2]);
  assert.equal(reconstructed[0].self,reconstructed[0]);
  assert.equal(reconstructed[2].length,4);
  assert.equal(0 in reconstructed[2],false);
  assert.equal(1 in reconstructed[2],true);
  assert.equal(reconstructed[2][1],undefined);
  assert.equal(2 in reconstructed[2],false);
  assert.deepEqual(describeGraph(reconstructed).roots,describeGraph([record,record,sparse]).roots);
});

test('unsupported descriptors and rich boundary objects never get silently flattened',()=>{
  const nonwritable={};
  Object.defineProperty(nonwritable,'x',{value:4,writable:false,enumerable:true,configurable:true});
  const nonenumerable={};
  Object.defineProperty(nonenumerable,'x',{value:4,writable:true,enumerable:false,configurable:true});
  const getter={get x(){throw Error('getter must not run')}};
  const instances=[nonwritable,nonenumerable,getter,Object.freeze({x:1}),
    Object.preventExtensions({x:1}),new Date(),Object.create({x:3})];
  for(const object of instances) {
    assert.throws(()=>importRoots([object]),/Unsupported observable boundary/);
    assert.throws(()=>describeGraph([object]),/Unsupported observable boundary/);
  }
});

test('boundary-reachable guest accessors and custom prototypes are rejected',()=>{
  const {state,encoded}=importRoots([{n:1}]);
  state.heap[encoded[0][1]].accessors={n:{get:['ref','any'],set:['undefined']}};
  assert.throws(()=>realizeGraph(state.heap,encoded),/Unsupported observable boundary/);
  assert.throws(()=>describeOwnedGraph(state.heap,encoded),/Unsupported observable boundary/);
  delete state.heap[encoded[0][1]].accessors;
  state.heap[encoded[0][1]].prototype='nonstandard';
  assert.throws(()=>describeOwnedGraph(state.heap,encoded),/Unsupported observable boundary/);
});
