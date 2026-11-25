import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {encodeReadable,prepareTinkerTask,createTinkerSession} from '../src/training/tinker-execution.js';

async function checkAgainstNative(source,args,id){
  const prepared=await prepareTinkerTask({id,family:'codepoint',source,args:encodeReadable(args),fixture:{calls:[]}});
  let kind='return',value;
  try{value=Function('"use strict";'+source+';return run;')()(...args);}
  catch(error){kind='throw';value={name:error.name,message:error.message};}
  const encoded=encodeReadable({arguments:args,value}),session=createTinkerSession(prepared);
  try{assert.equal((await session.step(JSON.stringify({type:'complete',kind,arguments:encoded.arguments,value:encoded.value}),10)).grade.success,true);}
  finally{session.close();}
}

test('owned codePointAt matches native for surrogate pairs, bounds and primitive index conversions',async()=>{
  const cases=[['A😀B',1],['A😀B',2],['\uD800x',0],['\uDC00',0],['',0],['abc',-1],['abc',9],
    ['abc',1.9],['abc',undefined],['abc',null],['abc',true],['abc','2'],['abc',NaN],['abc',Infinity],['abc',-Infinity],['abc',1n]];
  for(let index=0;index<cases.length;index++){
    await checkAgainstNative('function run(text,i){return [text.codePointAt(i),text.charCodeAt(i)];}',cases[index],'codepoint-'+index);
  }
});

test('the original fuzz-discovered codePointAt disagreement is now admitted',async()=>{
  const rows=readFileSync(new URL('../training/fixtures/tinker-regressions.jsonl',import.meta.url),'utf8').trim().split('\n').map(JSON.parse);
  for(const row of rows)await checkAgainstNative(row.source,row.args,row.id);
});

test('existing String intrinsics expose native BigInt index errors as guest exceptions',async()=>{
  for(const method of ['charAt','charCodeAt','at','substring','slice','indexOf']){
    const source=method==='indexOf'?'function run(text,i){try{return text.indexOf("a",i);}catch(e){return [e.name,e.message];}}':
      'function run(text,i){try{return text.'+method+'(i);}catch(e){return [e.name,e.message];}}';
    await checkAgainstNative(source,['abc',1n],'bigint-index-'+method);
  }
});
