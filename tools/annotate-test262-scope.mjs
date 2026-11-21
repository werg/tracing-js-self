#!/usr/bin/env node
// Attach narrow pinned-grammar notes to existing Test262 campaign rows.
// No rows are filtered and no parser result is changed.
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireTest262GitSnapshot} from '../src/conformance/test262-acquisition.js';
import {readPinnedEcma262Specification} from '../src/conformance/test262-specification.js';
import {assertNewScopeOutput,buildTest262ScopeAnnotations,writeNewScopeReport} from '../src/conformance/test262-scope-annotations.js';
import {conformanceDigest} from '../src/conformance/test262-catalog.js';

const options=new Map();
for(let i=2;i<process.argv.length;i++){
  const key=process.argv[i],value=process.argv[++i];
  if(!['--catalog','--suite-root','--campaign','--triage','--producer-root','--out'].includes(key)||options.has(key)||!value||value.startsWith('--'))
    throw new TypeError('Usage: annotate-test262-scope.mjs --catalog CATALOG[.xz] --suite-root DIR --campaign REPORT.json[.xz] --triage TRIAGE.json --producer-root EXACT_CLEAN_PRODUCER_DIR --out NEW_ANNOTATIONS.json[.xz]');
  options.set(key,value);
}
for(const key of ['--catalog','--suite-root','--campaign','--triage','--producer-root','--out'])
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
const output=resolve(options.get('--out'));assertNewScopeOutput(output);
const producerRoot=resolve(options.get('--producer-root'));
const git=(path,...args)=>execFileSync('git',['-C',path,...args],{encoding:'utf8'}).trim();
const scopeProducerRevision=git(root,'rev-parse','HEAD'),scopeProducerTree=git(root,'rev-parse','HEAD^{tree}');
if(git(root,'status','--porcelain','--untracked-files=all'))
  throw new TypeError('Scope annotation tool requires a clean committed checkout');
const campaignProducerRevision=campaign.campaign?.implementation?.producerRevision;
if(!/^[a-f0-9]{40}$/.test(campaignProducerRevision??'')||
  git(producerRoot,'rev-parse','HEAD')!==campaignProducerRevision||
  git(producerRoot,'status','--porcelain','--untracked-files=all'))
  throw new TypeError('Campaign producer root must be clean at its exact recorded revision');
const campaignImplementation=campaign.campaign.implementation;
if(!Array.isArray(campaignImplementation.files)||conformanceDigest(campaignImplementation.files)!==campaignImplementation.codeDigest)
  throw new TypeError('Campaign implementation identity is malformed');
for(const file of campaignImplementation.files){
  if(typeof file.path!=='string'||file.path.startsWith('/')||file.path.split('/').some(part=>['','..','.'].includes(part))||
    createHash('sha256').update(readFileSync(resolve(producerRoot,file.path))).digest('hex')!==file.sha256)
    throw new TypeError('Campaign producer bytes differ from its implementation fingerprint: '+file.path);
}
const {snapshot,sources}=acquireTest262GitSnapshot({suiteRoot:options.get('--suite-root'),revision:catalog.suiteRevision});
if(catalog.acquisition.fullUpstreamTree!==snapshot.acquisition.fullUpstreamTree||
  catalog.acquisition.treeSha!==snapshot.acquisition.treeSha||
  catalog.files.length!==Object.keys(snapshot.files).length||
  catalog.files.some(file=>snapshot.files[file.path]!==file.gitBlobSha))
  throw new TypeError('Annotation acquisition differs from the frozen upstream Test262 tree');
const {specification,bytes}=readPinnedEcma262Specification({declared:campaign.profile?.specification});
const toolFiles=['src/conformance/test262-scope-annotations.js','src/conformance/test262-catalog.js',
  'src/conformance/test262-acquisition.js','src/conformance/test262-specification.js','src/conformance/test262-campaign.js',
  'src/test262-baseline.js','npm-shrinkwrap.json','tools/annotate-test262-scope.mjs'].map(path=>({path,
    sha256:createHash('sha256').update(readFileSync(new URL('../'+path,import.meta.url))).digest('hex')}));
const toolIdentity={producerRevision:scopeProducerRevision,tree:scopeProducerTree,dirty:false,node:process.version,
  files:toolFiles,digest:conformanceDigest(toolFiles)};
const annotations=buildTest262ScopeAnnotations({catalog,campaign,triage,specification,bytes,sources,toolIdentity});
const implementation={producerRevision:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  tree:scopeProducerTree,dirty:false,node:process.version,files:toolFiles};
const body={schema:'test262-scope-annotation-run/1',implementation,annotations};
const document=Buffer.from(JSON.stringify({...body,digest:conformanceDigest(body)})+'\n');
const encoded=output.endsWith('.xz')?execFileSync('xz',['--compress','--stdout','-6'],{input:document,maxBuffer:document.length+1024*1024}):document;
writeNewScopeReport(output,encoded);
console.log(JSON.stringify({output,digest:annotations.digest,implementation,
  ...annotations.summary,grammarEvidence:annotations.productions}));
