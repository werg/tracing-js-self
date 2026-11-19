#!/usr/bin/env node
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {semanticV8Contract} from '../src/semantic/contract-v8.js';
import {verifyRegionTrainingCase} from '../src/semantic/compiler-v8.js';
import {SEMANTIC_GALLERY_FIXTURES} from '../src/training/semantic-trace-gallery.js';

const args=process.argv.slice(2);if(args.some(arg=>arg!=='--check'))throw new Error('Usage: node tools/generate-semantic-region-contract.mjs [--check]');
const check=args.includes('--check');
const fixtures=[
  {id:'ordered-map',source:'"use strict";function run(xs){return xs.map(x=>x*2);}',entry:'run',args:[[2,3,4]],family:'v8-contract-map',fixture:{calls:[]}},
  {id:'shared-getter',source:'"use strict";function run(x){const a=x+1;const b=a*2;let reads=0;const o={};Object.defineProperty(o,"v",{get:()=>{reads++;return 20;}});const price=o.v;return b+price+reads;}',
    entry:'run',args:[3],family:'v8-contract-getter',fixture:{calls:[]}},
  {...structuredClone(SEMANTIC_GALLERY_FIXTURES.find(row=>row.id==='counter-0')),id:'causal-counter'}
];
const examples=[];
for(const fixture of fixtures){
  const result=await verifyRegionTrainingCase(fixture);
  if(!result.exported)throw new Error(fixture.id+': '+result.reason);
  examples.push({id:fixture.id,public:result.exported.public,contexts:result.exported.contexts,
    sourceCheck:result.exported.sidecar.sourceArtifact.sidecar.reference.sourceChecks.status,
    regionCoverage:result.exported.sidecar.regionCoverage});
}
const records=[
  {valid:false,line:'region {"future":1}',reason:'unknown fields'},
  {valid:false,line:'algorithm {"claims":[],"allocations":[],"completion":{"kind":"suspend"}}',reason:'missing or invalid completion'},
  {valid:false,line:'detail {"kind":"observe","fields":{"effect":"e0","status":"fulfilled","result":["num",7]}}',role:'generated',reason:'observation cannot be generated'},
  {valid:false,execution:'semantic-execution/7',reason:'old artifacts require their original contract'}
];
const contract=semanticV8Contract(records),interop={schema:'semantic-v8-interoperability/1',contractDigest:contract.digest,examples};
for(const [relative,value] of [['../contracts/semantic-execution-v8.json',contract],['../test/fixtures/semantic-regions-v8.json',interop]]){
  const path=fileURLToPath(new URL(relative,import.meta.url)),bytes=JSON.stringify(value,null,2)+'\n';
  if(check){if(await readFile(path,'utf8')!==bytes)throw new Error('Regenerate '+path);}
  else await writeFile(path,bytes);
}
process.stdout.write(JSON.stringify({valid:true,contractDigest:contract.digest,examples:examples.map(row=>({id:row.id,...row.regionCoverage})),mode:check?'checked':'generated'})+'\n');
