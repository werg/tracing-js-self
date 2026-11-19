#!/usr/bin/env node
import {readFile,writeFile} from 'node:fs/promises';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
const args=process.argv.slice(2);if(args.some(arg=>arg!=='--check'))throw new Error('Only --check is supported');
const fixture={id:'builtin-iterator-mixed-arithmetic',family:'builtin-iterator-mixed-arithmetic',entry:'run',args:[4],
  source:'"use strict";function run(x){const before=x+2;const a=[,x];const it=a.values();const first=it.next();a[2]=x+1;const second=it.next();const third=it.next();const end=it.next();const av=second.value;const bv=third.value;const after=av+bv;return before+after+1;}'};
const result=await verifyProtocolRegionTrainingCase(fixture);
if(!result.exported)throw new Error(result.reason);
await recheckProtocolRegionEvidence(result.exported);
const data={schema:'semantic-protocol-region-fixtures/1',cases:[{id:fixture.id,fixture,artifact:result.exported}]},
  path=new URL('../test/fixtures/semantic-iterator-region-v8.json',import.meta.url),bytes=JSON.stringify(data)+'\n';
if(args.includes('--check')){if(await readFile(path,'utf8')!==bytes)throw new Error('Regenerate '+path.pathname);}
else await writeFile(path,bytes);
console.log(JSON.stringify({valid:true,id:fixture.id,publicDigest:result.exported.sidecar.publicDigest,
  contextDigest:result.exported.sidecar.contextDigest,coverage:result.exported.sidecar.regionCoverage}));
