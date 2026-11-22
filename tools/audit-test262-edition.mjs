#!/usr/bin/env node
// Reconcile every retained variant's descriptive reference with the actual
// pinned annual specification. This command does not execute or classify tests.
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireTest262GitSnapshot} from '../src/conformance/test262-acquisition.js';
import {readPinnedEcma262Specification} from '../src/conformance/test262-specification.js';
import {buildTest262EditionAudit} from '../src/conformance/test262-edition.js';
import {conformanceDigest} from '../src/conformance/test262-catalog.js';

const options=new Map();
for(let i=2;i<process.argv.length;i++){
  const key=process.argv[i],value=process.argv[++i];
  if(!['--catalog','--suite-root','--out','--python'].includes(key)||options.has(key)||!value||value.startsWith('--'))
    throw new TypeError('Usage: audit-test262-edition.mjs --catalog CATALOG[.xz] --suite-root DIR --out REPORT.json[.xz] [--python PYTHON]');
  options.set(key,value);
}
for(const key of ['--catalog','--suite-root','--out'])if(!options.has(key))throw new TypeError('Required '+key);
const root=fileURLToPath(new URL('..',import.meta.url)),catalogPath=resolve(options.get('--catalog'));
const catalogBytes=catalogPath.endsWith('.xz')?execFileSync('xz',['--decompress','--stdout','--',catalogPath],
  {maxBuffer:1024*1024*1024}):readFileSync(catalogPath);
const catalog=JSON.parse(catalogBytes);
const {snapshot,sources}=acquireTest262GitSnapshot({suiteRoot:options.get('--suite-root'),revision:catalog.suiteRevision});
if(catalog.acquisition.fullUpstreamTree!==snapshot.acquisition.fullUpstreamTree||
   catalog.acquisition.treeSha!==snapshot.acquisition.treeSha||
   catalog.files.length!==Object.keys(snapshot.files).length||
   catalog.files.some(file=>snapshot.files[file.path]!==file.gitBlobSha))
  throw new TypeError('Audit acquisition differs from the frozen upstream tree');
const {specification,bytes}=readPinnedEcma262Specification();
const report=buildTest262EditionAudit({catalog,sources,specification,bytes,python:options.get('--python')??'python3'});
const implementation={producerRevision:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:execFileSync('git',['-C',root,'status','--porcelain','--untracked-files=all'],{encoding:'utf8'}).trim()!=='',
  node:process.version,files:['src/conformance/test262-edition.js','src/conformance/ecma262-html-inventory.py',
    'src/conformance/test262-catalog.js','src/conformance/test262-acquisition.js',
    'src/conformance/test262-specification.js','src/test262-baseline.js',
    'npm-shrinkwrap.json','tools/audit-test262-edition.mjs'].map(path=>({path,
      sha256:createHash('sha256').update(readFileSync(new URL('../'+path,import.meta.url))).digest('hex')}))};
const body={schema:'test262-edition-audit-run/1',implementation,report};
const output=resolve(options.get('--out')),document=Buffer.from(JSON.stringify({...body,digest:conformanceDigest(body)})+'\n');
mkdirSync(dirname(output),{recursive:true});
const encoded=output.endsWith('.xz')?execFileSync('xz',['--compress','--stdout','-6'],{input:document,maxBuffer:document.length+1024*1024}):document;
writeFileSync(output+'.tmp',encoded);renameSync(output+'.tmp',output);
console.log(JSON.stringify({output,digest:report.digest,implementation,...report.summary}));
