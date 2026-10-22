import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {materializeJson,JSON_CODEC} from '../src/host/materialize.js';

function fixture(source,names) {
  const r=createRuntime().start(source);
  assert.equal(r.drive().kind,'terminated');
  const args=names.map(name=>Object.values(r.state.envs)
    .find(e=>e.bindings[name]).bindings[name].token.value);
  return {r,args};
}

test('external JSON materializer preserves data, property order and frozen version provenance',()=>{
  const {r,args}=fixture('let a=[1,2]; let o={z:3,a:a};',['o']);
  const json=materializeJson(r.state.heap,args);
  assert.equal(json.codec,JSON_CODEC);
  assert.equal(json.payload,'[{"z":3,"a":[1,2]}]');
  assert.equal(json.byteLength,Buffer.byteLength(json.payload));
  assert(Object.isFrozen(json));
  assert(Object.isFrozen(json.graphVersions));
  assert(Object.isFrozen(json.graphVersions[0]));
  const original=json.payload;
  const modified=fixture('let o={z:4};',['o']);
  assert.equal(json.payload,original,'materialized bytes cannot change with other heap mutations');
  assert.equal(materializeJson(modified.r.state.heap,modified.args).payload,'[{"z":4}]');
});

test('external JSON materializer rejects all unimplemented coercions and unsupported graphs',()=>{
  const cycle=fixture('let x={};x.self=x;',['x']);
  assert.throws(()=>materializeJson(cycle.r.state.heap,cycle.args),/Cycles/);
  const alias=fixture('let a={x:1};',['a','a']);
  assert.throws(()=>materializeJson(alias.r.state.heap,alias.args),/Aliases/);
  const spare=fixture('let a=[1,2];a.length=5;',['a']);
  assert.throws(()=>materializeJson(spare.r.state.heap,spare.args),/dense/);
  for(const value of [
    ['undefined'],['bigint','2'],['num','NaN'],['num','-0'],
    ['num','+Infinity'],['host','demo'],['promise','p1']
  ])assert.throws(()=>materializeJson({},[value]),/codec|number/i);
});

test('external JSON materializer enforces byte and graph-size bounds',()=>{
  const obj=fixture('let a=[1,2,3,4];',['a']);
  assert.throws(()=>materializeJson(obj.r.state.heap,obj.args,{maxNodes:2}),/array length limit/);
  assert.throws(()=>materializeJson(obj.r.state.heap,obj.args,{maxBytes:3}),/payload limit/);
});
