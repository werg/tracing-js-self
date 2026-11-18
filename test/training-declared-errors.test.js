import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission} from '../src/training/effectful-admit.js';
import {verifyOwnedSourceCase,recheckOwnedSourceEvidence} from '../src/training/source-check.js';
import {describeCompletionGraph,DECLARED_EXCEPTION_PROFILE} from '../src/training/exception-profile.js';

const cases=[
  ['function run(){throw new Error("bad");}','Error','bad'],
  ['function run(){throw new TypeError(7);}','TypeError','7'],
  ['function run(){throw new Error();}','Error',''],
  ['function run(){throw new Error(undefined);}','Error',''],
  ['function run(){try{return 7;}finally{throw new Error("cleanup");}}','Error','cleanup'],
  ['function fail(){throw new Error("nested");}function run(){return fail();}','Error','nested'],
  ['function fail(){throw new Error("default");}function f(a=fail()){return a;}function run(){return f();}','Error','default']
];

test('declared Error and TypeError throws qualify under explicit name/message observation profile',async()=>{
  for(const [code,name,message] of cases){
    const source='"use strict";'+code;
    const checked=await verifyEffectfulTrainingCase({source,entry:'run',family:'declared-error',fixture:{calls:[]}});
    assert.equal(checked.status,'locally_verified',code+': '+checked.reason);
    assert.equal(checked.exported.sidecar.compiler.exceptionProfile,DECLARED_EXCEPTION_PROFILE);
    assert.equal(checked.exported.sidecar.reference.exceptionProfile,DECLARED_EXCEPTION_PROFILE);
    assert.deepEqual(checked.exported.sidecar.reference.outcome,{kind:'throw',graph:{roots:[['ref','o0']],
      objects:[{id:'o0',kind:'object',properties:[['name',['str',name]],['message',['str',message]]]}]}});
    assert((await recheckEffectfulAdmission(checked.exported,{requireAdmitted:false})).sourceValidated);
    const pure=verifyOwnedSourceCase({source,entry:'run'});
    assert.equal(pure.status,'locally_verified',pure.reason);
    assert.equal(recheckOwnedSourceEvidence(pure.exported).valid,true);
  }
});

test('catch reads and identity comparisons on declared errors are source checked',()=>{
  for(const body of [
    'try{throw new TypeError("bad");}catch(e){return [e.name,e.message,e===e];}',
    'try{throw 7;}finally{throw 9;}',
    'try{throw 7;}finally{return 9;}'
  ]){
    const checked=verifyOwnedSourceCase({source:'"use strict";function run(){'+body+'}',entry:'run'});
    assert.equal(checked.status,'locally_verified',checked.reason);
  }
});

test('error extensions, prototypes, mutation and coercion remain explicit refusals',()=>{
  for(const body of [
    'const e=new Error("x");return Object.keys(e);',
    'const e=new Error("x");return Object.hasOwn(e,"name");',
    'const e=new Error("x");return Object.getPrototypeOf(e);',
    'const e=new Error("x");return e.stack;',
    'const e=new Error("x");e.name="Other";throw e;',
    'const e=new Error("x");return e+"";',
    'throw new Error("x",{cause:7});',
    'throw new Error({});'
  ]){
    const checked=verifyOwnedSourceCase({source:'"use strict";function run(){'+body+'}',entry:'run'});
    assert.notEqual(checked.status,'locally_verified',body);
  }
  assert.throws(()=>describeCompletionGraph([],new Error('x',{cause:7}),'throw'),/Error extensions/);
  const error=new Error('x');Object.defineProperty(error,'message',{get(){throw new Error('must not execute');}});
  assert.throws(()=>describeCompletionGraph([],error,'throw'),/message descriptor/);
  class CustomError extends Error{}
  assert.throws(()=>describeCompletionGraph([],new CustomError('x'),'throw'),/custom Error prototype/);
});

test('exception observations never format lazy stacks or invoke error accessors',()=>{
  const prepareStackTrace=Object.getOwnPropertyDescriptor(Error,'prepareStackTrace');
  let formatted=0,messageReads=0,stackReads=0;
  // Node 20 also materializes the previous stack when redefining it. Prepare
  // that fixture before the hook so only the observation itself is measured.
  const accessorStack=new Error('kept');
  Object.defineProperty(accessorStack,'stack',{get(){stackReads++;throw new Error('stack getter must not execute');}});
  Object.defineProperty(Error,'prepareStackTrace',{configurable:true,writable:true,value(){
    formatted++;
    throw new Error('stack formatting must not execute');
  }});
  try{
    const expected={roots:[['ref','o0']],objects:[{id:'o0',kind:'object',
      properties:[['name',['str','Error']],['message',['str','kept']]]}]};
    assert.deepEqual(describeCompletionGraph([],new Error('kept'),'throw'),expected);
    assert.deepEqual(describeCompletionGraph([],accessorStack,'throw'),expected);
    const accessorMessage=new Error('kept');
    Object.defineProperty(accessorMessage,'message',{get(){messageReads++;throw new Error('message getter must not execute');}});
    assert.throws(()=>describeCompletionGraph([],accessorMessage,'throw'),/message descriptor/);
    assert.deepEqual({formatted,messageReads,stackReads},{formatted:0,messageReads:0,stackReads:0});
  }finally{
    if(prepareStackTrace)Object.defineProperty(Error,'prepareStackTrace',prepareStackTrace);
    else delete Error.prepareStackTrace;
  }
});
