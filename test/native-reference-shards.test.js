import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {importers} from '../src/corpus/import-external.mjs';
import {aggregateNativeReferenceShards,shardForOrdinal,
 validateAcquiredTest262} from '../src/corpus/native-reference-shards.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const revision='a'.repeat(40);
const validFixture={
 schema:'external-corpus-fixture/1',authority:'acquired-fixture-only',
 admitted:false,verified:false,id:sha('case'),
 status:'requires-harness',provenance:{
  repository:'tc39/test262',revision,sha256:sha('source'),
  path:'test/language/a.js'},
 program:{kind:'test262-program',sourceFile:'test/language/a.js',
  mode:'sloppy',flags:[],harness:[],features:[]}
};
test('only pinned acquired source identities can be assigned to native shards',()=>{
 assert.equal(validateAcquiredTest262(validFixture,revision),validFixture);
 assert.equal(shardForOrdinal(12,5),2);
 assert.throws(()=>shardForOrdinal(1,0),/Invalid/);
 assert.throws(()=>validateAcquiredTest262({...validFixture,admitted:true},revision),
  /Malformed/);
 assert.throws(()=>validateAcquiredTest262({...validFixture,
  provenance:{...validFixture.provenance,path:'test/../other.js'}},revision),
  /Malformed/);
});
test('native reference aggregator refuses gaps, duplicates and forged evidence',()=>{
 const items=Array.from({length:7},(_,ordinal)=>({ordinal,
  id:sha('id:'+ordinal),sourceSha256:sha('src:'+ordinal),
  path:'test/a.js',authority:'native-v8-diagnostic-only',
  status:ordinal%2?'failed':'passed',verifiedOwned:false,admitted:false}));
 const catalogFingerprint=sha('same pinned catalog');
 const shards=[0,1,2].map(index=>{
  const rows=items.filter(r=>r.ordinal%3===index);
  const rowsContent=rows.map(r=>JSON.stringify(r)+'\n').join('');
  const counts={passed:rows.filter(x=>x.status==='passed').length,
   failed:rows.filter(x=>x.status==='failed').length};
  return {rows,rowsContent,report:{
   schema:'test262-native-reference-report/1',
   authority:'native-v8-diagnostic-only',verifiedOwned:0,admitted:0,
   revision,catalogFingerprint,enumerated:7,
   shard:{index,count:3,eligible:rows.length,truncated:false},
   attempted:rows.length,counts,rowsSha256:sha(rowsContent)}};
 });
 const result=aggregateNativeReferenceShards(shards,{expectedTotal:7});
 assert.equal(result.attempted,7);
 assert.equal(result.distinctTestIdentities,7);
 assert.equal(result.verifiedOwned,0);
 assert.equal(result.admitted,0);
 assert.deepEqual(result.counts,{passed:4,failed:3,unsupported:0});
 assert.throws(()=>aggregateNativeReferenceShards(shards.slice(0,2),{
  expectedTotal:7}),/Incomplete/);
 assert.throws(()=>aggregateNativeReferenceShards([...shards,shards[0]]),
  /Duplicate/);
 assert.throws(()=>aggregateNativeReferenceShards(shards,{expectedTotal:8}),
  /Incomplete/);
 const changed=structuredClone(shards);
 changed[0].rowsContent+='x';
 assert.throws(()=>aggregateNativeReferenceShards(changed),/digest mismatch/);
 changed[0].rowsContent=shards[0].rowsContent;
 changed[0].report.verifiedOwned=1;
 assert.throws(()=>aggregateNativeReferenceShards(changed),/Invalid/);
 const wrong=structuredClone(shards);
 wrong[1].report.catalogFingerprint=sha('different');
 assert.throws(()=>aggregateNativeReferenceShards(wrong),/source mismatch/);
});
test('two exact-source native shards and offline aggregate provide complete evidence',async()=>{
 const temp=mkdtempSync(join(tmpdir(),'test262-shard-'));
 try{
  const root=join(temp,'source'),out=join(temp,'native-parts');
  mkdirSync(root,{recursive:true});
  const put=(path,data)=>{
   const file=join(root,path);mkdirSync(dirname(file),{recursive:true});
   writeFileSync(file,data);
  };
  put('harness/sta.js','function Test262Error(m){this.message=m}');
  put('harness/assert.js','function assert(b){if(!b)throw new Test262Error("failed")}; assert.sameValue=(a,b)=>{if(!Object.is(a,b))throw new Test262Error("different")};');
  put('test/language/strict.js','/*---\nflags: [onlyStrict]\n---*/\nassert.sameValue(2+3,5);');
  put('test/language/both.js','/*---\nflags: []\n---*/\nassert.sameValue(1+1,2);');
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
  git('init','-q');git('config','user.email','ci@example.invalid');
  git('config','user.name','Fixture CI');
  git('add','.');git('commit','-qm','Pinned Test262 fixture');
  const head=git('rev-parse','HEAD'),records=[];
  for await(const row of importers.test262(root,{
   project:'tc39/test262',repository:'tc39/test262',
   revision:head,license:'BSD-3-Clause'
  }))records.push(row);
  assert.equal(records.length,3);
  const input=join(temp,'input.jsonl');
  writeFileSync(input,records.map(x=>JSON.stringify(x)).join('\n')+'\n');
  for(const i of [0,1]){
   const dir=join(out,'native-test262-part-'+i);mkdirSync(dir,{recursive:true});
   const executed=spawnSync(process.execPath,[
    resolve('tools/verify-test262-reference.mjs'),
    '--root',root,'--revision',head,'--input',input,
    '--shard-index',String(i),'--shard-count','2','--max','5',
    '--expect-enumerated','3','--output',join(dir,'report.json'),
    '--rows-output',join(dir,'rows.jsonl')
   ],{encoding:'utf8',timeout:15000});
   assert.equal(executed.status,0,executed.stderr);
   const report=JSON.parse(readFileSync(join(dir,'report.json'),'utf8'));
   assert.equal(report.enumerated,3);
   assert.equal(report.attempted,report.shard.eligible);
   assert.equal(report.shard.truncated,false);
   assert.equal(report.verifiedOwned,0);
   assert.equal(report.admitted,0);
  }
  const summary=join(temp,'summary.json');
  const aggregated=spawnSync(process.execPath,[
   resolve('tools/aggregate-test262-native.mjs'),
   '--directory',out,'--expect-enumerated','3','--output',summary
  ],{encoding:'utf8',timeout:15000});
  assert.equal(aggregated.status,0,aggregated.stderr);
  const result=JSON.parse(readFileSync(summary,'utf8'));
  assert.equal(result.attempted,3);
  assert.equal(result.counts.passed,3);
  assert.equal(result.distinctTestIdentities,3);
  assert.equal(result.admitted,0);
 }finally{rmSync(temp,{recursive:true,force:true});}
});
