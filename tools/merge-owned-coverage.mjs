#!/usr/bin/env node
// Fail-closed aggregation of complete owned-runtime evidence partitions.
// No report promotes native observations to admitted training episodes.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {cases} from '../corpus/cases.mjs';
import {corpusSplit} from '../corpus/pinned-source.mjs';

const argv=process.argv.slice(2),arg=(name,fallback)=>argv.includes(name)?argv[argv.indexOf(name)+1]:fallback;
const output=resolve(arg('--output','corpus/out/owned-full-coverage.json'));
const review=resolve(arg('--review','corpus/out/owned-full-coverage.md'));
const complete=argv.includes('--require-complete');
const minimum=Number(arg('--min-owned-verified','0'));
const files=argv.filter(x=>x.endsWith('.json')&&x!==arg('--output',null)&&x!==arg('--review',null));
if(!files.length||!Number.isSafeInteger(minimum)||minimum<0)
  throw new TypeError('Provide coverage JSON partitions and a nonnegative minimum');
const known=new Map(cases.map(spec=>[spec.project+'/'+spec.file+'/'+spec.entry,spec]));
const seen=new Map(),shards=[],partitions=new Set();
for(const path of files){
  const report=JSON.parse(readFileSync(path,'utf8'));
  if(report.schema!=='real-source-owned-coverage/1'||report.admitted!==false ||
     !Array.isArray(report.examples)||report.examples.length!==report.invocations)
    throw new Error('Invalid owned coverage partition '+path);
  const opts=report.options;
  if(!opts||!Number.isInteger(opts.indexStart)||!Number.isInteger(opts.indexEnd)||
     opts.indexStart<0||opts.indexEnd>12||opts.indexEnd<=opts.indexStart||
     opts.requireComplete!==true)
    throw new Error('Only independently complete partitions can be merged: '+path);
  if(report.totalFamilies!==cases.length||
     report.invocations!==cases.length*(opts.indexEnd-opts.indexStart))
    throw new Error('Partition omits a source family: '+path);
  const key=opts.indexStart+':'+opts.indexEnd;
  if(partitions.has(key))throw new Error('Duplicate index partition '+key);
  partitions.add(key);
  let verified=0;
  for(const item of report.examples){
    const spec=known.get(item.family);
    if(!spec || !Number.isInteger(item.index)||
       item.index<opts.indexStart||item.index>=opts.indexEnd ||
       !['locally_verified','unsupported','runtime_failure','source_bundle_limit',
         'native_not_verified','reference_mismatch','profile_limit','projection_failure',
         'evidence_recheck_failure','guest_fixture_not_portable',
         'visibility_failure'].includes(item.ownedStatus) ||
       typeof item.nativeVerified!=='boolean')
      throw new Error('Unrecognized partition example '+JSON.stringify(item));
    const id=item.family+'#'+item.index;
    if(seen.has(id))throw new Error('Duplicated owned coverage identity '+id);
    if(item.ownedStatus==='locally_verified'){
      if(!item.nativeVerified)throw new Error('Unverified native evidence for '+id);
      verified++;
    }
    seen.set(id,item);
  }
  if(report.ownedVerified!==verified)
    throw new Error('Partition owned-verification count mismatch: '+path);
  shards.push({path,indexStart:opts.indexStart,indexEnd:opts.indexEnd,
    invocations:report.invocations,ownedVerified:verified});
}
if(complete){
  for(const spec of cases){
    const family=spec.project+'/'+spec.file+'/'+spec.entry;
    for(let i=0;i<12;i++)if(!seen.has(family+'#'+i))
      throw new Error('Missing corpus execution '+family+'#'+i);
  }
  if(seen.size!==cases.length*12)throw new Error('Not an exhaustive pinned corpus evaluation');
}
const statuses={},byProject={},byFamily={},reasons={};
let verified=0,nativeVerified=0;
for(const [key,x] of [...seen].sort(([a],[b])=>a.localeCompare(b,'en',{numeric:true}))){
  const spec=known.get(x.family);
  const project=byProject[spec.project]??={invocations:0,locallyVerified:0,statuses:{}};
  const family=byFamily[x.family]??={project:spec.project,split:corpusSplit(x.family),
    invocations:0,locallyVerified:0,statuses:{},failures:[]};
  for(const group of [project,family]){
    group.invocations++;
    group.statuses[x.ownedStatus]=(group.statuses[x.ownedStatus]??0)+1;
    if(x.ownedStatus==='locally_verified')group.locallyVerified++;
  }
  statuses[x.ownedStatus]=(statuses[x.ownedStatus]??0)+1;
  if(x.ownedStatus==='locally_verified')verified++;
  if(x.nativeVerified)nativeVerified++;
  else if(x.ownedStatus==='locally_verified')
    throw new Error('Inconsistent local/native evidence '+key);
  if(x.ownedStatus!=='locally_verified'){
    const reason=(x.reason??'<no detailed reason>').replace(/ at \d+:\d+/g,' at <site>');
    const bucket=x.ownedStatus+': '+reason.slice(0,160);
    reasons[bucket]=(reasons[bucket]??0)+1;
    family.failures.push({index:x.index,status:x.ownedStatus,reason:x.reason??null});
  }
}
if(verified<minimum)throw new Error('Owned coverage regressed: '+verified+' < '+minimum);
const result={schema:'real-source-owned-full-coverage/1',admitted:false,
  authority:'locally-verified-owned-runtime-only',
  fullCorpus:complete,sourceFamilies:cases.length,expectedInvocations:cases.length*12,
  invocations:seen.size,nativeVerified,locallyVerified:verified,counts:statuses,
  partitions:shards,byProject,byFamily,
  reasons:Object.fromEntries(Object.entries(reasons).sort((a,b)=>
    b[1]-a[1]||a[0].localeCompare(b[0]))),
  limitations:[
    'Native agreement checks final observable V8 results, not each semantic event.',
    'Locally verified owned trajectories remain unadmitted until an independent consumer gate.',
    'Stateful corpus execution is separately diagnostic-only and not counted as owned coverage.'
  ]};
mkdirSync(dirname(output),{recursive:true});mkdirSync(dirname(review),{recursive:true});
writeFileSync(output,JSON.stringify(result,null,2)+'\n');
const lines=['# Exhaustive pinned utility corpus: owned execution evidence','',
  '**Locally verified only; zero admitted training episodes.**','',
  '- All 12 fixtures evaluated: '+complete,
  '- Sources: '+cases.length+' pinned function families',
  '- Executions: '+seen.size+'/'+(cases.length*12),
  '- Independently matching native final outcomes: '+nativeVerified,
  '- Locally verified owned traces: '+verified,
  '- Not locally verified: '+(seen.size-verified),'',
  '## Statuses','',...Object.entries(statuses).sort().map(([k,v])=>'- '+k+': '+v),
  '','## Blocker reasons','',
  ...Object.entries(result.reasons).map(([k,v])=>'- '+v+' — '+k),
  '','## Per-source results','',
  '| Source family | Locally verified | Attempts | Status counts |',
  '| --- | ---: | ---: | --- |',
  ...Object.entries(byFamily).map(([k,v])=>'| '+k+' | '+v.locallyVerified+' | '+
    v.invocations+' | '+Object.entries(v.statuses).map(([k,n])=>k+':'+n).join(', ')+' |'),
  '','Native V8 diagnostics (including 912 stateful executions) are not admitted training traces.',''];
writeFileSync(review,lines.join('\n'));
console.log(JSON.stringify({invocations:seen.size,verified,counts:statuses,output,review}));
