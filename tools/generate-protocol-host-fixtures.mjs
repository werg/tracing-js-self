#!/usr/bin/env node
// Retain stable mixed interoperability bytes only after fresh independent source
// qualification. A checked source fixture is not a native or learned result.
import {readFile,writeFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {HOST_PROTOCOL_FIXTURES_V8} from '../fixtures/semantic-regions/host-protocol.js';
import {verifyRegionTrainingCase,recheckRegionEvidence} from '../src/semantic/compiler-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

const args=process.argv.slice(2),check=args.includes('--check');
if(args.some(arg=>arg!=='--check'))throw new Error('Usage: node tools/generate-protocol-host-fixtures.mjs [--check]');
const cases=[];
for(const fixture of HOST_PROTOCOL_FIXTURES_V8){
  const result=await verifyRegionTrainingCase(fixture);
  if(!result.exported)throw new Error(fixture.id+': source refused: '+result.reason);
  const verified=await recheckRegionEvidence(result.exported);
  if(!verified.sourceValidated||!verified.projectionValidated||!verified.replayValidated)
    throw new Error(fixture.id+': fresh source/public checks failed');
  cases.push({id:fixture.id,sourceInputDigest:hashAlgorithmData(fixture),
    public:result.exported.public,contexts:result.exported.contexts});
}
const artifact={schema:'semantic-host-protocol-interoperability/1',
  qualification:{source:'checked-during-generation',public:'replayed',native:'untested',model:'unmeasured'},cases};
const path=new URL('../test/fixtures/semantic-host-protocol-v8.json.gz.b64',import.meta.url),
  bytes=gzipSync(Buffer.from(JSON.stringify(artifact)+'\n')).toString('base64')+'\n';
if(check){if(await readFile(path,'utf8')!==bytes)throw new Error('Regenerate '+path.pathname);}
else await writeFile(path,bytes);
console.log(JSON.stringify({valid:true,mode:check?'checked':'generated',cases:cases.map(row=>({
  id:row.id,publicDigest:hashAlgorithmData(row.public),contextDigest:hashAlgorithmData(row.contexts)}))}));
