import test from 'node:test';
import assert from 'node:assert/strict';
import {supportsPinnedRegExp,scanPinnedReplacement,testPinnedRegExp} from '../src/owned-pinned-regexp.js';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {verifyRegionTrainingCase,recheckRegionEvidence} from '../src/semantic/compiler-v8.js';

test('bounded literal matching uses ordered nonoverlapping UTF-16 matches',()=>{
  for(const [pattern,text] of [['a','ababa'],['aa','aaaaa'],['xy','zxyxy'],['é','aéé'],['😀','😀a😀']]){
    assert.equal(supportsPinnedRegExp(pattern,'g'),true);
    const native=[...text.matchAll(new RegExp(pattern,'g'))].map(match=>({
      start:match.index,end:match.index+match[0].length,match:match[0],group:null}));
    assert.deepEqual(scanPinnedReplacement(pattern,'g',text),native);
    for(const start of [0,1,2,text.length,text.length+1]){
      const regexp=new RegExp(pattern,'g');regexp.lastIndex=start;
      assert.deepEqual(testPinnedRegExp(pattern,'g',text,start),{matched:regexp.test(text),nextIndex:regexp.lastIndex});
    }
  }
  for(const [pattern,flags] of [['','g'],['a+','g'],['a.b','g'],['a','i'],['a','y'],['a'.repeat(257),'g']])
    assert.equal(supportsPinnedRegExp(pattern,flags),false);
  assert.throws(()=>scanPinnedReplacement('a','g','a'.repeat(1025)),/budget/);
  assert.throws(()=>scanPinnedReplacement('a','g','a'.repeat(10001)),/Unsupported/);
});

test('global callback replacement resets lastIndex before all callbacks and preserves their writes',()=>{
  for(const body of [
    'const p=/a/g;p.lastIndex=2;let calls=0;const out="ababa".replace(p,()=>String(++calls));return [out,calls,p.lastIndex];',
    'const p=/a/g;p.lastIndex=2;let calls=0;const out="zzz".replace(p,()=>String(++calls));return [out,calls,p.lastIndex];',
    'const p=/a/g;p.lastIndex=2;let seen="";const out="ababa".replace(p,()=>{seen+=p.lastIndex+":";p.lastIndex=7;return "x";});return [out,seen,p.lastIndex];',
    'const p=/aa/g;let seen="";const out="aaaaa".replace(p,(match,offset,input)=>{seen+=match+":"+offset+":"+input+";";return "x";});return [out,seen,p.lastIndex];',
    'const p=/a/g;p.lastIndex=2;let calls=0;try{"aba".replace(p,()=>{calls++;throw "stop";});}catch(error){return [error,calls,p.lastIndex];}',
    'const p=/a/g;p.lastIndex=2;return [p.test("ababa"),p.lastIndex,p.test("ababa"),p.lastIndex,p.test("ababa"),p.lastIndex];',
    'const p=/a/;p.lastIndex=2;return [p.test("abc"),p.lastIndex];'
  ])runtimeDifferential(body);
});

test('replacement checkpoints retain callback progress without repeating completed effects',()=>{
  const text='"use strict";function run(){const p=/a/g;p.lastIndex=2;let calls=0;const result="ababa".replace(p,()=>String(++calls));return [result,calls,p.lastIndex];}';
  const original=createRuntime().startEntry({text,functionName:'run',args:[]});
  while(!Object.values(original.state.frames).some(frame=>frame.pendingStringReplace?.index===1))original.step();
  const snapshot=JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(original).filter(([key])=>key!=='adapters'))));
  const resumed=Object.assign(createRuntime(),snapshot);
  original.drive();resumed.drive();
  assert.deepEqual(JSON.parse(JSON.stringify(resumed.exportRun())),JSON.parse(JSON.stringify(original.exportRun())));
  assert.equal(validateBundle(resumed.exportRun()).valid,true);
  assert.equal(replayExact(resumed.exportRun()).valid,true);
});

test('frozen RegExp interaction passes the common source and public replay gates',async()=>{
  const source='"use strict";function run(text){const pattern=/a/g;pattern.lastIndex=2;let calls=0;const result=text.replace(pattern,()=>String(++calls));return [result,calls,pattern.lastIndex];}';
  const result=await verifyRegionTrainingCase({source,entry:'run',args:['ababa'],family:'literal-regexp-replacement'});
  assert(result.exported,result.reason);
  const rechecked=await recheckRegionEvidence(result.exported);
  assert.equal(rechecked.sourceValidated,true);
  assert.equal(rechecked.projectionValidated,true);
  assert.equal(rechecked.replayValidated,true);
});
