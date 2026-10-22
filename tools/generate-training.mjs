#!/usr/bin/env node
// Deterministic locally verified corpus fixtures. A megatoken acceptance gate
// is required before these may be called admitted training examples.
import {writeFileSync} from 'node:fs';
import {verifyTrainingCase} from '../src/training/admit.js';

const argv=process.argv.slice(2);
const option=(flag,fallback)=>argv.includes(flag)?argv[argv.indexOf(flag)+1]:fallback;
const output=option('--output','training-local.jsonl');
const manifestPath=option('--manifest','training-manifest.json');
const count=Number(option('--count','16'));
const seed=Number(option('--seed','42'));
if(!Number.isSafeInteger(count)||count<1||count>10000 ||
   !Number.isSafeInteger(seed)||seed<0||seed>0xffffffff)
  throw new TypeError('Use --count (1..10000) and --seed (0..4294967295)');
let state=seed;
function random(){state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;}
const int=(min,max)=>min+Math.floor(random()*(max-min+1));
const families=[
 {name:'arithmetic-branches',source:'"use strict";\nfunction run(a,b){if(a>b)return a-b;return a+b;}',
  args:()=>[int(-8,8),int(-8,8)]},
 {name:'bounded-loops',source:'"use strict";\nfunction run(x){let i=0;let s=0;while(i<3){s+=x+i;i+=1;}return s;}',
  args:()=>[int(-9,9)]},
 {name:'alias-mutations',source:'"use strict";\nfunction run(o,d){let a=o;a.n=a.n+d;return [o,a.n];}',
  args:()=>[{n:int(-10,10)},int(-5,5)]},
 {name:'closure-captures',source:'"use strict";\nfunction run(x){function inc(y){return x+y;}return inc(inc(1));}',
  args:()=>[int(-5,5)]},
 {name:'array-length',source:'"use strict";\nfunction run(x){const a=[x,x+1,x+2];a.length=2;return [a.length,a[1]];}',
  args:()=>[int(-8,8)]}
];
const split=name=>{
  let value=0;
  for(const char of name)value=(Math.imul(value,31)+char.charCodeAt(0))>>>0;
  return value%10===0?'test':value%10<=2?'validation':'train';
};
const counts={admitted:0,locally_verified:0,unsupported:0,reference_mismatch:0,
  runtime_failure:0,profile_limit:0,projection_failure:0,visibility_failure:0};
const records=[],diagnostics=[];
for(let index=0;index<count;index++){
  const family=families[index%families.length];
  const result=verifyTrainingCase({source:family.source,entry:'run',args:family.args(),
    seed,lineage:family.name});
  counts[result.status]=(counts[result.status]??0)+1;
  if(result.status!=='locally_verified'){
    diagnostics.push({index,family:family.name,status:result.status,reason:result.reason??null});
    continue;
  }
  result.exported.sidecar.split=split(family.name);
  result.exported.sidecar.provenance={license:'project-owned generated fixture',
    family:family.name,seed,index};
  records.push(JSON.stringify(result.exported));
}
writeFileSync(output,records.join('\n')+(records.length?'\n':''));
const manifest={schema:'training-corpus-manifest/1',profile:'training-js/1',seed,
  requested:count,counts,files:{episodes:output},splits:{},
  admission:'PENDING: megatoken schema, execution validator and teacher-conditioned adapter',
  diagnostics};
for(const row of records){
  const item=JSON.parse(row),s=item.sidecar.split;
  manifest.splits[s]=(manifest.splits[s]??0)+1;
}
writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({output,manifestPath,counts,splits:manifest.splits}));
