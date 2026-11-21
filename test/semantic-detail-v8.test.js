import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {encodeDetailedRecord,decodeDetailedRecord} from '../src/semantic/detail-v8.js';
import {encodeDetailedRecord as encodeV7} from '../src/semantic/detailed-v7.js';

const records=[
  {kind:'bind',fields:{name:'answer',value:['num','-0']}},
  {kind:'return',fields:{value:['str','\ud800😀'],invocation:'call1'}},
  {kind:'throw',fields:{value:['undefined']}},
  {kind:'compute',fields:{expr:{op:'literal',value:['bigint','9007199254740993']},result:['bigint','9007199254740993']}},
  {kind:'request',fields:{effect:'e1',operation:'demo.read',arguments:[['str','key']],invocation:'call1',site:{start:1,end:20},payload:'["key"]'}},
  {kind:'observe',fields:{effect:'e1',status:'fulfilled',result:['num',3]}},
  {kind:'job',fields:{action:'enqueue',job:'j1',owner:'call1',closure:'o1'}},
];

test('direct V8 detail preserves the established canonical bytes and lossless typed values',()=>{
  for(const record of records){
    const line=encodeDetailedRecord(record);
    assert.equal(line,encodeV7(record));
    assert.deepEqual(decodeDetailedRecord(line),record);
  }
});

test('V8 detail rejects malformed bytes and crossed observation authority',()=>{
  const line=encodeDetailedRecord(records[0]);
  for(const invalid of [line+' ',line+'\n',line.replace('"name":','"unknown":'),
    line.replace('"name":"answer"','"name":"wrong","name":"answer"'),
    'answer = -0','detail {"kind":"return","fields":{"value":["num",NaN]}}',
    line.replace('"-0"','-0')])assert.throws(()=>decodeDetailedRecord(invalid));
  assert.throws(()=>decodeDetailedRecord(encodeDetailedRecord(records[5]),{role:'generated'}),/host-controlled/);
  assert.throws(()=>decodeDetailedRecord(line,{role:'observed'}),/observation/);
  assert.throws(()=>encodeDetailedRecord({kind:'value-close',fields:{id:'r1'}}),/fragment/);
});

test('V8 encoding checks data without invoking accessors or Proxy traps',()=>{
  let calls=0;
  const getter={kind:'return',get fields(){calls++;return {value:['num',1]};}};
  assert.throws(()=>encodeDetailedRecord(getter),/accessor/);
  const proxy=new Proxy({kind:'return',fields:{value:['num',1]}},{ownKeys(){calls++;return [];}});
  assert.throws(()=>encodeDetailedRecord(proxy),/own data/);
  assert.equal(calls,0);
});

test('direct V8 detail loads and runs with legacy wire modules blocked',()=>{
  const loader='export async function resolve(specifier,context,next){'+
    'if(/(?:training\\/(?:format|trace-text|harness-v4)|detailed-v7)\\.js/.test(specifier))'+
    'throw new Error("legacy wire dependency: "+specifier);return next(specifier,context);}';
  const module=new URL('../src/semantic/detail-v8.js',import.meta.url).href;
  const source='import {encodeDetailedRecord,decodeDetailedRecord} from '+JSON.stringify(module)+';'+
    'const record={kind:"return",fields:{value:["num",7]}};'+
    'if(decodeDetailedRecord(encodeDetailedRecord(record)).fields.value[1]!==7)throw new Error("roundtrip");';
  const result=spawnSync(process.execPath,['--no-warnings','--experimental-loader',
    'data:text/javascript,'+encodeURIComponent(loader),'--input-type=module','--eval',source],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
