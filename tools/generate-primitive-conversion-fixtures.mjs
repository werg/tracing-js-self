#!/usr/bin/env node
// Preserve every original source/disposition and rebuild all accepted public
// states with independent original-source observations before publishing bytes.
import {readFile,writeFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {PRIMITIVE_CONVERSION_FIXTURES} from '../fixtures/semantic-regions/primitive-conversion.js';
import {PRIMITIVE_CONVERSION_COMPOSITION_FIXTURES} from '../fixtures/semantic-regions/primitive-conversion-composition.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
const args=process.argv.slice(2),check=args.includes('--check');
if(args.some(arg=>arg!=='--check'))throw new Error('Usage: generate-primitive-conversion-fixtures.mjs [--check]');
const original=[...PRIMITIVE_CONVERSION_FIXTURES],all=[...original,...PRIMITIVE_CONVERSION_COMPOSITION_FIXTURES],cases=[];
for(const fixture of all){
  const result=await verifyProtocolRegionTrainingCase({...fixture,timeoutMs:30000});
  if(fixture.boundary){
    const expected=fixture.boundary==='intrinsic-error-source-metadata'?/intrinsic conversion fault/:
      fixture.boundary==='node24-reference-disagreement'?/pinned reference edition/:null;
    if(result.exported||result.status!=='unsupported'||result.regionDisposition!=='source-unqualified'||
      !expected?.test(result.reason))throw new Error(fixture.id+': boundary was not retained: '+result.reason);
    cases.push({id:fixture.id,fixture,sourceInputDigest:hashAlgorithmData(fixture),status:'source-unqualified',
      boundary:fixture.boundary,reason:result.reason});
  }else{
    if(!result.exported)throw new Error(fixture.id+': '+result.reason);
    const verified=await recheckProtocolRegionEvidence(result.exported);
    if(!verified.sourceValidated||!verified.projectionValidated||!verified.replayValidated)
      throw new Error(fixture.id+': independent source/public recheck failed');
    cases.push({id:fixture.id,fixture,sourceInputDigest:hashAlgorithmData(fixture),status:'source-qualified',artifact:result.exported});
  }
}
const artifact={schema:'semantic-primitive-conversion-fixtures/1',originalIds:original.map(row=>row.id),
  qualification:{source:'checked-during-generation',public:'replayed',native:'untested',model:'unmeasured'},cases};
const path=new URL('../test/fixtures/semantic-primitive-conversion-v8.json.gz.b64',import.meta.url),
  bytes=gzipSync(Buffer.from(JSON.stringify(artifact)+'\n')).toString('base64')+'\n';
if(check){if(await readFile(path,'utf8')!==bytes)throw new Error('Regenerate '+path.pathname);}
else await writeFile(path,bytes);
console.log(JSON.stringify({valid:true,mode:check?'checked':'generated',total:cases.length,
  sourceQualified:cases.filter(row=>row.artifact).length,sourceUnqualified:cases.filter(row=>!row.artifact).length,
  originalIds:artifact.originalIds,cases:cases.map(row=>({id:row.id,status:row.status,
    ...(row.artifact?{publicDigest:row.artifact.sidecar.publicDigest,contextDigest:row.artifact.sidecar.contextDigest}:{boundary:row.boundary})}))}));
