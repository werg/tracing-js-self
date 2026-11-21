import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {generationIdentity} from '../src/corpus/campaign-identity.mjs';
import {identityHash} from '../src/corpus/campaign-store.mjs';

test('receipt cache identity binds Python verifier code, operation catalog, locks and isolation policy',t=>{
  const root=mkdtempSync(join(tmpdir(),'generation-identity-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const folder of ['src','tools','contracts','profiles','corpus','catalog'])mkdirSync(join(root,folder));
  const write=(path,bytes)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),bytes);};
  for(const packageName of ['acorn','typescript'])write('node_modules/'+packageName+'/package.json','{"version":"1.0.0"}');
  write('npm-shrinkwrap.json','{}');write('catalog/operations.json','{"operation":"one"}');
  write('tools/verifier.py','original_verifier = True');write('tools/native-consumer/requirements.lock','pinned-lock');
  const options={producerRevision:'a'.repeat(40),recipe:'engineering'};
  let previous=generationIdentity(root,options);
  for(const [path,value] of [['tools/verifier.py','changed_verifier = True'],
      ['catalog/operations.json','{"operation":"changed"}'],
      ['tools/native-consumer/requirements.lock','changed-lock']]){
    write(path,value);
    const current=generationIdentity(root,options);
    assert.notEqual(current.producerSourceTreeDigest,previous.producerSourceTreeDigest,path);
    previous=current;
  }
  write('npm-shrinkwrap.json','{"changed":"dependency"}');
  const changedLock=generationIdentity(root,options);
  assert.notEqual(changedLock.dependencyLockSha256,previous.dependencyLockSha256);
  const original=process.env.TRACING_REFERENCE_ISOLATION;
  try{
    process.env.TRACING_REFERENCE_ISOLATION='trusted-process';
    const trusted=generationIdentity(root,options);
    process.env.TRACING_REFERENCE_ISOLATION='linux-namespace';
    const isolated=generationIdentity(root,options);
    assert.notEqual(identityHash(trusted),identityHash(isolated));
    assert.equal(isolated.referenceIsolation.addressSpaceBytes,1024**3);
  }finally{if(original===undefined)delete process.env.TRACING_REFERENCE_ISOLATION;else process.env.TRACING_REFERENCE_ISOLATION=original;}
});
