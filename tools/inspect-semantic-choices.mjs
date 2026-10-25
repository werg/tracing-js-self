#!/usr/bin/env node
// Generate and inspect real, independently checked owned traces (not samples
// fabricated from expected model completions).
import {verifyTrainingCase} from '../src/training/admit.js';
import {renderWitness} from '../src/training/render.js';
import {decodeWitness} from '../src/training/format.js';

const cases=[
  ['comparison', 'function run(x){if(x>0)return x+3;return x-2;}',[4]],
  ['nested choice', 'function run(x){if(x+1>=3)return 10;return 20;}',[3]],
  ['falsy input', 'function run(x){if(x)return 1;return 0;}',[0]],
  ['object truthiness','function run(o){if(!o)return 1;return 2;}',[{n:3}]],
  ['property choice','function run(o){if(o.n>2)return o.n;return 0;}',[{n:3}]],
  ['prior write','function run(o){o.n=4;if(o.n>2)return o.n;return 0;}',[{n:1}]],
  ['side-effect test','function run(o){if(o.n++<3)return o.n;return -1;}',[{n:2}]],
  ['loop','function run(x){let s=0;for(let i=0;i<3;i++)s+=x+i;return s;}',[4]],
  ['helper','function inc(y){return y+1;}function run(x){return inc(x);}',[4]]
];
let total=0,sourceChoices=0,opaqueChoices=0;
for(const [label,body,args] of cases){
  const result=verifyTrainingCase({source:'"use strict";'+body,
    entry:'run',args,seed:42});
  if(result.status!=='locally_verified')throw new Error(label+': '+result.status+
    ' '+result.reason);
  const compiled=result.exported.sidecar.compiled;
  const records=compiled.generated.map(decodeWitness);
  const sourceLinked=records.filter(r=>r.kind==='choose'&&
    r.fields.expr.op!=='literal').length;
  const literal=records.filter(r=>r.kind==='choose'&&
    r.fields.expr.op==='literal').length;
  sourceChoices+=sourceLinked;opaqueChoices+=literal;total+=records.length;
  console.log('\n## '+label+' '+JSON.stringify(args));
  console.log('source: '+body);
  console.log('witness:');
  for(const line of compiled.generated)console.log('  '+renderWitness(line));
  console.log('verified: '+result.status+'; records='+records.length+
    '; explained choices='+sourceLinked+'; opaque choices='+literal+
    '; private certificates='+compiled.certificates.length+
    '; V8 outcome='+JSON.stringify(result.exported.sidecar.reference.graph.roots.at(-1)));
}
console.log('\nSummary: '+JSON.stringify({cases:cases.length,records:total,
  sourceLinkedChoices:sourceChoices,opaqueChoices,evidence:'locally_verified_only'}));
