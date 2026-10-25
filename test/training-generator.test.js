import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('fixture generator preserves seed identity and rejects out-of-range seeds',()=>{
  const temp=mkdtempSync(join(tmpdir(),'tracing-training-seeds-'));
  try {
    const generate=seed=>{
      const output=join(temp,'seed-'+seed+'.jsonl');
      const manifest=join(temp,'seed-'+seed+'.json');
      execFileSync(process.execPath,['tools/generate-diagnostic-training.mjs',
        '--count','8','--seed',String(seed),'--output',output,'--manifest',manifest]);
      const m=JSON.parse(readFileSync(manifest,'utf8'));
      assert.equal(m.seed,seed);
      return readFileSync(output,'utf8').trim().split('\n')
        .map(line=>JSON.parse(line).sidecar.archive.entrySpec.arguments);
    };
    const zero=generate(0),one=generate(1);
    assert.notDeepEqual(zero,one,'seed 0 must not alias seed 1');
    assert.throws(()=>execFileSync(process.execPath,['tools/generate-diagnostic-training.mjs',
      '--seed','4294967296','--output',join(temp,'bad.jsonl')],{stdio:'pipe'}),
      /Command failed/);
  } finally {
    rmSync(temp,{recursive:true,force:true});
  }
});
