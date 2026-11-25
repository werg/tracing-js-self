#!/usr/bin/env node
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {issue51ObjectFixtures,issue51UnsupportedControls} from '../fixtures/semantic-regions/objects-issue51.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {buildRegionFamilyRegistry} from '../src/semantic/family-registry-v8.js';
import {bindRegionFamilySplit} from '../src/semantic/dataset-v8.js';
import {decodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';

const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--out'||!args[1]||args[1].startsWith('--'))
  throw new TypeError('Usage: node tools/export-issue51-evidence.mjs --out OUTPUT.json');
const root=resolve(new URL('..',import.meta.url).pathname),output=resolve(args[1]);
const producerRevision=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const producerTreeClean=execFileSync('git',['-C',root,'status','--porcelain','--untracked-files=all'],{encoding:'utf8'}).trim()==='';
const fixtures=[...issue51ObjectFixtures,...issue51UnsupportedControls],members=fixtures.map(fixture=>
  ({id:fixture.id,family:fixture.family,ancestors:fixture.ancestorIds??[],source:fixture.source,entry:fixture.entry})),
  memberById=new Map(members.map(member=>[member.id,member]));
const registry=buildRegionFamilyRegistry(members,{seed:51});
function protocolOperationCounts(artifact,{methods=false}={}){
  const counts={};
  for(const row of artifact?.public?.timeline??[]){
    const line=row.fields?.line;if(typeof line!=='string'||!line.startsWith('protocol '))continue;
    const record=decodeProtocolRecordV8(line),key=methods&&typeof record.operation==='string'?
      [record.kind,record.operation,...(typeof record.caller==='string'?[record.caller]:[])].join('/'):record.kind;
    counts[key]=(counts[key]??0)+1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left],[right])=>left.localeCompare(right)));
}
const cases=[],dispositions=[];
let failures=0;
for(const [expected,fixtures] of [['supported',issue51ObjectFixtures],['refused',issue51UnsupportedControls]]){
  for(const fixture of fixtures){
    const row={id:fixture.id,fixture:structuredClone(fixture),artifact:null};
    let status,reason=null;
    try{
      const result=await verifyProtocolRegionTrainingCase(structuredClone(fixture));
      if(expected==='supported'){
        if(!result.exported)throw new Error(result.reason??'Expected supported original source to produce evidence');
        const checked=await recheckProtocolRegionEvidence(result.exported);
        if(checked.valid!==true)throw new Error('Fresh source and replay recheck did not validate');
        row.artifact=bindRegionFamilySplit(result.exported,memberById.get(fixture.id),registry);status='passed';
      }else if(result.exported){
        row.artifact=bindRegionFamilySplit(result.exported,memberById.get(fixture.id),registry);
        status='unexpectedly_supported';reason='Refusal control unexpectedly produced an artifact';failures++;
      }else {status='refused';reason=result.reason??result.status;}
    }catch(error){
      status=expected==='supported'?'failed':'control_error';reason=String(error?.message??error);failures++;
    }
    row.protocolOperationCounts=row.artifact?protocolOperationCounts(row.artifact):{};
    row.protocolMethodCounts=row.artifact?protocolOperationCounts(row.artifact,{methods:true}):{};
    cases.push(row);dispositions.push({id:fixture.id,expected,status,reason});
  }
}
const operationCoverage={},methodCoverage={};
for(const row of cases)for(const [kind,count]of Object.entries(row.protocolOperationCounts))
  operationCoverage[kind]=(operationCoverage[kind]??0)+count;
for(const row of cases)for(const [method,count]of Object.entries(row.protocolMethodCounts))
  methodCoverage[method]=(methodCoverage[method]??0)+count;
const report={schema:'issue51-object-evidence/1',producerRevision,producerTreeClean,nodeVersion:process.version,
  registry,cases,dispositions,methodCoverage:Object.fromEntries(Object.entries(methodCoverage).sort(([left],[right])=>left.localeCompare(right))),operationCoverage:Object.fromEntries(Object.entries(operationCoverage).sort(([left],[right])=>left.localeCompare(right)))};
writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'w'});
process.stdout.write(JSON.stringify({output,producerRevision,producerTreeClean,
  declared:cases.length,passed:dispositions.filter(row=>row.status==='passed').length,
  refused:dispositions.filter(row=>row.status==='refused').length,failures})+'\n');
if(failures)process.exitCode=1;
