import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {verifyTrainingCase} from '../src/training/admit.js';
import {decodeRecord,encodeRecord} from '../src/training/format.js';

function fixture(){
  const x=verifyTrainingCase({source:'"use strict";function f(a){return a+1;}',entry:'f',args:[2]});
  assert.equal(x.status,'locally_verified');
  return x.exported;
}
function run(selected,reference){
  const directory=mkdtempSync(join(tmpdir(),'semantic-evaluation-'));
  const chosen=join(directory,'selected.jsonl'),gold=join(directory,'reference.jsonl');
  writeFileSync(chosen,JSON.stringify({groups:selected})+'\n');
  writeFileSync(gold,JSON.stringify(reference)+'\n');
  const result=spawnSync(process.execPath,['tools/evaluate-training.mjs',
    '--selected',chosen,'--reference',gold],{encoding:'utf8'});
  return {status:result.status,report:JSON.parse(result.stdout),stderr:result.stderr};
}

test('offline selected-target diagnostic reports the exact committed graph',()=>{
  const reference=fixture();
  const result=run(reference.public.groups,reference);
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.report.counts.correct,1);
  assert.equal(result.report.counts.invalid,0);
  assert.equal(result.report.schema,'semantic-evaluation/1');
});
test('offline selected trajectory can report an incorrect model output without fixing it',()=>{
  const reference=fixture(),groups=structuredClone(reference.public.groups);
  const row=groups.find(g=>g.mode==='generated'&&g.events[0].record.startsWith('return '));
  const parsed=decodeRecord(row.events[0].record);
  row.events[0].record=encodeRecord('return',{...parsed.fields,result:['num',400]});
  const result=run(groups,reference);
  assert.equal(result.status,1,result.stderr);
  assert.equal(result.report.counts.incorrect,1);
  assert.equal(result.report.counts.correct,0);
  assert(result.report.counts.firstDivergences.trace>0);
});
