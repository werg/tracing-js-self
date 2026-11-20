#!/usr/bin/env node
// Catalog only exact locally available pinned bytes. No test is executed and
// missing official harness/specification bytes are never represented as passes.
import {readFileSync,readdirSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {resolve,dirname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {buildTest262Catalog,createTest262Campaign,summarizeTest262Campaign,conformanceDigest}
  from '../src/conformance/test262-catalog.js';
import {acquireTest262GitSnapshot,discoverTest262ModuleDependencies} from '../src/conformance/test262-acquisition.js';

const root=fileURLToPath(new URL('..',import.meta.url)),flags=new Map();
for(let i=2;i<process.argv.length;i++){
  const key=process.argv[i],value=process.argv[++i];
  if(!['--snapshot','--suite-root','--revision','--out','--cases','--specification-file','--specification-uri'].includes(key)||flags.has(key)||!value||value.startsWith('--'))
    throw new TypeError('Usage: node tools/catalog-test262.mjs --out catalog.json [--snapshot lock.json | --suite-root DIR --revision COMMIT] [--cases variant-id,...] [--specification-file FILE --specification-uri URI]');
  flags.set(key,value);
}
if(!flags.has('--out'))throw new TypeError('--out is required');
let snapshot,sources;
if(flags.has('--revision')){
  if(!flags.has('--suite-root')||flags.has('--snapshot'))throw new TypeError('--revision requires --suite-root and excludes --snapshot');
  ({snapshot,sources}=acquireTest262GitSnapshot({suiteRoot:flags.get('--suite-root'),revision:flags.get('--revision')}));
}else{
  const snapshotPath=resolve(flags.get('--snapshot')??join(root,'corpus/extension/snapshots/test262/snapshot.lock.json'));
  const suiteRoot=resolve(flags.get('--suite-root')??dirname(snapshotPath));
  snapshot=JSON.parse(readFileSync(snapshotPath,'utf8'));sources={};
  for(const path of Object.keys(snapshot.files??{})){
    if(!/^(?:test|harness)\/[A-Za-z0-9_./+@-]+\.js$/.test(path)||path.split('/').some(part=>['.','..',''].includes(part)))
      throw new TypeError('Unsafe snapshot path');
    sources[path]=readFileSync(join(suiteRoot,path));
  }
}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
if(flags.has('--specification-file')!==flags.has('--specification-uri'))
  throw new TypeError('Supply specification bytes and their exact source URI together');
const specification=flags.has('--specification-file')?
  {uri:flags.get('--specification-uri'),sha256:digest(readFileSync(resolve(flags.get('--specification-file'))))}:null;
const sourceFiles=[];
function collect(directory){
  for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const path=join(directory,entry.name);
    if(entry.isDirectory())collect(path);
    else if(entry.isFile()&&/\.(?:js|mjs|json)$/.test(path))sourceFiles.push([relative(root,path),digest(readFileSync(path))]);
  }
}
collect(join(root,'src'));
sourceFiles.push(['package-lock.json',digest(readFileSync(join(root,'package-lock.json')))]);
const profile={name:'frozen-test262-acquisition',edition:'ECMAScript 2026',specification,
  parser:{name:'bounded-pratt',version:'2',implementationDigest:digest(readFileSync(join(root,'src/frontend.js')))},
  hostProfile:{name:'single-agent-owned-script',moduleResolver:'not-qualified',
    reference:{node:process.version,v8:process.versions.v8}},
  resourcePolicy:{maxSteps:20000,maxSourceBytes:1048576},
  limits:[...(specification?[]:['Specification bytes are not retained by this acquisition.']),
    'Edition membership remains unclassified; suite acquisition is distinct from full edition inventory.',
    'Official harness availability is recorded per variant. No conformance stage runs in this command.']};
const catalog=buildTest262Catalog({snapshot,sources,profile,moduleDependencies:discoverTest262ModuleDependencies(sources)});
const implementation={producerRevision:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  codeDigest:conformanceDigest(sourceFiles),runnerDigest:conformanceDigest([
    ['catalog-test262.mjs',digest(readFileSync(fileURLToPath(import.meta.url)))],
    ['test262-catalog.js',digest(readFileSync(join(root,'src/conformance/test262-catalog.js')))],
    ['test262-acquisition.js',digest(readFileSync(join(root,'src/conformance/test262-acquisition.js')))]]),
  node:process.version,v8:process.versions.v8};
const campaign=createTest262Campaign({catalog,implementation,
  selectedIds:flags.has('--cases')?flags.get('--cases').split(','):null});
const output=resolve(flags.get('--out')),report={catalog,campaign,summary:summarizeTest262Campaign(campaign)};
mkdirSync(dirname(output),{recursive:true});
writeFileSync(output+'.tmp',JSON.stringify(report,null,2)+'\n');renameSync(output+'.tmp',output);
console.log(JSON.stringify({output,catalogDigest:catalog.digest,catalog:catalog.summary,
  campaignIdentity:campaign.identityDigest,selected:campaign.selectedIds.length,executed:0}));
