import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,open,rm,truncate,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MAX_SOURCE_ARTIFACT_BYTES,readSourceArtifactBytes} from '../tools/recheck-semantic-native-source.mjs';

async function inputFile(t,content='{}'){
  const folder=await mkdtemp(join(tmpdir(),'native-source-bound-')),path=join(folder,'artifact.json');
  t.after(()=>rm(folder,{recursive:true,force:true}));
  await writeFile(path,content);
  const file=await open(path,'r'),prototype=Object.getPrototypeOf(file);
  await file.close();
  return {folder,path,prototype};
}

test('source artifact reader accepts and preserves every byte at the fixed 64 MiB boundary',async t=>{
  assert.equal(MAX_SOURCE_ARTIFACT_BYTES,64*1024*1024);
  const {path}=await inputFile(t),file=await open(path,'w'),
    header=Buffer.from('{"marker":"original-boundary-payload"}'),fill=Buffer.alloc(1024*1024,32),
    expected=createHash('sha256');
  try{
    await file.writeFile(header);expected.update(header);
    for(let remaining=MAX_SOURCE_ARTIFACT_BYTES-header.length;remaining>0;){
      const chunk=fill.subarray(0,Math.min(fill.length,remaining));
      await file.writeFile(chunk);expected.update(chunk);remaining-=chunk.length;
    }
  }finally{await file.close();}
  const bytes=await readSourceArtifactBytes(path);
  assert.equal(bytes.length,MAX_SOURCE_ARTIFACT_BYTES);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),expected.digest('hex'));
  assert.deepEqual(JSON.parse(bytes.toString('utf8')),{marker:'original-boundary-payload'});
});

test('one byte over the artifact limit is rejected before allocating or reading its contents',async t=>{
  const {path,prototype}=await inputFile(t);
  await truncate(path,MAX_SOURCE_ARTIFACT_BYTES+1);
  const allocation=t.mock.method(Buffer,'alloc',()=>{throw new Error('unexpected content allocation');}),
    read=t.mock.method(prototype,'read',()=>{throw new Error('unexpected content read');});
  try{
    await assert.rejects(readSourceArtifactBytes(path),/Native source recheck: artifact exceeds byte limit/);
    assert.equal(allocation.mock.callCount(),0);assert.equal(read.mock.callCount(),0);
  }finally{allocation.mock.restore();read.mock.restore();}
});

test('non-file artifact input is rejected before allocating or reading contents',async t=>{
  const {folder,prototype}=await inputFile(t),
    allocation=t.mock.method(Buffer,'alloc',()=>{throw new Error('unexpected content allocation');}),
    read=t.mock.method(prototype,'read',()=>{throw new Error('unexpected content read');});
  try{
    await assert.rejects(readSourceArtifactBytes(folder),/artifact must be a regular file|EISDIR|EPERM/);
    assert.equal(allocation.mock.callCount(),0);assert.equal(read.mock.callCount(),0);
  }finally{allocation.mock.restore();read.mock.restore();}
});

for(const [name,size,expected] of [
  ['grows beyond the limit',MAX_SOURCE_ARTIFACT_BYTES+1,/artifact exceeds byte limit/],
  ['grows within the limit',3,/artifact changed while reading/],
  ['shrinks',1,/artifact changed while reading/]
])test(`source artifact reader refuses a file that ${name} after its metadata check`,async t=>{
  const {path,prototype}=await inputFile(t),originalRead=prototype.read;
  let changed=false,maxBufferBytes=0;
  const read=t.mock.method(prototype,'read',async function(...args){
    maxBufferBytes=Math.max(maxBufferBytes,args[0].length);
    if(!changed){changed=true;await truncate(path,size);}
    return Reflect.apply(originalRead,this,args);
  });
  try{
    await assert.rejects(readSourceArtifactBytes(path),expected);
    assert.equal(changed,true);
    assert.equal(maxBufferBytes,3,'concurrent growth cannot enlarge the bounded read buffer');
  }finally{read.mock.restore();}
});
