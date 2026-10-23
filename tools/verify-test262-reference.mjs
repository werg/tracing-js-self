#!/usr/bin/env node
// Explicitly opt-in, OFFLINE diagnostic execution of a trusted pinned Test262
// checkout. Do not use this in-process VM runner for untrusted repositories.
import {readFileSync,writeFileSync,mkdirSync,realpathSync,createReadStream,createWriteStream} from 'node:fs';
import {resolve,join,dirname,relative,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {finished} from 'node:stream/promises';
import {addNativeCatalogIdentity,nativeReferenceDigest,validateAcquiredTest262,shardForOrdinal}
  from '../src/corpus/native-reference-shards.mjs';
import vm from 'node:vm';
import {executeTest262ModuleReference} from '../src/corpus/test262-module-reference.mjs';
import {importers} from '../src/corpus/import-external.mjs';
import {executeTest262Reference} from '../src/corpus/test262-reference-execution.mjs';
import {executeTest262AsyncReference} from '../src/corpus/test262-async-reference.mjs';

const argv=process.argv.slice(2);
const value=(name,fallback)=>{const i=argv.indexOf('--'+name);
  if(i<0)return fallback;
  if(!argv[i+1]||argv[i+1].startsWith('--'))throw new Error('Missing --'+name);
  return argv[i+1];};
const root=realpathSync(resolve(value('root','')));
const revision=value('revision',null);
const max=Number(value('max','500'));
const timeoutMs=Number(value('timeout-ms','250'));
const output=resolve(value('output','corpus/out/test262-reference-diagnostics.json'));
const input=value('input',null),rowsOutput=value('rows-output',null);
const shardCount=Number(value('shard-count','1'));
const shardIndex=Number(value('shard-index','0'));
const expectEnumerated=value('expect-enumerated',null);
if(!Number.isSafeInteger(shardCount)||shardCount<1||shardCount>64||
  !Number.isSafeInteger(shardIndex)||shardIndex<0||shardIndex>=shardCount||
  shardCount>1&&!rowsOutput)
 throw new Error('Sharding requires valid index/count and streaming --rows-output');
if(expectEnumerated!==null&&(!/^\d+$/.test(expectEnumerated)||
  Number(expectEnumerated)<1||!Number.isSafeInteger(Number(expectEnumerated))))
 throw new Error('Invalid expected acquired inventory count');
if(!revision||!/^[a-f0-9]{40}$/.test(revision))throw new Error('Require full pinned --revision');
if(!Number.isSafeInteger(max)||max<1||max>10000||
   !Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>1000)
  throw new Error('Invalid execution bounds');
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
if(git('rev-parse','HEAD')!==revision)throw new Error('Pinned revision mismatch');
if(git('status','--porcelain','--untracked-files=no'))throw new Error('Dirty tracked upstream checkout');
const safeFile=(name)=>{
  if(!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.js$/.test(name)||name.includes('..'))
    return null;
  const p=realpathSync(join(root,'harness',name));
  const rel=relative(join(root,'harness'),p);
  if(rel.startsWith('..'+sep)||rel==='..'||rel.startsWith(sep))
    throw new Error('Harness symlink escaped pinned checkout');
  return readFileSync(p,'utf8');
};
// Resolve exact test fixtures only inside the pinned checkout's test/ tree.
const safeModuleSource=name=>{
  if(typeof name!=='string'||!name.startsWith('test/')||
     !/^[A-Za-z0-9_./-]+\.js$/.test(name)||name.split('/').includes('..'))
    throw new Error('Unsafe module path');
  const file=realpathSync(join(root,name));
  const rel=relative(join(root,'test'),file);
  if(rel==='..'||rel.startsWith('..'+sep)||rel.startsWith(sep))
    throw new Error('Module fixture escaped pinned Test262 test directory');
  return readFileSync(file,'utf8');
};
const harness={};
const sha256=text=>createHash('sha256').update(text).digest('hex');
const rows=[],counts={},seen=new Set(),allIds=new Set();
const catalogDigest=nativeReferenceDigest(),rowsDigest=createHash('sha256');
let enumerated=0,eligible=0,rowsBytes=0;
mkdirSync(dirname(output),{recursive:true});
if(rowsOutput)mkdirSync(dirname(resolve(rowsOutput)),{recursive:true});
const stream=rowsOutput?createWriteStream(resolve(rowsOutput),{encoding:'utf8'}):null;
async function* acquiredRows(){
 if(input){
  for await(const line of createInterface({input:createReadStream(resolve(input)),
    crlfDelay:Infinity})){
   if(line.trim())yield JSON.parse(line);
  }
 }else yield* importers.test262(root,{
   project:'tc39/test262',repository:'tc39/test262',revision,license:'BSD-3-Clause'
 });
}
for await(const untrustedRow of acquiredRows()){
 if(!input&&!rowsOutput&&shardCount===1&&expectEnumerated===null&&seen.size>=max)break;
 const row=validateAcquiredTest262(untrustedRow,revision);
 const ordinal=enumerated++;
 addNativeCatalogIdentity(catalogDigest,row,ordinal);
 if(allIds.has(row.id))throw new Error('Duplicate acquired Test262 source/variant identity');
 allIds.add(row.id);
 if(shardForOrdinal(ordinal,shardCount)!==shardIndex)continue;
 eligible++;
 if(eligible>max)continue;
 const sourceFile=realpathSync(join(root,row.provenance.path));
 const safeRoot=realpathSync(join(root,'test'));
 const relativeSource=relative(safeRoot,sourceFile);
 if(relativeSource==='..'||relativeSource.startsWith('..'+sep)||
   relativeSource.startsWith(sep))
  throw new Error('Source escaped pinned Test262 test directory');
 const source=readFileSync(sourceFile,'utf8');
  if(sha256(source)!==row.provenance.sha256)throw new Error('Source changed during acquisition');
  const names=['sta.js','assert.js',...row.program.harness];
  const sources={};
  for(const name of new Set(names)){
    if(!(name in harness)){
      try{harness[name]=safeFile(name);}catch(error){
        if(error?.code==='ENOENT')harness[name]=null;
        else throw error;
      }
    }
    if(harness[name]!==null)sources[name]=harness[name];
  }
  const metadata={metadataStatus:row.status==='metadata-review'?'unparsed':'parsed',
    flags:row.program.flags,features:row.program.features,
    includes:row.program.harness.filter(n=>!['sta.js','assert.js'].includes(n)),
    negative:row.expected.kind==='expected-error'?{
      phase:row.expected.phase,type:row.expected.type}:null};
  const result=row.program.mode==='module'
    ?await executeTest262ModuleReference({
      source,metadata,harnessSources:sources,filename:row.provenance.path,timeoutMs,
      loadModuleSource:async filename=>{
        try{return safeModuleSource(filename);}
        catch(error){
          if(error?.code==='ENOENT')return null;
          throw error;
        }
      }
    })
    :metadata.flags.includes('async')
      ?await executeTest262AsyncReference({source,metadata,mode:row.program.mode,
        harnessSources:sources,filename:row.provenance.path,timeoutMs})
      :executeTest262Reference({source,metadata,mode:row.program.mode,
        harnessSources:sources,filename:row.provenance.path,timeoutMs});
  const diagnostic={ordinal,id:row.id,path:row.provenance.path,
    mode:row.program.mode,sourceSha256:row.provenance.sha256,
    expected:row.expected,...result};
  if(seen.has(diagnostic.ordinal))throw new Error('Duplicate native source ordinal');
  seen.add(diagnostic.ordinal);
  if(stream){
   const line=JSON.stringify(diagnostic)+'\n';
   rowsDigest.update(line);rowsBytes+=Buffer.byteLength(line);
   if(!stream.write(line))await once(stream,'drain');
  }else rows.push(diagnostic);
  counts[result.status]=(counts[result.status]??0)+1;
}
if(stream){stream.end();await finished(stream);}
if(expectEnumerated!==null&&enumerated!==Number(expectEnumerated))
 throw new Error('Pinned acquired inventory count mismatch');
const report={schema:'test262-native-reference-report/1',revision,
  authority:'native-v8-diagnostic-only',verifiedOwned:0,admitted:0,
  attempted:seen.size,counts,limits:{max,timeoutMs},
  enumerated,catalogFingerprint:catalogDigest.digest('hex'),
  shard:{index:shardIndex,count:shardCount,eligible,truncated:eligible>seen.size},
  ...(stream?{rowsSha256:rowsDigest.digest('hex'),rowsBytes,
    rowsFile:resolve(rowsOutput)}:{}),
  node:process.version,moduleVmEnabled:typeof vm.SourceTextModule==='function',
  ...(stream?{}:{rows}),warnings:[
   'Native V8 execution is not an owned semantic trace, an independent engine conformance proof, or training admission.',
   'The default --max sample stops at the requested prefix; only an explicit expected inventory with streamed shard reports proves whole-catalog diagnostic accounting.',
   'Scripts support parse/runtime negatives; native modules additionally support bounded parse/resolution/runtime diagnostics only when Node experimental VM modules are enabled.',
   'Bounded async scripts can observe $DONE via VM promise microtasks only, with duplicate/error/rejection checks. This is not complete Test262 async support.',
   'Raw scripts run without implicit harness files; negative early-phase tests, async modules, event-loop/timer/host-dependent async tests, dynamic imports and special host flags remain unsupported.',
   'node:vm is not a security boundary: use only trusted exact upstream checkouts, never arbitrary repository code.',
   'A passing script without assertions may contain no meaningful behavioral checks.'
  ]};
if(!seen.size)throw new Error('No Test262 source variants found');
writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({attempted:seen.size,eligible,enumerated,
 shardIndex,shardCount,truncated:eligible>seen.size,
 counts,verifiedOwned:0,admitted:0,output}));
