import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {loadNativeSettings} from '../src/corpus/native-admission-client.mjs';

test('native settings reject modified tracked consumers and an interpreter importing another checkout',t=>{
  const root=mkdtempSync(join(tmpdir(),'native-pin-check-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const repo=join(root,'consumer'),module=join(repo,'src/megatoken/__init__.py');
  mkdirSync(join(repo,'src/megatoken'),{recursive:true});writeFileSync(module,'# fixture consumer\n');
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
  git('init','--quiet');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
  const tokenizer=join(root,'tokenizer.json'),policyFile=join(root,'policy.json'),python=join(root,'python-fixture');
  writeFileSync(tokenizer,'{}');const policy={consumerRevision:git('rev-parse','HEAD'),
    tokenizerSha256:createHash('sha256').update('{}').digest('hex'),tokenizerIdentity:'unit-fixture-not-a-production-tokenizer'};
  writeFileSync(policyFile,JSON.stringify(policy));
  const queryResult=path=>writeFileSync(python,'#!/usr/bin/env node\nprocess.stdout.write('+JSON.stringify(JSON.stringify({moduleFile:path}))+');\n',{mode:0o755});
  queryResult(module);
  const options={megatoken:repo,tokenizer,policyFile,python,temporaryDirectory:root};
  assert.equal(loadNativeSettings(options).policy.consumerRevision,policy.consumerRevision);
  writeFileSync(module,'# same HEAD, modified implementation\n');
  assert.throws(()=>loadNativeSettings(options),/uncommitted tracked changes/);
  git('checkout','--','src/megatoken/__init__.py');
  const elsewhere=join(root,'other-megatoken.py');writeFileSync(elsewhere,'# unrelated installed module\n');
  queryResult(elsewhere);
  assert.throws(()=>loadNativeSettings(options),/outside the pinned consumer checkout/);
});
