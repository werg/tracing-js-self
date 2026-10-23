import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {test262Metadata,hardness,frozenSplit,importers}
  from '../src/corpus/import-external.mjs';
import {adversarialScenarios} from '../corpus/stateful/extension-cases.mjs';
const revision='0123456789abcdef0123456789abcdef01234567';
const source={project:'example/tests',repository:'example/tests',revision,license:'MIT'};
const root=()=>mkdtempSync(join(tmpdir(),'external-corpus-'));
const put=(dir,path,content)=>{const full=join(dir,path);mkdirSync(dirname(full),{recursive:true});writeFileSync(full,content);};
const all=async iter=>{const records=[];for await(const row of iter)records.push(row);return records;};
const gitblob=str=>createHash('sha1').update('blob '+Buffer.byteLength(str)+'\0'+str).digest('hex');
test('Test262 metadata, strict variants and negative tests preserve source hashes',async()=>{
 const dir=root();
 try {
  put(dir,'test/language/edge.js',
    '/*---\nflags: [async]\nincludes: [propertyHelper.js]\nfeatures: [Proxy]\nnegative:\n  phase: runtime\n  type: TypeError\n---*/\nthrow TypeError("edge");');
  put(dir,'test/language/strict.js','/*---\nflags:\n  - onlyStrict\n  - noProperty\n---*/\n"use strict";');
  put(dir,'test/language/module.js','/*---\nflags: [module]\n---*/\nexport default 2;');
  const items=await all(importers.test262(dir,source));
  assert.equal(items.length,4);
  const edge=items.filter(x=>x.provenance.path.endsWith('edge.js'));
  assert.deepEqual(edge.map(x=>x.program.mode),['sloppy','strict']);
  assert.deepEqual(edge[0].program.harness,['assert.js','sta.js','propertyHelper.js']);
  assert.deepEqual(edge[0].expected,{kind:'expected-error',phase:'runtime',type:'TypeError'});
  assert.equal(edge[0].authority,'acquired-fixture-only');
  assert.equal(edge[0].verified,false);
  assert.equal(edge[0].admitted,false);
  assert.deepEqual(items.find(x=>x.provenance.path.endsWith('module.js')).program.mode,'module');
  assert.equal(items.every(x=>x.id.length===64&&x.provenance.sha256.length===64),true);
  assert.equal(new Set(items.map(x=>x.id)).size,4);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('Exercism nested canonical records are not confused with executable solutions',async()=>{
 const dir=root();
 try {
  const doc=JSON.stringify({cases:[{description:'outer',cases:[
   {uuid:'a',property:'sum',input:{x:1},expected:2},
   {uuid:'b',property:'sum',input:{x:5},expected:6}]}]});
  put(dir,'exercises/adder/canonical-data.json',doc);
  const items=await all(importers.exercism(dir,source));
  assert.equal(items.length,2);
  assert.deepEqual(items[0].fixture,{kind:'canonical-input',id:'a',input:{x:1}});
  assert.equal(items[0].status,'requires-solution');
  assert.equal(items[1].expected.value,6);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('JSON Schema contracts preserve data vs expected labels',async()=>{
 const dir=root();
 try {
  put(dir,'tests/draft2020-12/dynamicRef.json',JSON.stringify([
    {description:'recursive',schema:{$dynamicRef:'#meta'},
      tests:[{description:'cycle',data:{x:1},valid:false},
        {description:'valid',data:null,valid:true}]}
  ]));
  const rows=await all(importers['json-schema'](dir,source));
  assert.equal(rows.length,2);
  assert.deepEqual(rows.map(x=>x.expected.valid),[false,true]);
  assert.equal(rows[0].program.draft,'draft2020-12');
  assert.equal(rows[0].status,'requires-validator');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('CommonMark JSON examples remain contracts pending real parser execution',async()=>{
 const dir=root();
 try{
  put(dir,'spec.json',JSON.stringify([
    {markdown:'hello\n',html:'<p>hello</p>\n',example:1,section:'Paragraphs'},
    {markdown:'**x**',html:'<p><strong>x</strong></p>\n',example:2}
  ]));
  const rows=await all(importers.commonmark(dir,source));
  assert.equal(rows.length,2);
  assert.equal(rows[0].fixture.markdown,'hello\n');
  assert.equal(rows[1].expected.kind,'rendered-html');
  assert.equal(rows[0].status,'requires-renderer');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Jest/Vitest .each importer extracts only literal rows without evaluation',async()=>{
 const dir=root();
 try{
  put(dir,'src/sum.test.ts',
    "test.each([[1,2,3],[-1,2,1],['x',null,false]])('sum', (a,b,c)=>expect(sum(a,b)).toBe(c));\n"+
    "test.each([dangerous()])('do not run me',()=>{});\n"+
    "test.each([{x:1},{x:2}])('objects',()=>{});");
  const rows=await all(importers['jest-each'](dir,source));
  assert.equal(rows.length,5);
  assert.deepEqual(rows[0].fixture.args,[1,2,3]);
  assert.deepEqual(rows[1].fixture.args,[-1,2,1]);
  assert.equal(rows[0].program.kind,'parameterized-test');
  assert.equal(rows[0].status,'requires-test-runner');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Hardness prioritizes difficult cases without claiming verification',()=>{
 const easy=hardness('function x(n){return n+1}', 'x.js');
 const hard=hardness('class X { get x(){ return Reflect.get(new Proxy({},{}), "x"); } } async function y(){ try{await Promise.resolve()}finally{throw Error("x")}}');
 assert.ok(hard.score>easy.score);
 assert.ok(hard.features.includes('accessors'));
 assert.ok(hard.features.includes('proxy'));
 assert.ok(hard.features.includes('try-catch-finally'));
 assert.equal(frozenSplit('example/tests'),frozenSplit('example/tests'));
});
test('Snapshot CLI refuses modified bytes, accepts pinned acquisition-only catalog',()=>{
 const dir=root();
 try{
  const body='/*---\nflags: [noStrict]\n---*/\nassert.sameValue(2,1+1);';
  put(dir,'test/fixture.js',body);
  const lock={repository:'example/tests',revision,files:{'test/fixture.js':gitblob(body)}};
  put(dir,'snapshot.lock.json',JSON.stringify(lock));
  const tool=resolve('tools/import-external-corpus.mjs');
  const params=['--format','test262','--root',dir,'--repository','example/tests',
    '--revision',revision,'--license','MIT','--snapshot','--lock',join(dir,'snapshot.lock.json'),
    '--output',join(dir,'out.jsonl'),'--report',join(dir,'report.json')];
  execFileSync(process.execPath,[tool,...params],{encoding:'utf8'});
  const result=JSON.parse(readFileSync(join(dir,'report.json'),'utf8'));
  assert.equal(result.records,1);assert.equal(result.verified,0);
  assert.equal(JSON.parse(readFileSync(join(dir,'out.jsonl'),'utf8')).admitted,false);
  put(dir,'test/fixture.js',body+'// corrupted');
  assert.throws(()=>execFileSync(process.execPath,[tool,...params],{stdio:'pipe'}));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Adversarial suite uses pinned vendor module IDs and distinct identities',()=>{
 const ids=new Set(adversarialScenarios.map(x=>x.id));
 assert.equal(ids.size,adversarialScenarios.length);
 assert.ok(ids.size>=12);
 for(const row of adversarialScenarios){
  assert.match(row.id,/^adversarial\//);
  assert.ok(row.adversarial.length>20);
  assert.ok(row.run.includes('function run(seed)'));
  assert.ok(row.modules.length>0);
  assert.ok(['application','mitt','zustand','quick-lru','koa-compose',
    'eventemitter3','yocto-queue','p-limit','axios'].includes(row.project));
 }
});
