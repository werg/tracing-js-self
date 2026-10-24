import test from 'node:test';
import assert from 'node:assert/strict';
import {attemptOwnedAjvGeneratedValidator}
 from '../src/corpus/ajv-owned.mjs';
import {recheckIndependentTrainingEvidence} from '../src/training/admit.js';

const generated='function validate(data){return typeof data === "string";}';
const validator=Object.assign(function validate(data){
 return typeof data==='string';
},{source:{validateCode:generated,scopeValues:{}}});

test('generated validator requires owned V8/operation/branch/replay evidence',()=>{
 for(const [data,observedResult] of [['hi',true],[5,false]]){
  const {row,exported}=attemptOwnedAjvGeneratedValidator({
   validator,data,observedResult,originalId:'fixture'});
  assert.equal(row.admitted,false);
  assert.equal(row.schema,'ajv-generated-owned-attempt/1');
  if(row.status==='locally_verified'){
   assert.equal(row.verifiedOwned,true);
   assert.equal(row.evidence.modelVisibleSchema,'semantic-execution/2');
   assert.equal(recheckIndependentTrainingEvidence(exported).valid,true);
  }else{
   assert.equal(row.verifiedOwned,false);
   assert.equal(exported,null);
   assert(row.reason);
  }
 }
});

test('native Ajv output disagreement never becomes owned verification',()=>{
 const {row,exported}=attemptOwnedAjvGeneratedValidator({
  validator,data:'hi',observedResult:false});
 assert.equal(row.verifiedOwned,false);
 assert.equal(row.admitted,false);
 assert.equal(exported,null);
});

test('captured Ajv scope and mismatched generated function names refuse',()=>{
 const withScope=Object.assign(function validate(data){return data;},{
  source:{validateCode:'function validate(data){return keyword0 === data;}',
   scopeValues:{keyword:new Map()}}});
 let result=attemptOwnedAjvGeneratedValidator({
  validator:withScope,data:7,observedResult:true});
 assert.equal(result.row.status,'unsupported');
 assert.match(result.row.reason,/captured native scope/);
 const wrong=Object.assign(function elsewhere(){return true;},{
  source:{validateCode:generated}});
 result=attemptOwnedAjvGeneratedValidator({
  validator:wrong,data:7,observedResult:true});
 assert.equal(result.row.status,'unsupported');
 assert.equal(result.row.verifiedOwned,false);
 const unused=Object.assign(function validate(data){return typeof data==='string';},{
  source:{validateCode:generated,scopeValues:{keyword:new Map()}}});
 const check=attemptOwnedAjvGeneratedValidator({
  validator:unused,data:'yes',observedResult:true});
 assert.notEqual(check.row.reason,'Ajv generated function requires captured native scope');
});

test('malformed or multi-definition generated code is rejected before execution',()=>{
 for(const code of [
  'function validate(data){',
  'function validate(data){return true;} function extra(){}',
  'const validate = (data) => true;',
  'function validate(data){return true;} validate();'
 ]){
  const suspect=Object.assign(function validate(){return true;},{
   source:{validateCode:code}});
  const {row,exported}=attemptOwnedAjvGeneratedValidator({
   validator:suspect,data:{},observedResult:true});
  assert.equal(row.status,'unsupported');
  assert.equal(exported,null);
 }
});


test('Ajv omitted optional context is lowered only with audited pure defaults',()=>{
 const standard='function validate(data, {instancePath="", parentData, parentDataProperty, rootData=data}={}) {return typeof data === "string";}';
 const compiled=Object.assign(function validate(data){return typeof data==='string';},{
  source:{validateCode:standard,scopeValues:{}}});
 const {row,exported}=attemptOwnedAjvGeneratedValidator({
  validator:compiled,data:'abc',observedResult:true});
 assert.equal(row.projection,'ajv-omitted-context-pure-defaults/1');
 assert.match(row.originalBodySha256,/^[a-f0-9]{64}$/);
 assert.equal(row.admitted,false);
 if(row.verifiedOwned){
  assert.equal(row.status,'locally_verified');
  assert.equal(recheckIndependentTrainingEvidence(exported).valid,true);
 }else{
  assert.equal(exported,null);
  assert(row.reason);
 }
 const dangerous=standard.replace('rootData=data','rootData=host.call()');
 const unsafe=Object.assign(function validate(){return true;},{
  source:{validateCode:dangerous}});
 const denied=attemptOwnedAjvGeneratedValidator({
  validator:unsafe,data:'abc',observedResult:true});
 assert.equal(denied.row.status,'unsupported');
 assert.equal(denied.exported,null);
});
