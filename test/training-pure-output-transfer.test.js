import test from 'node:test';
import assert from 'node:assert/strict';
import {pureOutputCase,validatePureRequest,comparePureOutcome} from '../tools/pure-output-transfer.mjs';

const property=(key,value)=>({key,value});
const node=(id,properties,extra={})=>({id,kind:'object',properties,...extra});
const outcome=(roots,objects=[],kind='return')=>({kind,graph:{roots,objects}});

test('pure transfer gives the model exact source and initial input without expected state or traces',()=>{
  const frozen={id:'pure',family:'family',sourceCluster:'component:a',split:'test',identityDigest:'abc',slices:['pure-selected'],
    envelope:{request:{program:{source:'"use strict";function run(x){x.n++;return x;}',entry:'run',capabilities:[]},
      invocation:{inputGraph:{roots:[['ref','o0']],objects:[node('o0',[property('n',['num',1])])]},
        receiverValue:['undefined'],completionPolicy:'await-returned-promise'},fixture:{calls:[]},
      controlledSelectionsByRepresentation:{compact:['private teacher text']}}},
    expected:{completion:{kind:'return',value:['ref','o0']},
      state:{roots:[['ref','o0'],['ref','o0']],objects:[node('o0',[property('n',['num',2])])]},
      effects:[],callbacks:[],cleanup:{pendingEffects:0,pendingJobs:0,openHandlers:0}}};
  const result=pureOutputCase(frozen);
  assert.equal(result.envelope.source,frozen.envelope.request.program.source);
  assert.deepEqual(result.envelope.inputGraph.roots,[['ref','o0']]);
  assert.equal(result.envelope.inputGraph.objects[0].properties[0].value[1],1);
  assert.equal(result.expected.graph.objects[0].properties[0].value[1],2);
  assert.equal(JSON.stringify(result.envelope).includes('private teacher'),false);
  assert.equal(result.envelope.expected,undefined);
  assert.equal(result.envelope.fixture,undefined);
  assert.equal(result.envelope.semantic,undefined);
  assert.equal(validatePureRequest(result.envelope),result.envelope);
  assert.throws(()=>validatePureRequest({...result.envelope,expected:result.expected}),/source\/input-only/);
  frozen.envelope.request.program.capabilities.push('api.get');
  assert.throws(()=>pureOutputCase(frozen),/effect-free/);
});

test('pure outcome comparison accepts identity renaming while preserving mutation, aliases and cycles',()=>{
  const expected=outcome([['ref','a'],['ref','a']],[node('a',[property('value',['num',2]),property('self',['ref','a'])])]);
  const actual=outcome([['ref','renamed'],['ref','renamed']],[node('renamed',[property('value',['num',2]),property('self',['ref','renamed'])])]);
  assert.equal(comparePureOutcome(expected,actual,{inputRootCount:1}).correct,true);
  actual.graph.objects[0].properties[0].value=['num',1];
  assert.equal(comparePureOutcome(expected,actual,{inputRootCount:1}).firstDivergence.reason,'value-mismatch');
});

test('pure outcome comparison refuses replacing aliases with copies or collapsing distinct identities',()=>{
  const shared=outcome([['ref','a'],['ref','a']],[node('a',[])]);
  const copies=outcome([['ref','x'],['ref','y']],[node('x',[]),node('y',[])]);
  assert.equal(comparePureOutcome(shared,copies,{inputRootCount:1}).firstDivergence.reason,'alias-or-cycle-mismatch');
  assert.equal(comparePureOutcome(copies,shared,{inputRootCount:1}).firstDivergence.reason,'distinct-identities-collapsed');
});

test('pure outcomes distinguish throws, signed zero, sparse holes, null prototypes and property order',()=>{
  assert.equal(comparePureOutcome(outcome([['num',7]],[],'throw'),outcome([['num',7]]),{inputRootCount:0}).correct,false);
  assert.equal(comparePureOutcome(outcome([['num','-0']]),outcome([['num',0]]),{inputRootCount:0}).correct,false);
  assert.equal(comparePureOutcome(outcome([['num','NaN']]),outcome([['num','NaN']]),{inputRootCount:0}).correct,true);
  const sparse=outcome([['ref','a']],[{id:'a',kind:'array',properties:[property('length',['num',1])]}]);
  const dense=outcome([['ref','a']],[{id:'a',kind:'array',properties:[property('0',['undefined']),property('length',['num',1])]}]);
  assert.equal(comparePureOutcome(sparse,dense,{inputRootCount:0}).firstDivergence.reason,'property-or-hole-mismatch');
  const nullProto=outcome([['ref','a']],[node('a',[],{prototype:null})]);
  assert.equal(comparePureOutcome(nullProto,outcome([['ref','b']],[node('b',[])]),{inputRootCount:0}).firstDivergence.reason,'prototype-mismatch');
  const ordered=outcome([['ref','a']],[node('a',[property('x',['num',1]),property('y',['num',2])])]);
  const swapped=structuredClone(ordered);swapped.graph.objects[0].properties.reverse();
  assert.equal(comparePureOutcome(ordered,swapped,{inputRootCount:0}).firstDivergence.reason,'property-order-or-key-mismatch');
});

test('malformed or extra pure graph state is never treated as an observable success',()=>{
  const expected=outcome([['num',7]]);
  for(const actual of [outcome([['ref','missing']]),outcome([['num',7]],[node('unreachable',[])]),
    {...expected,explanation:'extra'},outcome([['num',7],['num',8]])])
    assert.equal(comparePureOutcome(expected,actual,{inputRootCount:0}).correct,false);
});
