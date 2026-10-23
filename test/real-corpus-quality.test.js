import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
test('diagnostic quality report retains nonadmission and highlights suspect records',()=>{
 const dir=mkdtempSync(join(tmpdir(),'trace-quality-'));
 try {
   const row={schema:'real-source-corpus/1',family:'project/fixture/function',
     index:0,verified:true,sourceURL:'https://example.test/source',observation:{
     source:{text:'let x = o.n + 1;'},
     events:[
       {kind:'read',site:{start:8,end:11},result:['num',3]},
       {kind:'read',site:{start:8,end:11},result:['num',3]},
       {kind:'write',site:{start:0,end:16},result:['num',4]},
       {kind:'end',site:{start:0,end:0},result:['num',4]}]
     }};
   const input=join(dir,'data.jsonl'),out=join(dir,'quality.json'),md=join(dir,'quality.md');
   writeFileSync(input,JSON.stringify(row)+'\n');
   const run=spawnSync(process.execPath,['tools/audit-real-corpus.mjs',
     '--input',input,'--output',out,'--review',md],{encoding:'utf8'});
   assert.equal(run.status,0,run.stderr);
   const result=JSON.parse(readFileSync(out,'utf8'));
   assert.equal(result.admitted,false);
   assert.equal(result.totals.functions,1);
   assert.equal(result.totals.verified,1);
   assert.equal(result.totals.repeatedReadCandidates,1);
   assert.equal(result.totals.sameValueWriteCandidates,1);
   assert.match(readFileSync(md,'utf8'),/project\/fixture\/function/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});