import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';

test('ordinary data definitions apply false defaults and preserve omitted descriptor fields',()=>{
  runtimeDifferential('const o={};Object.defineProperty(o,"x",{value:4});Object.defineProperty(o,"x",{});const d=Object.getOwnPropertyDescriptor(o,"x");return [o.x,d.writable,d.enumerable,d.configurable,Object.keys(Object.assign({},o))];');
  runtimeDifferential('const o={x:1};Object.defineProperty(o,"x",{value:2});const d=Object.getOwnPropertyDescriptor(o,"x");return [o.x,d.writable,d.enumerable,d.configurable];');
  runtimeDifferential('const o={};Object.defineProperty(o,"constructor",{value:3});Object.defineProperty(o,"__proto__",{value:5});return [o.constructor,o.__proto__,Object.getOwnPropertyNames(o)];');
});

test('nonconfigurable data definitions preserve SameValue and reject incompatible changes',()=>{
  runtimeDifferential('const o={};Object.defineProperty(o,"x",{value:-0});Object.defineProperty(o,"x",{value:-0});let error="";try{Object.defineProperty(o,"x",{value:0});}catch(e){error=e.name;}return [1/o.x,error];');
  runtimeDifferential('const o={};Object.defineProperty(o,"x",{value:NaN});Object.defineProperty(o,"x",{value:NaN});let errors="";try{Object.defineProperty(o,"x",{writable:true});}catch(e){errors+=e.name;}try{Object.defineProperty(o,"x",{enumerable:true});}catch(e){errors+=e.name;}return [Number.isNaN(o.x),errors];');
  runtimeDifferential('const o={};Object.defineProperty(o,"x",{value:2,configurable:true});Object.defineProperty(o,"x",{value:4});return [o.x,Object.getOwnPropertyDescriptor(o,"x").writable];');
});

test('prototype-named data descriptor flags survive subsequent steps and archive serialization',()=>{
  runtimeDifferential('const o={};Object.defineProperty(o,"__proto__",{value:3});const d=Object.getOwnPropertyDescriptor(o,"__proto__");return [d.value,d.writable,d.enumerable,d.configurable,Object.keys(o)];');
  runtimeDifferential('const o={};Object.defineProperty(o,"__proto__",{value:3});let error="";try{Object.defineProperty(o,"__proto__",{value:4});}catch(e){error=e.name;}return [o.__proto__,error];');
});

test('configurable accessors and data definitions change kind without calling the old getter',()=>{
  runtimeDifferential('let calls=0;const o={};Object.defineProperty(o,"x",{get:()=>{calls++;return 1;},configurable:true});Object.defineProperty(o,"x",{value:4});return [o.x,calls,Object.getOwnPropertyDescriptor(o,"x").writable];');
  runtimeDifferential('const o={};Object.defineProperty(o,"x",{value:2,configurable:true,enumerable:false});Object.defineProperty(o,"x",{get:()=>7});const d=Object.getOwnPropertyDescriptor(o,"x");return [o.x,d.enumerable,d.configurable,Object.keys(o)];');
  runtimeDifferential('const o={};Object.defineProperty(o,"x",{get:()=>1});let error="";try{Object.defineProperty(o,"x",{value:4});}catch(e){error=e.name;}return [o.x,error];');
});

test('distinct Symbol data descriptors pass source, metadata and public checkpoint rechecks',async()=>{
  const result=await verifyProtocolRegionTrainingCase({source:'"use strict";function run(x){const a=Symbol(x),b=Symbol(x);const object={};Object.defineProperty(object,a,{value:1});Object.defineProperty(object,b,{value:2});return [a===b,object[a],object[b]];}',
    entry:'run',args:[3],family:'symbol-data-descriptors'});
  assert(result.exported,result.reason);
  const controller=RegionExecutionHarness.replay(result.exported).controller;
  assert.deepEqual(controller.materialize(controller.completion.value),[false,1,2]);
  assert.equal((await recheckProtocolRegionEvidence(result.exported)).sourceValidated,true);
  assert.equal(result.exported.sidecar.sourceArtifact.sidecar.reference.metadataAudit.status,'agreed');
});

test('prototype-named data descriptors retain independent flags through source and public checkpoint rechecks',async()=>{
  const result=await verifyProtocolRegionTrainingCase({source:'"use strict";function run(){const object={};Object.defineProperty(object,"__proto__",{value:3});return object.__proto__;}',
    entry:'run',args:[],family:'prototype-named-data-descriptor'});
  assert(result.exported,result.reason);
  const replay=RegionExecutionHarness.replay(result.exported),restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(replay.checkpoint()))),
    node=[...restored.controller.heap.values()].find(node=>node.descriptors?.has('__proto__'));
  assert.deepEqual(restored.controller.completion,{kind:'return',value:['num',3]});
  assert.deepEqual(node.descriptors.get('__proto__'),{kind:'data',writable:false,enumerable:false,configurable:false});
  assert.equal((await recheckProtocolRegionEvidence(result.exported)).sourceValidated,true);
  assert.equal(result.exported.sidecar.sourceArtifact.sidecar.reference.metadataAudit.status,'agreed');
});
