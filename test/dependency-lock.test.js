import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readDependencyLock,PACKAGED_DEPENDENCY_LOCK} from '../src/dependency-lock.js';

test('checkout and packaged execution bind identical dependency bytes and refuse missing or divergent evidence',t=>{
  const root=mkdtempSync(join(tmpdir(),'dependency-evidence-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'contracts'));
  const lock=Buffer.from('{"lockfileVersion":3,"packages":{}}\n'),
    source=join(root,'package-lock.json'),packaged=join(root,PACKAGED_DEPENDENCY_LOCK);
  writeFileSync(source,lock);writeFileSync(packaged,lock);
  assert.deepEqual(readDependencyLock(root),lock);
  writeFileSync(packaged,Buffer.concat([lock,Buffer.from('\n')]));
  assert.throws(()=>readDependencyLock(root),/differs from its packaged evidence/);
  writeFileSync(packaged,lock);rmSync(source);
  assert.deepEqual(readDependencyLock(root),lock,'installed packages retain the exact omitted root lock');
  rmSync(packaged);
  assert.throws(()=>readDependencyLock(root),error=>error.code==='ENOENT'&&error.path===packaged);
  writeFileSync(source,lock);
  assert.throws(()=>readDependencyLock(root),error=>error.code==='ENOENT'&&error.path===packaged,
    'an ungenerated package cannot claim complete lock evidence');
});

test('the publishable lock is the exact current npm-ci input',()=>{
  const root=new URL('../',import.meta.url);
  assert.deepEqual(readDependencyLock(root),readFileSync(new URL('package-lock.json',root)));
});
