#!/usr/bin/env node
// Read-only owned-interpreter coverage bridge for the pinned native corpus.
// A successful native V8 observation is NOT evidence that the owned runtime
// executes it, and a locally-verified owned trace is NOT corpus admission.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import ts from 'typescript';
import {verifyTrainingCase} from '../src/training/admit.js';
import {cases} from '../corpus/cases.mjs';

const argv=process.argv.slice(2);
const arg=(name,fallback)=>argv.includes(name)?argv[argv.indexOf(name)+1]:fallback;
const input=resolve(arg('--input','corpus/out/traces.jsonl'));
const out=resolve(arg('--output','corpus/out/owned-coverage.json'));
const perFunction=Number(arg('--per-function','2'));
if(!Number.isInteger(perFunction)||perFunction<1||perFunction>12)
  throw new TypeError('per-function must be 1..12');
const records=readFileSync(input,'utf8').split('\n').filter(Boolean).map(JSON.parse);
const casesByName=new Map(cases.map(c=>[c.project+'/'+c.file+'/'+c.entry,c]));
const observations=[],counts={},families=new Map(),blockers=new Map();
const add=(obj,key)=>obj[key]=(obj[key]??0)+1;
for(const row of records){
  if(row.schema!=='real-source-corpus/1')
    throw new TypeError('Not the pinned real-source corpus');
  if(row.index>=perFunction)continue;
  const spec=casesByName.get(row.family);
  if(!spec)throw new TypeError('Unknown real source family '+row.family);
  let status,reason=null;
  if(!row.verified||!row.returned){
    status='native_not_verified';
  }else if(spec.setup){
    status='guest_fixture_not_portable';
    reason='Guest-defined callbacks/prototypes are not portable data arguments in training-js/1';
  }else{
    let source=row.observation.source.originalText;
    // Removing TS export modifiers and Lodash CommonJS assignment is the
    // packaging adapter; the original function bodies are never rewritten.
    source=source.replace(/\bexport\s+(?=(?:async\s+)?function\b)/g,'')
      .replace(/\bexport\s+(?=(?:const|let|var)\b)/g,'')
      .replace(/^\s*module\.exports\s*=\s*[\w$]+\s*;?\s*$/gm,'');
    if(row.project==='vscode'){
      source=ts.transpileModule(source,{fileName:spec.file,compilerOptions:{
        target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None
      }}).outputText.replace(/^["']use strict["'];\s*/,'');
    }
    source='"use strict";\n'+source;
    if(Buffer.byteLength(source,'utf8')>2048){
      status='source_bundle_limit';
      reason='Original entry plus genuine helpers exceeds current model source bundle';
    }else{
      const checked=verifyTrainingCase({source,entry:spec.entry,args:spec.args(row.index),
        maxSteps:10000,maxGenerated:1024});
      status=checked.status;
      reason=checked.reason??null;
    }
  }
  const item={family:row.family,index:row.index,sourceURL:row.sourceURL,
    nativeVerified:row.verified&&row.returned,ownedStatus:status,
    reason:reason?String(reason).slice(0,400):null};
  observations.push(item);add(counts,status);
  const family=families.get(row.family)??{project:row.project,
    verifiedNative:0,verifiedOwned:0,attempted:0,statuses:[]};
  family.attempted++;
  if(item.nativeVerified)family.verifiedNative++;
  if(status==='locally_verified')family.verifiedOwned++;
  family.statuses.push(status);
  families.set(row.family,family);
  if(status!=='locally_verified')blockers.set(status,(blockers.get(status)??0)+1);
}
const output={schema:'real-source-owned-coverage/1',admitted:false,
  basis:'original real source functions; packaging-only adapter; two independent V8 checks for local verification',
  totalFamilies:families.size,invocations:observations.length,
  ownedVerified:counts.locally_verified??0,counts,
  blockers:Object.fromEntries([...blockers].sort((a,b)=>b[1]-a[1])),
  byFamily:Object.fromEntries([...families].sort((a,b)=>a[0].localeCompare(b[0]))),
  examples:observations};
mkdirSync(dirname(out),{recursive:true});
writeFileSync(out,JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({families:output.totalFamilies,invocations:output.invocations,
  ownedVerified:output.ownedVerified,blockers:output.blockers}));
