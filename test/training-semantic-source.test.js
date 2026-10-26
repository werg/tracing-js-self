import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
import {EFFECTFUL_ENGINEERING_FIXTURES} from '../src/training/engineering-fixtures.js';
import {decodeWitness} from '../src/training/format.js';
import {sourceLinkedComputation,sourceLinkedDecision} from '../src/training/semantic-source.js';
import {verifyOwnedSourceCase,recheckOwnedSourceEvidence} from '../src/training/source-check.js';

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
  assert(trace.filter(record=>['compute','choose'].includes(record.kind))
    .every(record=>!Object.hasOwn(record.fields,'site')),
    'pure reasoning should not force prediction of interpreter source coordinates');
  assert(trace.filter(record=>record.kind==='request')
    .every(record=>Number.isSafeInteger(record.fields.site?.start)),
    'effect dispatch still needs a grounded, authorized source callsite');
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

test('grounded property values are temporal and require a committed own data slot',()=>{
  let value=['num',4],own=true;
  const ctx={
    locals:new Map([['object',['ref','o1']]]),
    resolveLocal:name=>name==='object'?{name,value:['ref','o1']}:null,
    hasOwnData:(identity,key)=>own&&identity==='o1'&&key==='n',
    readProperty:()=>value
  };
  const member={type:'MemberExpression',computed:false,optional:false,
    object:identifier('object'),property:identifier('n')};
  assert.deepEqual(sourceLinkedDecision(member,['num',4],ctx),{
    op:'read',object:'o1',key:'n'});
  value=['num',7]; // Committed mutation; the earlier ground value is not re-evaluated.
  assert.equal(sourceLinkedDecision(member,['num',4],ctx),null,
    'stale values must not be projected from a future changed heap');
  assert.deepEqual(sourceLinkedDecision(member,['num',7],ctx),{
    op:'read',object:'o1',key:'n'});
  own=false;
  assert.equal(sourceLinkedDecision(member,['num',7],ctx),null,
    'missing/getter/inherited properties are not a pure-data read');
});

test('repeated callback parameters are separate source cells; captures stay shared',async()=>{
  const fixture=EFFECTFUL_ENGINEERING_FIXTURES.find(item=>item.id==='callback-captured-write');
  const result=await verifyEffectfulTrainingCase({...fixture,
    projectionOptions:{representation:'compact'}});
  assert.equal(result.status,'locally_verified',result.reason);
  const trace=decoded(result.exported),seen=trace.filter(row=>row.kind==='compute'&&
    row.fields.bind==='seen');
  assert.equal(seen.length,2,'each callback updates the same captured source cell');
  assert.deepEqual(seen.map(row=>row.fields.result),[['num',3],['num',7]]);
  assert.deepEqual(seen.map(row=>row.fields.expr.right.name),['n','n_1'],
    'source param spelling is preserved and disambiguated for each callback');
  assert.equal(trace.filter(row=>row.kind==='request'&&
    row.fields.operation==='demo.store').length,3);
});

test('actual property choices follow prior writes and helper calls retain source names',()=>{
  const result=verifyOwnedSourceCase({source:'"use strict"; function helper(value){return value+1;} '+
    'function run(box){if(box.count>3){box.count=2;} if(box.count>3){return 0;} return helper(box.count);}',
    entry:'run',args:[{count:4}]});
  assert.equal(result.status,'locally_verified',result.reason);
  assert.equal(recheckOwnedSourceEvidence(result.exported).valid,true);
  const trace=decoded(result.exported),choices=trace.filter(row=>row.kind==='choose');
  assert.deepEqual(choices.map(row=>row.fields.decision),[['bool',true],['bool',false]]);
  const reads=choices.map(row=>row.fields.expr.left);
  assert.equal(reads[0].op,'read');
  assert.deepEqual(reads[0],reads[1],'both choices refer to the same persistent own slot');
  const writeIndex=trace.findIndex(row=>row.kind==='write'&&row.fields.key==='count');
  const choiceIndices=trace.flatMap((row,index)=>row.kind==='choose'?[index]:[]);
  assert(choiceIndices[0]<writeIndex&&writeIndex<choiceIndices[1]);
  assert.deepEqual(trace[writeIndex].fields.value,['num',2]);
  assert.equal(trace.find(row=>row.kind==='call').fields.callee,'helper');
});
