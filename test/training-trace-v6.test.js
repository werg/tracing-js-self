import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  WITNESS_VERSION,CONTEXT_VERSION,EXECUTION_VERSION,CONTINUATION_VERSION,
  WITNESS_KINDS,encodeWitness,decodeWitness,fragmentWitness,restoreWitness
} from '../src/training/format.js';

// This checked-in corpus is also consumed by the independent native parser.
// Expected byte strings are explicit fixtures, not output from the writer.
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/semantic-trace-v6.json',import.meta.url),'utf8'));

test('the V6 model grammar and every enclosing trace contract move together',()=>{
  assert.equal(WITNESS_VERSION,fixtures.schema);
  assert.deepEqual([WITNESS_VERSION,CONTEXT_VERSION,EXECUTION_VERSION,CONTINUATION_VERSION],
    ['semantic-trace/6','semantic-context/6','semantic-execution/6','semantic-continuation/6']);
  assert.deepEqual(new Set(fixtures.canonical.map(row=>row.kind)),new Set(WITNESS_KINDS));
});

for(const row of fixtures.canonical)test('V6 canonical bytes: '+row.name,()=>{
  assert.equal(encodeWitness(row.kind,row.fields),row.line);
  assert.deepEqual(decodeWitness(row.line),{kind:row.kind,fields:row.fields});
});

test('V6 refuses old JSON records, aliases, missing fields and ambiguous syntax',()=>{
  for(const line of fixtures.invalid)assert.throws(()=>decodeWitness(line),
    /Invalid semantic-trace\/6/,JSON.stringify(line));
});

test('record field insertion order cannot change production bytes',()=>{
  for(const row of fixtures.canonical){
    const reversed=Object.fromEntries(Object.entries(row.fields).reverse());
    assert.equal(encodeWitness(row.kind,reversed),row.line,row.name);
  }
});

test('optional absence and explicitly empty data remain different claims',()=>{
  const closure={name:'c1',kind:'closure',properties:[],code:'main'};
  const without=encodeWitness('allocate',closure);
  const withEmpty=encodeWitness('allocate',{...closure,captures:[]});
  assert.notEqual(without,withEmpty);
  assert.equal(Object.hasOwn(decodeWitness(without).fields,'captures'),false);
  assert.deepEqual(decodeWitness(withEmpty).fields.captures,[]);
  const graph={roots:[],objects:[]};
  assert.notEqual(encodeWitness('input',{graph}),encodeWitness('input',{graph,retained:[]}));
});

test('every binary and unary expression operator has an unambiguous parse',()=>{
  const left={op:'literal',value:['num',-1]},right={op:'local',name:'x'};
  for(const operator of ['+','-','*','/','%','**','<','<=','>','>=','===','!==','==','!=',
    '&','|','^','<<','>>','>>>']){
    const fields={expr:{op:'binary',operator,left,right},result:['num',6]};
    assert.deepEqual(decodeWitness(encodeWitness('compute',fields)).fields,fields);
  }
  for(const operator of ['!','+','-','~','typeof','void']){
    const fields={expr:{op:'unary',operator,arg:left},result:['num',6]};
    assert.deepEqual(decodeWitness(encodeWitness('compute',fields)).fields,fields);
  }
});

test('expression names and scalar keywords never share a spelling',()=>{
  for(const name of ['undefined','null','true','false','NaN','Infinity']){
    const fields={expr:{op:'local',name},result:['num',1]};
    assert.equal(encodeWitness('compute',fields),'compute local('+JSON.stringify(name)+') => 1');
    assert.deepEqual(decodeWitness(encodeWitness('compute',fields)).fields,fields);
  }
  for(const name of ['random','local','trueValue','NaNValue','éclair','$value']){
    const fields={expr:{op:'local',name},result:['num',1]};
    assert.equal(encodeWitness('compute',fields),'compute '+name+' => 1');
    assert.deepEqual(decodeWitness(encodeWitness('compute',fields)).fields,fields);
  }
});

