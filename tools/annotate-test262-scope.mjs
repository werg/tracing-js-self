#!/usr/bin/env node
// Attach narrow pinned-grammar notes to existing Test262 campaign rows.
// No rows are filtered and no parser result is changed.
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireTest262GitSnapshot} from '../src/conformance/test262-acquisition.js';
import {readPinnedEcma262Specification} from '../src/conformance/test262-specification.js';
import {buildTest262ScopeAnnotations} from '../src/conformance/test262-scope-annotations.js';
import {conformanceDigest} from '../src/conformance/test262-catalog.js';

const options=new Map();
for(let i=2;i<process.argv.length;i++){
  const key=process.argv[i],value=process.argv[++i];
  if(!['--catalog','--suite-root','--campaign','--triage','--out'].includes(key)||options.has(key)||!value||value.startsWith('--'))
    throw new TypeError('Usage: annotate-test262-scope.mjs --catalog CATALOG[.xz] --suite-root DIR --campaign REPORT.json[.xz] --triage TRIAGE.json --out ANNOTATIONS.json[.xz]');
  options.set(key,value);
}
for(const key of ['--catalog','--suite-root','--campaign','--triage','--out'])
  if(!options.has(key))throw new TypeError('Required '+key);
const root=fileURLToPath(new URL('..',import.meta.url));
const readJson=path=>{
  const absolute=resolve(path),bytes=absolute.endsWith('.xz')?
    execFileSync('xz',['--decompress','--stdout','--',absolute],{maxBuffer:512*1024*1024}):readFileSync(absolute);
  return JSON.parse(bytes.toString('utf8'));
};
const catalog=readJson(options.get('--catalog'));
const campaign=readJson(options.get('--campaign'));
const triage=readJson(options.get('--triage'));
const {snapshot,sources}=acquireTest262GitSnapshot({suiteRoot:options.get('--suite-root'),revision:catalog.suiteRevision});
if(catalog.acquisition.fullUpstreamTree!==snapshot.acquisition.fullUpstreamTree||
  catalog.acquisition.treeSha!==snapshot.acquisition.treeSha||
  catalog.files.length!==Object.keys(snapshot.files).length||
  catalog.files.some(file=>snapshot.files[file.path]!==file.gitBlobSha))
  throw new TypeError('Annotation acquisition differs from the frozen upstream Test262 tree');
const {specification,bytes}=readPinnedEcma262Specification({declared:campaign.profile?.specification});
const annotations=buildTest262ScopeAnnotations({catalog,campaign,triage,specification,bytes,sources});
const implementation={producerRevision:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  node:process.version,files:['src/conformance/test262-scope-annotations.js','src/conformance/test262-catalog.js',
    'src/conformance/test262-acquisition.js','src/conformance/test262-specification.js',
    'src/test262-baseline.js','package-lock.json','tools/annotate-test262-scope.mjs'].map(path=>({path,
      sha256:createHash('sha256').update(readFileSync(new URL('../'+path,import.meta.url))).digest('hex')}))};
const body={schema:'test262-scope-annotation-run/1',implementation,annotations};
const output=resolve(options.get('--out')),document=Buffer.from(JSON.stringify({...body,digest:conformanceDigest(body)})+'\n');
mkdirSync(dirname(output),{recursive:true});
const encoded=output.endsWith('.xz')?execFileSync('xz',['--compress','--stdout','-6'],{input:document,maxBuffer:document.length+1024*1024}):document;
writeFileSync(output+'.tmp',encoded);renameSync(output+'.tmp',output);
console.log(JSON.stringify({output,digest:annotations.digest,implementation,
  ...annotations.summary,grammarEvidence:annotations.productions}));
