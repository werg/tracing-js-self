import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {executeTest262ModuleReference as execute} from '../../src/corpus/test262-module-reference.mjs';
const harness={'sta.js':'function Test262Error(m){this.message=m}',
 'assert.js':'function assert(x){if(!x)throw new Test262Error("failed")}; assert.sameValue=(a,b)=>{if(!Object.is(a,b))throw new Test262Error("different")}',
 'helper.js':'globalThis.helper=7;'};
const meta=(negative=null,includes=[],flags=['module'])=>({metadataStatus:'parsed',
  flags,includes,features:[],negative});
const run=(source,metadata=meta(),more={})=>execute({source,metadata,
  filename:'test/language/module-code/main.js',harnessSources:harness,...more});

test('static module imports and native module scoping are diagnostic only',async()=>{
 const result=await run('import { n } from "./dep.js"; assert.sameValue(n,5); assert.sameValue(this,undefined)',
   meta(null,['helper.js']),{loadModuleSource:async path=>path==='test/language/module-code/dep.js'?
     'export const n=5;':null});
 assert.equal(result.status,'passed',result.reason);
 assert.equal(result.modules,2);
 assert.equal(result.authority,'native-v8-diagnostic-only');
 assert.equal(result.verifiedOwned,false); assert.equal(result.admitted,false);
});
test('parse, resolution and runtime negative phases are not conflated',async()=>{
 assert.equal((await run('export const =1;',meta({phase:'parse',type:'SyntaxError'}))).status,'passed');
 assert.equal((await run('export const =1;',meta({phase:'runtime',type:'SyntaxError'}))).status,'failed');
 assert.equal((await run('export const x=1;',meta({phase:'parse',type:'SyntaxError'}))).status,'failed');
 const dependency={loadModuleSource:async()=> 'export const other=1;'};
 const src='import { missing } from "./dep.js";';
 assert.equal((await run(src,meta({phase:'resolution',type:'SyntaxError'}),dependency)).status,'passed');
 assert.equal((await run(src,meta({phase:'runtime',type:'SyntaxError'}),dependency)).status,'failed');
 assert.equal((await run('throw new TypeError("real")',meta({phase:'runtime',type:'TypeError'}))).status,'passed');
 assert.equal((await run('throw {name:"TypeError"}',meta({phase:'runtime',type:'TypeError'}))).status,'failed');
 assert.equal((await run('throw new RangeError()',meta({phase:'runtime',type:'TypeError'}))).status,'failed');
 assert.equal((await run('export const x=1;',meta({phase:'resolution',type:'SyntaxError'}))).status,'failed');
});
test('static fixture lookup refuses unsafe imports and missing dependencies',async()=>{
 for(const specifier of ['outside','/etc/passwd','../../../../out.js','https://example.com/x.js']){
   const result=await run('import "'+specifier+'"');
   assert.equal(result.status,'unsupported',specifier+': '+result.reason);
 }
 assert.equal((await run('import "./missing.js"')).status,'unsupported');
 assert.equal((await run('import "./missing.js"',meta({phase:'resolution',type:'SyntaxError'}))).status,'unsupported');
 assert.equal((await run('import "./dep.js"',meta({phase:'resolution',type:'SyntaxError'}),{loadModuleSource:async()=> 'var = ;'})).status,'unsupported');
 assert.equal((await run('export const x=1',meta(null,['missing.js']))).status,'unsupported');
 assert.equal((await run('export const x=1',meta({phase:'early',type:'SyntaxError'}))).status,'unsupported');
 assert.equal((await run('export const x=1',meta(null,[],['module','async']))).status,'unsupported');
 assert.equal((await run('await import("./dep.js").catch(()=>{})')).status,'unsupported');
 await assert.rejects(run('export const x=1',meta(),{filename:'../outside.js'}),/Invalid/);
});
test('top-level await completion and bounded unresolved promises',async()=>{
 assert.equal((await run('await Promise.resolve(); assert.sameValue(1,1)')).status,'passed');
 const result=await run('await new Promise(()=>{})',meta(),{timeoutMs:15});
 assert.equal(result.status,'unsupported');
 assert.match(result.reason,/deadline/);
});

test('bounded asynchronous native ESM module completion remains non-owned',async()=>{
 const completed=await run('await Promise.resolve(); Promise.resolve().then(()=>$DONE());',
   meta(null,[],['module','async']));
 assert.equal(completed.status,'passed',completed.reason);
 assert.equal(completed.completionCalls,1);
 assert.equal(completed.verifiedOwned,false);
 assert.equal(completed.admitted,false);
 const missing=await run('await Promise.resolve();',
   meta(null,[],['module','async']));
 assert.equal(missing.status,'unsupported');
 const duplicated=await run('$DONE(); $DONE();',
   meta(null,[],['module','async']));
 assert.equal(duplicated.status,'failed');
 const late=await run('Promise.resolve().then(()=>$DONE());',
   meta(null,[],['module','async']));
 assert.equal(late.status,'passed',late.reason);
});
test('async native ESM negative completion uses real guest constructors',async()=>{
 const flags=['module','async'];
 const negative=meta({phase:'runtime',type:'TypeError'},[],flags);
 assert.equal((await run('Promise.resolve().then(()=>$DONE(new TypeError()))',negative)).status,'passed');
 assert.equal((await run('Promise.resolve().then(()=>$DONE({name:"TypeError"}))',negative)).status,'failed');
 assert.equal((await run('throw new TypeError("actual")',negative)).status,'passed');
 assert.equal((await run('$DONE()',negative)).status,'failed');
 assert.equal((await run('await new Promise(()=>{})',
   meta(null,[],flags),{timeoutMs:15})).status,'unsupported');
});


test('unhandled async module rejection after completion cannot pass (isolated child)',()=>{
 const runnerUrl=new URL('../../src/corpus/test262-module-reference.mjs',import.meta.url).href;
 const payload={
  source:'$DONE(); Promise.resolve().then(()=>{throw new Error("late rejection")});',
  metadata:meta(null,[],['module','async']),
  filename:'test/language/module-code/main.js',harnessSources:harness
 };
 const code='import {executeTest262ModuleReference as execute} from '+
  JSON.stringify(runnerUrl)+';'+
  'const result=await execute('+JSON.stringify(payload)+');'+
  'console.log(JSON.stringify(result));';
 const child=spawnSync(process.execPath,
  ['--no-warnings','--experimental-vm-modules','--input-type=module','-e',code],
  {encoding:'utf8',timeout:5000});
 assert.equal(child.status,0,child.stderr);
 const result=JSON.parse(child.stdout.trim());
 assert.equal(result.status,'failed',result.reason);
 assert.match(result.reason,/Unhandled native module promise rejection/);
 assert.equal(result.verifiedOwned,false);
 assert.equal(result.admitted,false);
});
