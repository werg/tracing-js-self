#!/usr/bin/env node
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';

const [original,current,output,...extra]=process.argv.slice(2);
assert(original&&current&&output&&!extra.length,'Usage: audit-inputs.mjs ORIGINAL CURRENT NEW_OUTPUT_JSON');
const inventories={};
for(const [name,root] of Object.entries({original:resolve(original),current:resolve(current)})){
  const {regionQualificationPopulation}=await import(pathToFileURL(root+'/fixtures/semantic-regions/qualification.js'));
  const {encodeGenerationTask}=await import(pathToFileURL(root+'/src/corpus/generation-process.mjs'));
  const rows=[];
  for(const population of ['all','interoperability']){
    const selected=regionQualificationPopulation({population,allInputs:true});
    for(const fixture of [...selected.scripts,...selected.modules]){
      const task=encodeGenerationTask({kind:fixture.modules?'module':'source',traceVersion:8,fixture,
        producerRevision:'inventory-correspondence-control'});
      rows.push({population,id:fixture.id,kind:task.kind,
        inputSha256:createHash('sha256').update(JSON.stringify(task.fixture)).digest('hex')});
    }
  }
  inventories[name]={revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),rows};
}
const key=row=>row.population+':'+row.id,
  prior=new Map(inventories.original.rows.map(row=>[key(row),row])),
  next=new Map(inventories.current.rows.map(row=>[key(row),row]));
assert.equal(prior.size,inventories.original.rows.length,'Duplicate original population identity');
assert.equal(next.size,inventories.current.rows.length,'Duplicate current population identity');
const removed=[...prior.keys()].filter(k=>!next.has(k)),
  changed=[...prior.keys()].filter(k=>next.has(k)&&JSON.stringify(prior.get(k))!==JSON.stringify(next.get(k))),
  added=[...next.keys()].filter(k=>!prior.has(k)),
  counts=Object.fromEntries(Object.entries(inventories).map(([name,{rows}])=>[name,
    Object.fromEntries(['all','interoperability'].map(population=>[population,rows.filter(row=>row.population===population).length]))]));
assert.deepEqual(counts,{original:{all:665,interoperability:66},current:{all:665,interoperability:69}});
assert.deepEqual(removed,[]);assert.deepEqual(changed,[]);
assert.deepEqual(added,['interoperability:source-promise-adoption-executor',
  'interoperability:source-promise-adoption-async-return','interoperability:source-promise-adoption-reaction-return']);
const result={schema:'installed-v8-population-correspondence/1',counts,removed,changed,added,
  fixtureHashScope:'SHA256(JSON.stringify(encodeGenerationTask(...).fixture)); identical synthetic producerRevision used only to compare original inputs',
  sourceExecution:0,nativeAdmission:0,optimizerUpdates:0,inventories};
writeFileSync(resolve(output),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({counts,removed,changed,added,retainedOriginalRows:prior.size,currentRows:next.size}));
