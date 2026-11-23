#!/usr/bin/env node
// Acquire the actual selected checkout. A catalog records observed inputs;
// neither an edition classification nor execution success defines its size.
import {readFileSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {buildTest262Catalog,createTest262Campaign,summarizeTest262Campaign,conformanceDigest,safeTest262Path}
  from '../src/conformance/test262-catalog.js';
import {acquireTest262GitSnapshot,discoverTest262ModuleDependencies} from '../src/conformance/test262-acquisition.js';
import {ownedTest262Profile} from '../src/conformance/test262-runner.js';
import {fingerprintTest262Implementation,writeTest262Json} from '../src/conformance/test262-campaign.js';

const flags=new Map();
for(let i=2;i<process.argv.length;i++){
  const key=process.argv[i],value=process.argv[++i];
  if(!['--snapshot','--suite-root','--revision','--out','--cases','--specification-file','--specification-uri'].includes(key)||
    flags.has(key)||!value||value.startsWith('--'))
    throw new TypeError('Usage: node tools/catalog-test262.mjs --out catalog.json --suite-root DIR [--revision COMMIT] [--cases variant-id,...] [--specification-file FILE --specification-uri URI]');
  flags.set(key,value);
}
if(!flags.has('--out'))throw new TypeError('--out is required');
if(!flags.has('--suite-root')&&!flags.has('--snapshot'))
  throw new TypeError('Supply the current --suite-root or an explicit retained --snapshot');
let snapshot,sources;
if(!flags.has('--snapshot')){
  ({snapshot,sources}=acquireTest262GitSnapshot({suiteRoot:flags.get('--suite-root'),revision:flags.get('--revision')}));
}else{
  if(flags.has('--revision'))throw new TypeError('--revision cannot be combined with --snapshot');
  const snapshotPath=resolve(flags.get('--snapshot'));
  const suiteRoot=resolve(flags.get('--suite-root')??dirname(snapshotPath));
  snapshot=JSON.parse(readFileSync(snapshotPath,'utf8'));sources={};
  for(const path of Object.keys(snapshot.files??{})){
    if(!safeTest262Path(path))throw new TypeError('Unsafe snapshot path');
    sources[path]=readFileSync(join(suiteRoot,path));
  }
}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
if(flags.has('--specification-file')!==flags.has('--specification-uri'))
  throw new TypeError('Supply specification bytes and their actual source URI together');
let specification=null;
if(flags.has('--specification-file')){
  const uri=flags.get('--specification-uri'),url=new URL(uri);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)
    throw new TypeError('Specification source URI must be an HTTP(S) URL without credentials');
  const bytes=readFileSync(resolve(flags.get('--specification-file')));
  specification={uri,sha256:digest(bytes),bytes:bytes.length};
}
const profile=ownedTest262Profile({specification});
const catalog=buildTest262Catalog({snapshot,sources,profile,moduleDependencies:discoverTest262ModuleDependencies(sources)});
const current=fingerprintTest262Implementation();
const files=[...current.files,{path:'tools/catalog-test262.mjs',sha256:digest(readFileSync(new URL(import.meta.url)))}]
  .sort((a,b)=>a.path.localeCompare(b.path));
const implementation={...current,files,codeDigest:conformanceDigest(files),
  runnerDigest:conformanceDigest(files.filter(file=>file.path.startsWith('src/conformance/')||file.path.startsWith('tools/')))};
const campaign=createTest262Campaign({catalog,implementation,
  selectedIds:flags.has('--cases')?flags.get('--cases').split(','):null});
const output=resolve(flags.get('--out')),report={catalog,campaign,summary:summarizeTest262Campaign(campaign)};
writeTest262Json(output,report);
console.log(JSON.stringify({output,catalogDigest:catalog.digest,catalog:catalog.summary,
  campaignIdentity:campaign.identityDigest,selected:campaign.selectedIds.length,executed:0}));
