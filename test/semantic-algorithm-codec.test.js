import test from 'node:test';
import assert from 'node:assert/strict';
import {ALGORITHM_VERSION,ALGORITHM_PROFILE} from '../src/semantic/ir.js';
import {OPERATION_REGISTRY,encodeAlgorithmScalar} from '../src/semantic/operations.js';
import {ALGORITHM_TRACE_VERSION,encodeAlgorithmRecord,decodeAlgorithmRecord,
  encodeAlgorithmTerm,encodeAlgorithmValue,validateAlgorithmRecord,algorithmTraceGrammar,
  syntaxOnlyV7Grammar,syntaxOnlyV7ObservationGrammar} from '../src/semantic/trace-codec.js';
import {renderAlgorithmRecord,renderAlgorithmTerm,renderAlgorithm} from '../src/semantic/render-algorithm.js';

const literal=value=>({op:'literal',value:encodeAlgorithmScalar(value)});
const input=id=>({op:'input',id});
const ref=id=>({op:'ref',id});
const add=(a,b)=>({op:'add',args:[a,b]});
const fold={op:'fold_left',input:input('a0'),initial:literal(0),step:'add',
  order:'ascending',profile:'dense-number-array/1'};
const records=[
  {kind:'compute',id:'v0',term:add(input('a0'),literal(1)),result:['num',5]},
  {kind:'compute',id:'v1',term:fold,result:['num',9]},
  {kind:'compute',id:'return',term:{op:'project',object:input('data'),key:'n'},result:['undefined']},
  {kind:'request',id:'r0',boundary:'b0',operation:'demo.readAsync',arguments:[['str','counter']]},
  {kind:'request',id:'r:1',boundary:'boundary-1',operation:'some operation',arguments:[]},
  {kind:'observe',request:'r0',id:'v0',status:'fulfilled',value:['num',7]},
  {kind:'observe',request:'r0',id:'v0',status:'rejected',value:['str','not found']},
  {kind:'observe',request:'r0',id:'v0',status:'completed'},
  {kind:'write',object:['ref','o1'],key:'n',value:['num',2],present:true},
  {kind:'write',object:['ref','o1'],key:'n',value:['undefined'],present:false},
  {kind:'return',value:['num',8]},
  {kind:'throw',value:['str','bad']},
  {kind:'suspend',requests:['r0','r1'],live:['v0']},
  {kind:'suspend',requests:['r0'],live:[]}
];

test('v7 algorithm records have canonical typed round trips and explicit meaning',()=>{
  assert.equal(ALGORITHM_TRACE_VERSION,'semantic-trace/7');
  for(const record of records){
    const line=encodeAlgorithmRecord(record);
    assert.deepEqual(decodeAlgorithmRecord(line),record,line);
    assert.equal(encodeAlgorithmRecord(decodeAlgorithmRecord(line)),line);
  }
  assert.equal(encodeAlgorithmRecord(records[0]),'v0 = add($a0, 1) => 5');
  assert.equal(encodeAlgorithmRecord(records[1]),'v1 = fold_left($a0, 0, add) => 9');
  assert.equal(encodeAlgorithmRecord(records[3]),'request r0 b0: demo.readAsync("counter")');
});

test('scalar spellings preserve signed zero, nonfinite values, bigint, strings and identity',()=>{
  for(const value of [undefined,null,true,false,0,-0,1e21,1e-7,Number.MAX_VALUE,NaN,Infinity,-Infinity,
    123456789012345678901234567890n,'a\n"\\é','\ud800']){
    const record={kind:'return',value:encodeAlgorithmScalar(value)};
    assert.deepEqual(decodeAlgorithmRecord(encodeAlgorithmRecord(record)),record);
  }
  const object={kind:'return',value:['ref','scope:object-1']};
  assert.deepEqual(decodeAlgorithmRecord(encodeAlgorithmRecord(object)),object);
  assert.equal(encodeAlgorithmValue(['num','-0']),'-0');
  assert.equal(encodeAlgorithmValue(['str','undefined']),'"undefined"');
});

test('input, semantic value, object identity, and string dependencies are distinct',()=>{
  for(const term of [input('v0'),ref('v0'),{op:'literal',value:['ref','v0']},literal('v0')]){
    const record={kind:'compute',id:'v1',term,result:['num',1]};
    assert.deepEqual(decodeAlgorithmRecord(encodeAlgorithmRecord(record)).term,term);
  }
  assert.equal(encodeAlgorithmTerm(add(input('a0'),ref('v0'))),'add($a0, %v0)');
});

test('every registry operation uses the same arity in structured and textual claims',()=>{
  for(const [op,definition] of Object.entries(OPERATION_REGISTRY)){
    const term={op,args:Array.from({length:definition.arity},(_,i)=>literal(i))};
    const record={kind:'compute',id:'v0',term,result:['num',0]};
    assert.deepEqual(decodeAlgorithmRecord(encodeAlgorithmRecord(record)),record);
    assert.ok(typeof definition.reading==='string',op+' needs a controlled reading');
    assert.ok(!/\{[0-9]+\}/.test(renderAlgorithmTerm(term)),op+' reading has unsubstituted operands');
    if(op==='void')assert.ok(renderAlgorithmTerm(term).startsWith('undefined'));
    assert.throws(()=>encodeAlgorithmRecord({...record,term:{op,args:[]}}));
  }
});

