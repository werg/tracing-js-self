#!/usr/bin/env node
// The collector may run outside the measured checkout. Only a clean, explicitly
// identified producer supplies source projection and independent source recheck.
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';

const args=process.argv.slice(2),options={producer:resolve(new URL('..',import.meta.url).pathname),
  output:resolve(new URL('../test/fixtures/semantic-source-recovery-v8.json.gz.b64',import.meta.url).pathname),check:false};
for(let i=0;i<args.length;i++){
  if(args[i]==='--check')options.check=true;
  else if(['--producer','--output'].includes(args[i])&&args[i+1])options[args[i].slice(2)]=resolve(args[++i]);
  else throw new Error('Usage: generate-source-recovery-v8-fixtures.mjs [--producer CLEAN_CHECKOUT] [--output FILE] [--check]');
}
const git=(...args)=>execFileSync('git',['-C',options.producer,...args],{encoding:'utf8'}).trim();
const snapshot=()=>{
  if(git('status','--porcelain','--untracked-files=all'))throw new Error('Source authority must be a clean checkout');
  return {revision:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD:')};
};
const identity=snapshot();
const {verifyRegionTrainingCase,recheckRegionEvidence}=await import(pathToFileURL(resolve(options.producer,'src/semantic/compiler-v8.js')));
const {SEMANTIC_GALLERY_FIXTURES}=await import(pathToFileURL(resolve(options.producer,'src/training/semantic-trace-gallery.js')));
const original=SEMANTIC_GALLERY_FIXTURES.find(row=>row.id==='counter-0');
if(!original)throw new Error('Original counter fixture is missing');
const fixture={...structuredClone(original),id:'source-reread-after-await',
  projectionOptions:{checkpointAtFirstAwait:true},producerRevision:identity.revision};
const result=await verifyRegionTrainingCase(fixture);
if(result.status!=='locally_verified'||!result.exported)throw new Error(JSON.stringify(result));
const recheck=await recheckRegionEvidence(result.exported);
if(!recheck.valid||!recheck.sourceValidated||!recheck.replayValidated)throw new Error('Original-source recovery recheck failed');
if(JSON.stringify(snapshot())!==JSON.stringify(identity))throw new Error('Source authority changed during collection');
const artifact={schema:'semantic-source-recovery-fixtures/1',producer:identity,
  qualification:{source:'fresh-original-source-and-projection-recheck',native:'untested',tokenizer:'unmeasured',model:'unmeasured'},
  cases:[{id:fixture.id,fixture,artifact:result.exported,recheck}]};
const bytes=gzipSync(Buffer.from(JSON.stringify(artifact)+'\n')).toString('base64')+'\n';
if(options.check){if(await readFile(options.output,'utf8')!==bytes)throw new Error('Source recovery fixture differs; regenerate explicitly');}
else await writeFile(options.output,bytes);
console.log(JSON.stringify({valid:true,mode:options.check?'checked':'generated',producer:identity,
  cases:artifact.cases.map(({id,artifact})=>({id,records:artifact.public.timeline.length,
    publicDigest:artifact.sidecar.publicDigest,contextDigest:artifact.sidecar.contextDigest})),
  qualification:artifact.qualification}));
