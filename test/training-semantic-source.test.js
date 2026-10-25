import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
import {EFFECTFUL_ENGINEERING_FIXTURES} from '../src/training/engineering-fixtures.js';
import {decodeWitness} from '../src/training/format.js';
import {sourceLinkedComputation,sourceLinkedDecision} from '../src/training/semantic-source.js';

const decoded=exported=>exported.public.timeline.filter(row=>row.kind==='semantic')
  .map(row=>decodeWitness(row.line));
const scope=(names={})=>({
  locals:new Map(Object.entries(names)),
  resolveLocal:name=>Object.hasOwn(names,name)?{name,value:names[name]}:null,
  hasOwnData:()=>false,readProperty:()=>{throw Error('unexpected read');}
});
const identifier=name=>({type:'Identifier',name});

test('source-linked arithmetic needs a matching committed binding, not a name guess',()=>{
  const node={type:'BinaryExpression',operator:'+',left:identifier('current'),
    right:{type:'Literal',value:1}};
  const raw={op:'binary',operator:'+',left:{op:'literal',value:['num',7]},
    right:{op:'literal',value:['num',1]}};
  assert.deepEqual(sourceLinkedComputation(raw,node,scope({current:['num',7]})),{
    ...raw,left:{op:'local',name:'current'}
  });
  assert.deepEqual(sourceLinkedComputation(raw,node,scope({current:['num',9]})),raw,
    'a differently valued binding cannot masquerade as the source operand');
  assert.deepEqual(sourceLinkedComputation(raw,node,scope()),raw,
    'a name cannot invent a future value');
});

test('source-linked choice lowers only checked, pure conditions',()=>{
  const cond={type:'IfStatement',test:{type:'BinaryExpression',operator:'>',
    left:identifier('count'),right:{type:'Literal',value:3}}};
  assert.deepEqual(sourceLinkedDecision(cond,['bool',true],scope({count:['num',8]})),{
    op:'binary',operator:'>',left:{op:'local',name:'count'},
    right:{op:'literal',value:['num',3]}
  });
  assert.equal(sourceLinkedDecision(cond,['bool',true],scope({count:['num',2]})),null);
  assert.equal(sourceLinkedDecision({type:'CallExpression',callee:identifier('sideEffect'),arguments:[]},
    ['bool',true],scope()),null);
  assert.equal(sourceLinkedDecision({type:'UpdateExpression',operator:'++',argument:identifier('count')},
    ['num',9],scope({count:['num',8]})),null);
});

test('teacher traces retain source variable names, correct effects and outcome',async()=>{
  const fixture=EFFECTFUL_ENGINEERING_FIXTURES.find(item=>item.id==='counter-0');
  const result=await verifyEffectfulTrainingCase({...fixture,
    projectionOptions:{representation:'compact'}});
  assert.equal(result.status,'locally_verified',result.reason);
  const trace=decoded(result.exported),names=new Set(trace.flatMap(record=>
    record.kind==='bind'?[record.fields.name]:
      record.kind==='compute'&&record.fields.bind?[record.fields.bind]:[]));
  assert(names.has('current'),'awaited value should retain its source name');
  assert(names.has('next'),'computed value should retain its source name');
  assert(trace.some(record=>record.kind==='compute' &&
    record.fields.expr.op==='binary'&&record.fields.expr.left.op==='local'&&
    record.fields.expr.left.name==='current'),'the computation should refer to current');
  const store=trace.find(record=>record.kind==='request' &&
    record.fields.operation==='demo.store');
  assert.deepEqual(store.fields.arguments,[['str','counter'],['num',8]]);
  assert(trace.some(record=>record.kind==='end'&&record.fields.kind==='return'));
});

test('the branch choice is semantically grounded without erasing an effect',async()=>{
  const fixture=EFFECTFUL_ENGINEERING_FIXTURES.find(item=>item.id==='branch-1');
  const result=await verifyEffectfulTrainingCase({...fixture,
    projectionOptions:{representation:'compact'}});
  assert.equal(result.status,'locally_verified',result.reason);
  const trace=decoded(result.exported),choice=trace.find(record=>record.kind==='choose');
  assert(choice);
  assert.equal(choice.fields.decision[0],'bool');
  assert(trace.some(record=>record.kind==='request'&&record.fields.operation==='demo.store'));
  assert(!trace.some(record=>record.kind==='bind'&&/^cell[0-9]+$/.test(record.fields.name)),
    'opaque VM cell names should not appear in new witnesses');
});
