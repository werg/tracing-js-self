import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {cases} from '../corpus/cases.mjs';
import {corpusSplit} from '../corpus/pinned-source.mjs';

const spawn=(tool,args)=>spawnSync(process.execPath,[tool,...args],{
  encoding:'utf8',timeout:100000});
const workspace=fn=>{
  const dir=mkdtempSync(join(tmpdir(),'corpus-full-audit-'));
  try {fn(dir)}finally{rmSync(dir,{recursive:true,force:true})}
};
const partition=(indexStart,indexEnd)=>({
  schema:'real-source-owned-coverage/1',admitted:false,
  options:{perFunction:12,indexStart,indexEnd,requireComplete:true},
  totalFamilies:cases.length,invocations:cases.length*(indexEnd-indexStart),
  ownedVerified:cases.length*(indexEnd-indexStart),
  examples:cases.flatMap(spec=>Array.from({length:indexEnd-indexStart},(_,i)=>({
    family:spec.project+'/'+spec.file+'/'+spec.entry,index:indexStart+i,
    nativeVerified:true,ownedStatus:'locally_verified',reason:null
  })))
});

test('full corpus merge rejects missing indices, duplicate partitions and fabricated counts',()=>workspace(dir=>{
  const a=join(dir,'0.json'),b=join(dir,'1.json'),output=join(dir,'summary.json');
  writeFileSync(a,JSON.stringify(partition(0,1)));
  writeFileSync(b,JSON.stringify(partition(1,2)));
  const success=spawn('tools/merge-owned-coverage.mjs',['--output',output,a,b]);
  assert.equal(success.status,0,success.stderr);
  const report=JSON.parse(readFileSync(output,'utf8'));
  assert.equal(report.invocations,156);
  assert.equal(report.fullCorpus,false);
  assert.equal(report.admitted,false);
  assert.equal(report.byFamily['vscode/numbers.ts/clamp'].split,
    corpusSplit('vscode/numbers.ts/clamp'));
  const missing=spawn('tools/merge-owned-coverage.mjs',['--require-complete','--output',output,a,b]);
  assert.notEqual(missing.status,0);
  assert.match(missing.stderr,/Missing corpus execution/);
  const duplicate=spawn('tools/merge-owned-coverage.mjs',['--output',output,a,a]);
  assert.notEqual(duplicate.status,0);
  assert.match(duplicate.stderr,/Duplicate index partition/);
  const bad=partition(1,2);bad.ownedVerified--;
  writeFileSync(b,JSON.stringify(bad));
  const fabricated=spawn('tools/merge-owned-coverage.mjs',['--output',output,a,b]);
  assert.notEqual(fabricated.status,0);
  assert.match(fabricated.stderr,/count mismatch/);
}));

test('owned verifier refuses incomplete indexed partitions',()=>workspace(dir=>{
  const input=join(dir,'empty.jsonl'),output=join(dir,'coverage.json');
  writeFileSync(input,'');
  const run=spawn('tools/audit-owned-coverage.mjs',[
    '--input',input,'--output',output,'--per-function','12',
    '--index-start','10','--index-end','12','--require-complete']);
  assert.notEqual(run.status,0);
  assert.match(run.stderr,/Missing corpus invocation/);
}));

test('stateful auditor refuses an incomplete pinned scenario inventory',()=>workspace(dir=>{
  const input=join(dir,'empty.jsonl'),output=join(dir,'quality.json');
  writeFileSync(input,'');
  const run=spawn('tools/audit-stateful-corpus.mjs',[
    '--input',input,'--output',output,'--require-complete']);
  assert.notEqual(run.status,0);
  assert.match(run.stderr,/Missing stateful scenario/);
}));

test('stateful auditor checks pinned observations, observable effects and vendor hashes',()=>workspace(dir=>{
  const input=join(dir,'one.jsonl'),output=join(dir,'quality.json'),report=join(dir,'native.json');
  const built=spawn('tools/build-stateful-corpus.mjs',[
    '--limit','1','--per-scenario','1','--min-verified','1',
    '--output',input,'--report',report,'--review',join(dir,'readme.md')]);
  assert.equal(built.status,0,built.stderr);
  const valid=spawn('tools/audit-stateful-corpus.mjs',['--input',input,'--output',output]);
  assert.equal(valid.status,0,valid.stderr);
  const info=JSON.parse(readFileSync(output,'utf8'));
  assert.equal(info.admitted,false);
  assert.equal(info.totals.invocations,1);
  assert.equal(info.totals.nativeVerified,1);
  assert.equal(info.totals.sourceSiteViolations,0);
  const row=JSON.parse(readFileSync(input,'utf8'));
  const key=Object.keys(row.upstreamHashes)[0];
  row.upstreamHashes[key]='0'.repeat(64);
  writeFileSync(input,JSON.stringify(row)+'\n');
  const altered=spawn('tools/audit-stateful-corpus.mjs',['--input',input,'--output',output]);
  assert.notEqual(altered.status,0);
  assert.match(altered.stderr,/provenance mismatch/);
}));
