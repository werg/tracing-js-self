#!/usr/bin/env node
// Independent, bounded source correspondence check for the native consumer.
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {recheckRegionEvidence} from '../src/semantic/compiler-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

const fail=message=>{throw new Error(`Native source recheck: ${message}`);};
export const MAX_SOURCE_ARTIFACT_BYTES=64*1024*1024;
export async function readSourceArtifactBytes(input){
  const file=await open(input,constants.O_RDONLY|constants.O_NONBLOCK);
  try{
    const before=await file.stat();
    if(!before.isFile())fail('artifact must be a regular file');
    if(before.size>MAX_SOURCE_ARTIFACT_BYTES)fail('artifact exceeds byte limit');
    // One extra byte detects growth without an unbounded readFile allocation.
    const buffer=Buffer.alloc(before.size+1);let length=0;
    while(length<buffer.length){
      const {bytesRead}=await file.read(buffer,length,buffer.length-length,length);
      if(bytesRead===0)break;
      length+=bytesRead;
    }
    const after=await file.stat();
    if(length>MAX_SOURCE_ARTIFACT_BYTES||after.size>MAX_SOURCE_ARTIFACT_BYTES)
      fail('artifact exceeds byte limit');
    if(length!==before.size||['size','mtimeMs','ctimeMs'].some(key=>before[key]!==after[key]))
      fail('artifact changed while reading');
    return buffer.subarray(0,length);
  }finally{await file.close();}
}

async function main(){
  function arg(name){const i=process.argv.indexOf(name);if(i<0||!process.argv[i+1])fail(`missing ${name}`);return process.argv[i+1];}
  const root=resolve(arg('--producer-root'));
  const expected=arg('--producer-revision');
  const input=resolve(arg('--input'));
  const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  const dirty=execFileSync('git',['status','--porcelain','--untracked-files=all'],{cwd:root,encoding:'utf8'}).trim();
  if(revision!==expected||dirty)fail('producer checkout is not the exact clean pinned revision');
  const bytes=await readSourceArtifactBytes(input);
  const exported=JSON.parse(bytes.toString('utf8'));
  if(!exported||typeof exported!=='object'||!exported.public||!Array.isArray(exported.contexts)||!exported.sidecar)
    fail('expected a complete public/context/source evidence artifact');
  const checked=await recheckRegionEvidence(exported,{requireNative:false});
  if(checked.valid!==true||checked.sourceValidated!==true||checked.projectionValidated!==true||checked.replayValidated!==true)
    fail('independent source, projection, or V8 replay check did not pass');
  const after=execFileSync('git',['status','--porcelain','--untracked-files=all'],{cwd:root,encoding:'utf8'}).trim();
  if(after)fail('producer checkout changed during source recheck');
  const sha=value=>hashAlgorithmData(JSON.parse(JSON.stringify(value)));
  const direct=exported.sidecar.schema==='semantic-protocol-host-region-evidence/1';
  if(direct&&checked.source?.identityValidated!==true)fail('direct source identity was not independently verified');
  const receipt={schema:'semantic-native-source-recheck/1',producerRevision:revision,producerTreeClean:true,
    artifactSha256:createHash('sha256').update(bytes).digest('hex'),
    sourceArtifactDigest:direct?null:sha(exported.sidecar.sourceArtifact),
    ...(direct?{sourceIdentityDigest:exported.sidecar.identityDigest,identityValidated:true}:{}),
    publicDigest:sha(exported.public),
    contextDigest:sha(exported.contexts),sourceValidated:true,projectionValidated:true,replayValidated:true,
    ...(Object.hasOwn(exported.sidecar,'orchestrationTranscript')?{
      orchestrationTranscriptDigest:sha(exported.sidecar.orchestrationTranscript),
      orchestrationValidated:checked.orchestrationValidated===true}:{}),
    regionRecords:checked.regionCoverage?.records??null};
  process.stdout.write(JSON.stringify(receipt)+'\n');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))await main();
