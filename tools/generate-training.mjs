#!/usr/bin/env node
// Version-three deterministic local fixture generation with explicit refusals.
// Does not manufacture independent admission or model accuracy evidence.
import {writeFileSync} from 'node:fs';
import {verifyTrainingCase} from '../src/training/admit.js';

const args=process.argv.slice(2);
function option(name,fallback){const i=args.indexOf(name);return i<0?fallback:args[i+1];}
const output=option('--output','training-local.jsonl');
const manifestPath=option('--manifest','training-manifest.json');
const count=Number(option('--count','16'));
const seed=Number(option('--seed','42'));
const maxOperators=4;
if(!Number.isSafeInteger(count)||count<1||count>4096||
   !Number.isSafeInteger(seed)||seed<0||seed>0xffffffff||
   ![1,2,4,8].includes(maxOperators))
  throw new TypeError('Invalid deterministic corpus count or seed');
let state=seed;
function number(){state=(Math.imul(state,1664525)+1013904223)>>>0;return state%23-11;}
const cases=[
  {family:'arithmetic',source:'"use strict";function run(x){return x*2+1;}',
    arguments:()=>[number()]},
  {family:'local-binding',source:'"use strict";function run(x){let y=x+1;return y*2;}',
    arguments:()=>[number()]},
  {family:'branch',source:'"use strict";function run(x){if(x>0)return x+3;return x-2;}',
    arguments:()=>[number()]},
  {family:'uncaptured-loop',source:'"use strict";function run(x){let s=0;for(let i=0;i<3;i++)s+=x+i;return s;}',
    arguments:()=>[number()]},
  {family:'alias-mutation',source:'"use strict";function run(o){o.n=o.n+3;return o;}',
    arguments:()=>[{n:number()}]},
  {family:'array-literal',source:'"use strict";function run(x){return [x,x+1];}',
    arguments:()=>[number()]},
  {family:'nested-helper',source:'"use strict";function inc(x){return x+1;}function run(x){return inc(x);}',
    arguments:()=>[number()]}
];
const rows=[],refusals=[],counts={locally_verified:0,unsupported:0,
  projection_failure:0,reference_mismatch:0,resource_limit:0,admitted:0};
const metrics={generatedUtf8Bytes:0,observedUtf8Bytes:0,
  logicalRecords:0,physicalFragments:0,privateEvidenceBytes:0,
  tokenCount:null,modelPredictionGroups:null};
function split(family){
  let x=0;for(const c of family)x=(Math.imul(x,31)+c.charCodeAt(0))>>>0;
  return x%10===0?'test':x%10<=2?'validation':'train';
}
for(let index=0;index<count;index++){
  const fixture=cases[index%cases.length];
  const values=fixture.arguments();
  try {
    const verified=verifyTrainingCase({source:fixture.source,entry:'run',
      args:values,seed,lineage:fixture.family,maxSteps:30000,maxGenerated:4096});
    if(verified.status!=='locally_verified'){
      const error=new Error(verified.reason??verified.status);
      error.category=verified.status;throw error;
    }
    const exported=verified.exported;
    exported.sidecar.sourceLineage=fixture.family;
    exported.sidecar.split=split(fixture.family);
    exported.sidecar.provenance={
      license:'project-owned deterministic fixture',family:fixture.family,
      index,seed};
    rows.push(exported);counts.locally_verified++;
    const publicRecords=exported.public.groups;
    for(const group of publicRecords){
      const bytes=Buffer.byteLength(group.events[0].record,'utf8');
      metrics[group.mode==='generated'?'generatedUtf8Bytes':'observedUtf8Bytes']+=bytes;
    }
    metrics.logicalRecords+=exported.sidecar.compiled.generated.length;
    metrics.physicalFragments+=publicRecords.length;
    metrics.privateEvidenceBytes+=Buffer.byteLength(JSON.stringify(exported.sidecar),'utf8');
  } catch(error) {
    const category=error?.category??(
      error instanceof RangeError?'resource_limit':
      /Independent V8|reference/.test(error.message)?'reference_mismatch':
      /Unsupported|not implemented|Unsettled/.test(error.message)?'unsupported':
      'projection_failure');
    counts[category]=(counts[category]??0)+1;
    refusals.push({index,family:fixture.family,arguments:values,
      category,reason:String(error.message)});
  }
}
writeFileSync(output,rows.map(JSON.stringify).join('\n')+(rows.length?'\n':''));
const manifest={schema:'semantic-corpus-manifest/3',source:'werg/tracing-js-self',
  traceFormat:'semantic-trace/3',contextFormat:'semantic-context/3',
  supervisionFormat:'semantic-supervision/2',profile:'training-js/1',
  policy:{maxOperators,maxExpressionNodes:32,completionPolicy:'immediate-root'},
  seed,requested:count,counts,metrics,
  tokenizer:'not measured: pinned megatoken codec is required',
  admission:'locally_verified_only: megatoken import and model evaluation not certified',
  refusals,
  files:{episodes:output}};
writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({output,manifestPath,counts,metrics}));