test('completed observations remain distinct from a fulfilled undefined value',()=>{
  const completed=records.find(row=>row.kind==='observe'&&row.status==='completed');
  const fulfilled={...completed,status:'fulfilled',value:['undefined']};
  assert.notEqual(encodeAlgorithmRecord(completed),encodeAlgorithmRecord(fulfilled));
  assert.throws(()=>encodeAlgorithmRecord({...completed,value:['undefined']}));
  assert.throws(()=>encodeAlgorithmRecord({...completed,status:'fulfilled'}));
  assert.match(renderAlgorithmRecord(completed),/without a returned value/);
  assert.match(renderAlgorithmRecord(fulfilled),/returned undefined/);
});

test('observations cannot enter generated records and predictions cannot impersonate observations',()=>{
  for(const record of records){
    const line=encodeAlgorithmRecord(record),role=record.kind==='observe'?'observed':'generated';
    assert.deepEqual(decodeAlgorithmRecord(line,{role}),record);
    assert.throws(()=>decodeAlgorithmRecord(line,{role:role==='generated'?'observed':'generated'}));
  }
  assert.throws(()=>validateAlgorithmRecord(records[0],{role:'teacher'}));
});

test('malformed, alternate spellings and previous formats fail closed',()=>{
  for(const line of [
    'return 1.0','return 01','return 1e0','return 1E+21','return -0n','return 1e999',
    'return +1','return true ',' return true','return 1\nreturn 2','return "\\u0061"',
    'v0=add($a0, 1) => 2','v0 = add($a0,1) => 2','v0 = add(1) => 2',
    'v0 = unknown(1) => 2','v0 = fold_left($a0, 0, multiply) => 0',
    'observe r0 as v0: fulfilled','observe r0 as v0: completed undefined',
    'request r0 b0: demo.store("counter", 8) payload ["counter",8]',
    'evaluate run(1) => 2','compute (a + 1) => 2','{"kind":"return","value":["num",1]}',
    'suspend [] live []','suspend [r0, r0] live []'
  ])assert.throws(()=>decodeAlgorithmRecord(line),line);
});

test('record schema refuses source transport fields and malformed claims',()=>{
  for(const extra of [{site:{start:1,end:2}},{payload:'["counter"]'},{invocation:'f1'},
    {future:['num',7]}])assert.throws(()=>encodeAlgorithmRecord({...records[3],...extra}));
  for(const record of [
    {...records[0],result:['num',-0]}, {...records[0],result:['num',NaN]},
    {...records[0],term:{...fold,order:'descending'}},
    {...records[0],term:{...fold,profile:'unchecked/1'}},
    {...records[0],id:'has space'}, {...records[3],arguments:[['num',1],,]},
    {kind:'write',object:['num',1],key:'x',value:['num',2],present:true},
    {kind:'write',object:['ref','o1'],key:'__proto__',value:['null'],present:true}
  ])assert.throws(()=>encodeAlgorithmRecord(record));
});

test('parser budgets reject oversized or cyclic expressions before evaluation',()=>{
  const cycle={op:'negate',args:[]};cycle.args.push(cycle);
  assert.throws(()=>encodeAlgorithmRecord({...records[0],term:cycle}),/budget/);
  assert.throws(()=>decodeAlgorithmRecord('v0 = '+'negate('.repeat(70)+'1'+')'.repeat(70)+' => 1'),/budget/);
  assert.throws(()=>decodeAlgorithmRecord('return "'+'x'.repeat(65536)+'"'),/budget/);
});

test('controlled readings expose fold order, arithmetic structure and effect roles',()=>{
  assert.match(renderAlgorithmRecord(records[1]),/Starting at 0.*ascending index order.*result is 9/);
  const compound={op:'multiply',args:[add(input('a0'),input('a1')),add(input('a2'),input('a3'))]};
  const reading=renderAlgorithmTerm(compound);
  assert.match(reading,/product/);assert.match(reading,/sum/);assert.match(reading,/input a3/);
  assert.match(renderAlgorithmRecord(records[3]),/demo.readAsync.*counter.*boundary b0/);
  assert.match(renderAlgorithmRecord(records[5]),/environment.*returned 7/);
  assert.match(renderAlgorithmRecord(records[6]),/rejected with/);
  assert.match(renderAlgorithmRecord(records[9]),/Remove.*field/);
});

test('program readings contain dependencies and causal waits without inventing future results',()=>{
  const core={schema:ALGORITHM_VERSION,profile:ALGORITHM_PROFILE,inputs:[{id:'a0',type:'scalar'}],steps:[
    {kind:'request',id:'r0',boundary:'b0',operation:'demo.readAsync',arguments:[input('a0')]},
    {kind:'observe',request:'r0',id:'v0'},
    {kind:'compute',id:'v1',term:add(ref('v0'),literal(1))},
    {kind:'return',value:ref('v1')}
  ]};
  const reading=renderAlgorithm(core);
  assert.match(reading,/input a0/);assert.match(reading,/Wait for the environment/);
  assert.match(reading,/value v0/);assert.match(reading,/Return value v1/);
  assert.ok(!reading.includes('result is'));
});

test('generated grammar excludes observations and shares operation names and arities',()=>{
  const generated=syntaxOnlyV7Grammar(),observed=syntaxOnlyV7ObservationGrammar();
  assert.ok(!generated.split('\n')[0].includes('observation'));
  assert.equal(observed.split('\n')[0],'root ::= observation');
  assert.ok(algorithmTraceGrammar({role:'any'}).split('\n')[0].includes('observation'));
  for(const op of Object.keys(OPERATION_REGISTRY))assert.ok(generated.includes('"'+op+'"'));
  assert.ok(!generated.includes('payload'));
  assert.throws(()=>algorithmTraceGrammar({role:'teacher'}));
});
