#!/usr/bin/env node
// Recreate owned/private receipts after runtime changes without carrying stale
// archives into the interoperability contract. Public contexts are rebuilt too.
import {readFile,writeFile} from 'node:fs/promises';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
const args=process.argv.slice(2),check=args.includes('--check');
if(args.some(arg=>arg!=='--check'))throw new Error('Usage: node tools/generate-protocol-source-fixtures.mjs [--check]');
const outerPath=new URL('../test/fixtures/semantic-protocol-region-v8.json',import.meta.url);
const innerPath=new URL('../test/fixtures/semantic-protocol-source-v8.json',import.meta.url);
const input=JSON.parse(await readFile(outerPath,'utf8'));
if(input.schema!=='semantic-protocol-region-fixtures/1'||!Array.isArray(input.cases)||!input.cases.length)
  throw new Error('Missing declared protocol source fixtures');
const outer={schema:input.schema,cases:[]},inner={schema:'semantic-protocol-source-fixtures/1',profile:'symbols-ordinary-properties/1',cases:[]};
const ids=new Set();
for(const row of input.cases){
  if(typeof row.id!=='string'||!row.id||ids.has(row.id)||row.id!==row.fixture?.id)throw new Error('Invalid fixture identity');
  ids.add(row.id);
  const result=await verifyProtocolRegionTrainingCase(row.fixture);
  if(!result.exported)throw new Error(row.id+': '+result.reason);
  await recheckProtocolRegionEvidence(result.exported);
  outer.cases.push({id:row.id,fixture:row.fixture,artifact:result.exported});
  const source=result.exported.sidecar.sourceArtifact,reference=source.sidecar.reference;
  inner.cases.push({id:row.id,qualification:'owned-and-independent-source-checked',
    source:row.fixture.source,entry:row.fixture.entry,args:row.fixture.args??[],
    inputGraph:source.public.inputGraph,claims:source.public.claims,expected:source.sidecar.outcome,
    audit:Object.fromEntries(['status','operationAudit','branchAudit','completionAudit','metadataAudit'].map(key=>[key,reference[key]]))});
}
for(const [path,data]of [[outerPath,outer],[innerPath,inner]]){
  const bytes=JSON.stringify(data)+'\n';
  if(check){if(await readFile(path,'utf8')!==bytes)throw new Error('Regenerate '+path.pathname);}
  else await writeFile(path,bytes);
}
console.log(JSON.stringify({valid:true,mode:check?'checked':'generated',cases:outer.cases.map(row=>({id:row.id,
  publicDigest:row.artifact.sidecar.publicDigest,contextDigest:row.artifact.sidecar.contextDigest}))}));
