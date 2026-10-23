import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {verifyTrainingCase} from '../src/training/index.js';

function verified(code){
  const result=verifyTrainingCase({source:'"use strict";\nfunction f(){'+code+'}',entry:'f'});
  assert.equal(result.status,'locally_verified',JSON.stringify(result));
  const archive=JSON.parse(JSON.stringify(result.exported.sidecar.archive));
  assert.equal(validateBundle(archive).valid,true);
  assert.equal(replayExact(archive).valid,true);
}

test('Object.is has SameValue signed-zero, NaN and reference identity semantics',()=>{
  verified(`let a={},b={};return [Object.is(0/0,0/0),Object.is(0,-0),
    Object.is(-0,-0),Object.is(a,a),Object.is(a,b),Object.is(undefined,undefined)];`);
});

test('dense Array.includes uses SameValueZero, fromIndex and owned identity',()=>{
  verified(`let a={x:1},b={},rows=[0,-0,0/0,a,1,2];
    return [rows.includes(0/0),rows.includes(0),rows.includes(a),
      rows.includes(b),rows.includes(2,-1),rows.includes(0,-1),
      rows.includes(0,-100),rows.includes(0,1/0),
      rows.includes(2,-0),[].includes(undefined)];`);
});

test('Array.isArray sees nested Proxy array targets without invoking get traps',()=>{
  const script=`let called=0; function read(t,k,r){called=called+1;return 99;}
    let a=[1,2]; let h={get:read};
    let proxy=new Proxy(a,h);let nested=new Proxy(proxy,{});
    let ordinary=new Proxy({x:1},{});
    let yes=Array.isArray(proxy);let also=Array.isArray(nested);
    let no=Array.isArray(ordinary);`;
  const runtime=createRuntime().start(script);
  assert.equal(runtime.drive().kind,'terminated');
  const values=Object.values(runtime.state.envs).flatMap(e=>Object.entries(e.bindings));
  const value=name=>values.find(([k])=>k===name)?.[1]?.token?.value;
  assert.deepEqual(value('yes'),['bool',true]);
  assert.deepEqual(value('also'),['bool',true]);
  assert.deepEqual(value('no'),['bool',false]);
  assert.deepEqual(value('called'),['num',0]);
  const bundle=JSON.parse(JSON.stringify(runtime.exportRun()));
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
});
