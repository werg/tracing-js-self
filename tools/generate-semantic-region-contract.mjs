#!/usr/bin/env node
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {semanticV8Contract} from '../src/semantic/contract-v8.js';
import {regionQualificationFixtures} from '../fixtures/semantic-regions/qualification.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

const args=process.argv.slice(2);if(args.some(arg=>arg!=='--check'))throw new Error('Usage: node tools/generate-semantic-region-contract.mjs [--check]');
const check=args.includes('--check');
const records=[
  {valid:false,line:'region {"future":1}',reason:'unknown fields'},
  {valid:false,line:'algorithm {"claims":[],"allocations":[],"completion":{"kind":"suspend"}}',reason:'missing or invalid completion'},
  {valid:false,line:'detail {"kind":"observe","fields":{"effect":"e0","status":"fulfilled","result":["num",7]}}',role:'generated',reason:'observation cannot be generated'},
  {valid:false,execution:'semantic-execution/7',reason:'old artifacts require their original contract'}
];
// The source compiler imports the fail-closed native policy validator. During
// explicit regeneration, publish the new definition before loading that module;
// the complete interoperability manifest is written after every example passes.
if(!check)await writeFile(new URL('../contracts/semantic-execution-v8.json',import.meta.url),
  JSON.stringify(semanticV8Contract(records),null,2)+'\n');
const {verifyRegionTrainingCase}=await import('../src/semantic/compiler-v8.js');
const fixtures=regionQualificationFixtures();
const examples=[];
for(const fixture of fixtures){
  const result=await verifyRegionTrainingCase(fixture);
  if(!result.exported)throw new Error(fixture.id+': '+result.reason);
  examples.push({id:fixture.id,public:result.exported.public,contexts:result.exported.contexts,
    sourceCheck:result.exported.sidecar.sourceArtifact.sidecar.reference.sourceChecks.status,
    regionCoverage:result.exported.sidecar.regionCoverage});
}
const protocolFixtures=JSON.parse(await readFile(new URL('../test/fixtures/semantic-protocol-v8.json',import.meta.url),'utf8'));
const manifest=[...examples.map(row=>({id:row.id,publicDigest:hashAlgorithmData(row.public),contextDigest:hashAlgorithmData(row.contexts)})),
  {id:'protocol-machine',schema:protocolFixtures.schema,fixtureDigest:hashAlgorithmData(protocolFixtures)}];
const contract=semanticV8Contract(records,manifest),interop={schema:'semantic-v8-interoperability/1',
  contractDigest:contract.digest,interoperabilityDigest:contract.interoperabilityDigest,examples};
for(const [relative,value] of [['../contracts/semantic-execution-v8.json',contract],['../test/fixtures/semantic-regions-v8.json',interop]]){
  const path=fileURLToPath(new URL(relative,import.meta.url)),bytes=JSON.stringify(value,null,2)+'\n';
  if(check){if(await readFile(path,'utf8')!==bytes)throw new Error('Regenerate '+path);}
  else await writeFile(path,bytes);
}
process.stdout.write(JSON.stringify({valid:true,contractDigest:contract.digest,examples:examples.map(row=>({id:row.id,...row.regionCoverage})),mode:check?'checked':'generated'})+'\n');