test('summary profiles require exactly their own semantic relations',()=>{
  const pure={entry:'twice',arguments:[['num',3]],result:['num',6],profile:'pure-helper/1'};
  for(const extra of [{decisions:[]},{iterations:0},{accumulator:'total'},
    {inputUnchanged:true},{site:{start:0,end:1}}])
    assert.throws(()=>encodeWitness('summarize',{...pure,...extra}));
  for(const fields of [
    {...pure,profile:'pure-control-helper/1'},
    {...pure,profile:'pure-control-helper/1',decisions:[]},
    {...pure,profile:'pure-control-helper/1',decisions:[{site:{start:0,end:1},selected:'then'}]},
    {...pure,profile:'dense-array-sum/1'},
    {...pure,profile:'dense-array-sum/1',iterations:1,accumulator:'total',decisions:[]},
    {...pure,profile:'dense-array-sum/1',iterations:1.5,accumulator:'total'},
    {...pure,profile:'dense-array-sum/1',iterations:1025,accumulator:'total'},
    {...pure,profile:'future/1'}
  ])assert.throws(()=>encodeWitness('summarize',fields));
});

test('opaque structured metadata cannot silently lose or change fields',()=>{
  for(const handler of [undefined,NaN,Infinity,-0,1n,new Date(),{x:undefined},[undefined],Array(1)])
    assert.throws(()=>encodeWitness('transfer',{kind:'cleanup',value:['undefined'],handler}));
  const cyclic={};cyclic.self=cyclic;
  assert.throws(()=>encodeWitness('transfer',{kind:'cleanup',value:['undefined'],handler:cyclic}));
  assert.throws(()=>encodeWitness('allocate',{name:'o1',kind:'object',
    properties:[{key:'x',value:['num',1],hidden:true}]}));
});

test('untrusted trace text is parsed as data without evaluation',()=>{
  let called=false;
  globalThis.traceV6ExecutionTrap=()=>{called=true;return 6;};
  try{
    for(const text of [
      'return traceV6ExecutionTrap()',
      'compute traceV6ExecutionTrap() => 6',
      'return (() => traceV6ExecutionTrap())()',
      'return `value ${traceV6ExecutionTrap()}`',
      'compute @o1[traceV6ExecutionTrap()] => 6'
    ])assert.throws(()=>decodeWitness(text));
    assert.equal(called,false);
  }finally{delete globalThis.traceV6ExecutionTrap;}
});

test('bounded expressions and deeply nested structured data fail closed',()=>{
  assert.throws(()=>decodeWitness('compute '+'(! '.repeat(40)+'true'+')'.repeat(40)+' => false'),
    /expression node budget/);
  assert.throws(()=>decodeWitness('source "main" = "x" sites '+'['.repeat(257)+']'.repeat(257)),
    /JSON nesting budget/);
  const operatorOverflow='compute '+'(! '.repeat(9)+'true'+')'.repeat(9)+' => false';
  assert.throws(()=>decodeWitness(operatorOverflow),/operator budget/);
});

test('transport frames preserve complete canonical UTF-8 records and fail closed',()=>{
  const line=encodeWitness('return',{value:['str','escaped "quote"\n'+'😀東京'.repeat(40)]});
  const parts=fragmentWitness(line,{maxBytes:80});
  assert.ok(parts.length>3);
  assert.equal(decodeWitness(parts[0]).kind,'value-open');
  assert.equal(decodeWitness(parts.at(-1)).kind,'value-close');
  for(const part of parts){
    assert.ok(Buffer.byteLength(part,'utf8')<=80);
    const {kind,fields}=decodeWitness(part);
    assert.equal(encodeWitness(kind,fields),part);
  }
  assert.deepEqual(restoreWitness(parts),[line]);
  assert.deepEqual(fragmentWitness('return 6',{maxBytes:80}),['return 6']);
  assert.throws(()=>restoreWitness(parts.slice(0,-1)),/Incomplete/);
  assert.throws(()=>restoreWitness(parts.slice(1)),/Orphaned/);
  const changed=[...parts];changed[1]=changed[1].replace(/^part @r[0-9]+ /,'part @r1 ');
  assert.throws(()=>restoreWitness(changed),/Interleaved/);
  const corrupt=[encodeWitness('value-open',{id:'r9',type:'semantic-record'}),
    encodeWitness('value-part',{id:'r9',data:'return 6'}),encodeWitness('value-close',{id:'r9'})];
  assert.throws(()=>restoreWitness(corrupt),/identity mismatch/);
});
