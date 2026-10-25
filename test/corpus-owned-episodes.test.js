import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {cases,sources} from '../corpus/cases.mjs';
import {original,corpusSplit} from '../corpus/pinned-source.mjs';
import {validateTrainingExport,recheckOwnedSourceEvidence} from '../src/training/source-check.js';

const sha=text=>createHash('sha256').update(text).digest('hex');
const specimen=cases.find(c=>c.project==='vscode'&&c.entry==='clamp');
function inputRow(){
  const pinned=original(specimen);
  const family=specimen.project+'/'+specimen.file+'/'+specimen.entry;
  return {schema:'real-source-corpus/1',project:specimen.project,
    pinnedRevision:sources[specimen.project].revision,
    license:sources[specimen.project].license,
    family,index:0,split:corpusSplit(family),sourceURL:pinned.sourceURL,
    sourceFileSha256:sha(pinned.sourceFile),verified:true,returned:true,
    observation:{source:{originalText:pinned.text}}};
}
function runAudit(row,dir,additional=[]){
  const input=join(dir,'native.jsonl'),report=join(dir,'coverage.json');
  const episodes=join(dir,'verified-local.jsonl');
  writeFileSync(input,JSON.stringify(row)+'\n');
  const run=spawnSync(process.execPath,['tools/audit-owned-coverage.mjs',
    '--input',input,'--output',report,'--per-function','1',
    '--local-episodes',episodes,'--min-owned-verified','1',...additional],
    {encoding:'utf8'});
  return {run,report,episodes};
}

test('pinned source bundles and family split match original corpus extraction',()=>{
  assert.match(original(specimen).text,/function clamp/);
  assert.equal(corpusSplit('vscode/numbers.ts/clamp'),corpusSplit('vscode/numbers.ts/clamp'));
});

test('owned corpus bridge emits only independently rechecked, provenance-tagged local traces',()=>{
  const dir=mkdtempSync(join(tmpdir(),'corpus-owned-'));
  try{
    const {run,report,episodes}=runAudit(inputRow(),dir);
    assert.equal(run.status,0,run.stderr);
    const result=JSON.parse(readFileSync(report,'utf8'));
    assert.equal(result.admitted,false);
    assert.equal(result.ownedVerified,1);
    assert.equal(result.locallyVerifiedEpisodes,1);
    const rows=readFileSync(episodes,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length,1);
    const episode=rows[0];
    assert.equal(episode.public.schema,'semantic-execution/4');
    assert.equal(episode.sidecar.split,inputRow().split);
    assert.equal(episode.sidecar.provenance.corpus,'pinned-real-source');
    assert.equal(episode.sidecar.provenance.admission,'pending external megatoken gate');
    assert.equal(validateTrainingExport(episode).valid,true);
    assert.equal(recheckOwnedSourceEvidence(episode).valid,true);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('owned corpus bridge refuses tampered pinned source bytes and split',()=>{
  const dir=mkdtempSync(join(tmpdir(),'corpus-provenance-'));
  try{
    for(const mutate of [
      row=>{row.observation.source.originalText+='\n// modified';},
      row=>{row.sourceFileSha256='0'.repeat(64);},
      row=>{row.split=row.split==='train'?'test':'train';}
    ]){
      const row=inputRow();mutate(row);
      const {run}=runAudit(row,dir);
      assert.notEqual(run.status,0);
      assert.match(run.stderr,/Pinned corpus provenance mismatch/);
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
