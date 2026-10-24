#!/usr/bin/env node
// Offline external fixture ingestion. Never executes acquired JavaScript.
import {createHash} from 'node:crypto';
import {createWriteStream,readFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {once} from 'node:events';
import {importers} from '../src/corpus/import-external.mjs';

const args=process.argv.slice(2);
const option=(name,required=false)=>{
  const idx=args.indexOf('--'+name);
  const val=idx===-1?null:args[idx+1];
  if(required&&(!val||val.startsWith('--')))throw new Error('Missing --'+name);
  return val;
};
const format=option('format',true);
if(!(format in importers))throw new Error('Unknown --format '+format);
const root=resolve(option('root',true));
const revision=option('revision',true);
const repository=option('repository',true);
const license=option('license',true);
const output=resolve(option('output')??'corpus/out/external-fixtures.jsonl');
const reportPath=resolve(option('report')??'corpus/out/external-report.json');
const count=Number(option('max')??'1000000');
if(!Number.isSafeInteger(count)||count<1||count>10000000)
  throw new Error('Invalid --max');
if(!/^[0-9a-f]{40}$/.test(revision))throw new Error('Revision must be full commit SHA');
if(!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository))
  throw new Error('Invalid repository');
if(!/^[A-Za-z0-9+.-]+$/.test(license))throw new Error('Invalid license identifier');
const snapshot=args.includes('--snapshot');
const lockPath=option('lock');
if(snapshot){
  if(!lockPath)throw new Error('--snapshot requires --lock for every source file');
}else{
  const actual=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  if(actual!==revision)throw new Error('Source checkout revision mismatch');
  const dirty=execFileSync('git',['-C',root,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim();
  if(dirty)throw new Error('Source checkout is modified');
}
const lock=snapshot?JSON.parse(readFileSync(resolve(lockPath),'utf8')):null;
if(snapshot&&(lock?.revision!==revision||lock?.repository!==repository||
  typeof lock?.files!=='object'))throw new Error('Invalid source snapshot lock');
const expectedFiles=new Set(snapshot?Object.keys(lock.files):[]);
const observedFiles=new Set();
const sha1=bytes=>createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
mkdirSync(dirname(output),{recursive:true});mkdirSync(dirname(reportPath),{recursive:true});
const writer=createWriteStream(output,{encoding:'utf8',flags:'w'});
const totals={schema:'external-corpus-acquisition-report/1',format,repository,revision,
  authority:'acquired-fixture-only',admitted:0,verified:0,records:0,
  programs:0,sourceFiles:0,hardCases:0,byKind:{},byStatus:{},
  byFeature:{},bySplit:{},max:count,truncated:false};
const ids=new Set(),families=new Set();
try {
  for await(const item of importers[format](root,{project:repository,repository,revision,license})){
    const path=item.provenance.path;
    if(snapshot&&!observedFiles.has(path)){
      if(!expectedFiles.has(path))throw new Error('Unpinned source file '+path);
      const bytes=readFileSync(resolve(root,path));
      if(sha1(bytes)!==lock.files[path])throw new Error('Changed source snapshot '+path);
    }
    observedFiles.add(path);
    if(ids.has(item.id))throw new Error('Duplicate case identity '+item.id);
    ids.add(item.id);
    families.add(JSON.stringify([path,item.program]));
    totals.records++;
    const bump=(key,value)=>totals[key][value]=(totals[key][value]??0)+1;
    bump('byKind',item.program.kind);bump('byStatus',item.status);
    bump('bySplit',item.split);
    if(item.hardness.score>=15)totals.hardCases++;
    for(const f of item.hardness.features)bump('byFeature',f);
    if(!writer.write(JSON.stringify(item)+'\n'))await once(writer,'drain');
    if(totals.records===count){totals.truncated=true;break;}
  }
  writer.end();await once(writer,'finish');
} catch(e){writer.destroy();throw e;}
totals.programs=families.size;
totals.sourceFiles=observedFiles.size;
if(snapshot&&!totals.truncated)for(const file of expectedFiles)
  if(!observedFiles.has(file))throw new Error('Unused or unsupported locked source '+file);
if(!totals.records)throw new Error('No candidate fixtures found');
totals.diagnosticOnly=true;
totals.warnings=[
  'Acquisition does not execute guest source or establish observable or intermediate semantic correctness.',
  'Test262 programs require exact harness and mode handling; data contracts require a separately pinned implementation.',
  'Do not import these records as semantic-execution/3 training trajectories.'
];
import {writeFileSync} from 'node:fs';
writeFileSync(reportPath,JSON.stringify(totals,null,2)+'\n');
console.log(JSON.stringify({records:totals.records,programs:totals.programs,
  sourceFiles:totals.sourceFiles,hardCases:totals.hardCases,byKind:totals.byKind,
  output,report:reportPath}));
