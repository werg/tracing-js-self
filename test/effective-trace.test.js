import test from 'node:test';
import assert from 'node:assert/strict';
import {semanticLine,decodeRecord,encodeRecord,renderRecord} from '../src/training/format.js';
import {verifyTrainingCase} from '../src/training/admit.js';
test('source decisions describe executed tests, not jump polarity',()=>{
  const run=verifyTrainingCase({source:'"use strict";function f(x){if(x>10)return 1;return 0;}',
    entry:'f',args:[12]});
  assert.equal(run.status,'locally_verified',JSON.stringify(run));
  const line=run.exported.public.groups.map(g=>g.events[0].record)
    .find(x=>x.startsWith('branch '));
  assert(line);
  const {fields}=decodeRecord(line);
  assert.deepEqual(fields.test,['bool',true]);
  assert.equal(fields.path,'then');
  assert(!Object.hasOwn(fields,'decision'));
  assert(!Object.hasOwn(fields,'successor'));
});
test('effective accessor read and call require no engine descriptor dump',()=>{
  const line=encodeRecord('read',{id:'e1',site:'s1',invocation:'f1',
    result:['num',7],reads:[{kind:'effective',receiver:'o',key:'total',value:['num',7]}]});
  assert.equal(renderRecord(line,{text:'o.total',sites:[{id:'s1',start:0,end:7}]}),
    'read o.total -> 7');
  const call=semanticLine({id:'e2',op:'call',invocation:'f1',site:'s1',
    dependsOn:['e1'],control:null,result:null,reads:[],writes:[],
    child:'f2',code:'c2',receiver:['ref','o'],arguments:[],captures:null});
  assert.equal(decodeRecord(call).kind,'call');
  assert(!call.includes('arithmetic'));
});
test('version-one internal instruction fields cannot enter the sole format',()=>{
  assert.throws(()=>encodeRecord('branch',{id:'e1',decision:false,successor:5}),/Unexpected/);
  assert.throws(()=>encodeRecord('value',{id:'e1',arithmetic:{algorithm:'internal'}}),/Unexpected/);
});