import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
const sources=[
 {format:'test262',name:'test262',repo:'tc39/test262',
  rev:'d53ebc8b1931d9f1541e43d59650776e4b766248',license:'BSD-3-Clause',min:42},
 {format:'json-schema',name:'json-schema',repo:'json-schema-org/JSON-Schema-Test-Suite',
  rev:'89e83a74014617ffbe79a56d83d14d054cd11417',license:'MIT',min:26},
 {format:'exercism',name:'exercism',repo:'exercism/problem-specifications',
  rev:'650bebeb39ad40439175288042aece982b0a90a9',license:'MIT',min:24}
];
test('three pinned upstream snapshots import without executing third-party source',()=>{
 const tmp=mkdtempSync(join(tmpdir(),'corpus-snapshots-'));
 try{
  for(const suite of sources){
   const root=resolve('corpus/extension/snapshots',suite.name);
   const lock=JSON.parse(readFileSync(join(root,'snapshot.lock.json'),'utf8'));
   assert.equal(lock.revision,suite.rev);
   assert.ok(Object.keys(lock.files).length>=suite.min);
   const out=join(tmp,suite.name+'.jsonl'),report=join(tmp,suite.name+'.json');
   execFileSync(process.execPath,[resolve('tools/import-external-corpus.mjs'),
     '--format',suite.format,'--root',root,'--snapshot','--lock',join(root,'snapshot.lock.json'),
     '--revision',suite.rev,'--repository',suite.repo,'--license',suite.license,
     '--output',out,'--report',report],{encoding:'utf8'});
   const stats=JSON.parse(readFileSync(report,'utf8'));
   const records=readFileSync(out,'utf8').trim().split('\n').map(JSON.parse);
   assert.equal(stats.records,records.length);
   assert.ok(stats.records>=suite.min, suite.name);
   assert.equal(stats.sourceFiles,Object.keys(lock.files).length);
   assert.equal(stats.admitted,0);
   assert.equal(stats.verified,0);
   assert.ok(records.every(row=>row.admitted===false&&row.verified===false));
   assert.equal(new Set(records.map(x=>x.id)).size,records.length);
   assert.equal(new Set(records.map(x=>x.split)).size<=1,true);
  }
 }finally{rmSync(tmp,{recursive:true,force:true});}
});
