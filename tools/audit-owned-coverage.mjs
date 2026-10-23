#!/usr/bin/env node
// Read-only owned-interpreter coverage bridge for the pinned native corpus.
// A successful native V8 observation is NOT evidence that the owned runtime
// executes it, and a locally-verified owned trace is NOT corpus admission.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {verifyTrainingCase,recheckIndependentTrainingEvidence} from '../src/training/admit.js';
import {cases,sources} from '../corpus/cases.mjs';
import {original,corpusSplit} from '../corpus/pinned-source.mjs';
import {buildOwnedFixtureEntry} from '../corpus/owned-fixture-adapter.mjs';

const argv=process.argv.slice(2);
const arg=(name,fallback)=>argv.includes(name)?argv[argv.indexOf(name)+1]:fallback;
const input=resolve(arg('--input','corpus/out/traces.jsonl'));
const out=resolve(arg('--output','corpus/out/owned-coverage.json'));
const perFunction=Number(arg('--per-function','2'));
const indexStart=Number(arg('--index-start','0'));
const indexEnd=Number(arg('--index-end',String(perFunction)));
const requireComplete=argv.includes('--require-complete');
const localEpisodesFlag=arg('--local-episodes',null);
const localEpisodesPath=localEpisodesFlag===null?null:resolve(localEpisodesFlag);
const minOwnedVerified=Number(arg('--min-owned-verified','0'));
if(!Number.isInteger(perFunction)||perFunction<1||perFunction>12 ||
   !Number.isInteger(indexStart)||indexStart<0 ||
   !Number.isInteger(indexEnd)||indexEnd<=indexStart||indexEnd>perFunction)
  throw new TypeError('per-function must be 1..12');
if(!Number.isSafeInteger(minOwnedVerified)||minOwnedVerified<0 ||
   (argv.includes('--local-episodes') && (!localEpisodesFlag||localEpisodesFlag.startsWith('--'))))
  throw new TypeError('Invalid local-episodes path or minimum owned verified count');
const records=readFileSync(input,'utf8').split('\n').filter(Boolean).map(JSON.parse);
const casesByName=new Map(cases.map(c=>[c.project+'/'+c.file+'/'+c.entry,c]));
const observations=[],counts={},families=new Map(),blockers=new Map();
const localEpisodes=[];
const seen=new Set(),pinnedCache=new Map(),sourceCache=new Map();
const byProject={};
const hash=text=>createHash('sha256').update(text).digest('hex');
const add=(obj,key)=>obj[key]=(obj[key]??0)+1;
for(const row of records){
  if(row.schema!=='real-source-corpus/1')
    throw new TypeError('Not the pinned real-source corpus');
  if(requireComplete && (!Number.isInteger(row.index)||row.index<0||
     row.index>=perFunction||!casesByName.has(row.family)))
    throw new TypeError('Out-of-inventory native corpus invocation: '+row.family+' #'+row.index);
  if(row.index>=perFunction||row.index<indexStart||row.index>=indexEnd)continue;
  if(requireComplete && (row.verified!==row.observation?.evidence?.independentUninstrumentedV8||
     row.returned!==(row.observation?.completion?.kind==='return')))
    throw new TypeError('Native corpus observation evidence mismatch: '+row.family+' #'+row.index);
  const identity=row.family+'#'+row.index;
  if(seen.has(identity))throw new TypeError('Duplicate corpus invocation '+identity);
  seen.add(identity);
  const spec=casesByName.get(row.family);
  if(!spec)throw new TypeError('Unknown real source family '+row.family);
  // The native report is a diagnostic input, never an authority to choose
  // different source bytes, an invented split or a renamed upstream revision.
  const pinned=pinnedCache.get(row.family)??original(spec);
  pinnedCache.set(row.family,pinned);
  const expected=sources[spec.project];
  if(row.project!==spec.project||row.pinnedRevision!==expected.revision||
     row.license!==expected.license||row.sourceURL!==pinned.sourceURL||
     row.sourceFileSha256!==hash(pinned.sourceFile)||
     row.observation?.source?.originalText!==pinned.text||
     row.split!==corpusSplit(row.family)||
     !Number.isInteger(row.index)||row.index<0)
    throw new TypeError('Pinned corpus provenance mismatch: '+row.family+' #'+row.index);
  let status,reason=null,checked;
  if(!row.verified||!row.returned){
    status='native_not_verified';
  }else{
    let source=sourceCache.get(row.family);
    if(source===undefined){
      source=pinned.text;
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
      sourceCache.set(row.family,source);
    }
    let entry=spec.entry,args=spec.args(row.index);
    if(spec.setup){
      try {
        const fixture=buildOwnedFixtureEntry(spec.setup(row.index),entry);
        source+='\n'+fixture.source;
        entry=fixture.entry;
        args=[];
      }catch(error){
        status='guest_fixture_not_portable';
        reason='Fixture cannot be represented as owned guest code: '+String(error.message);
      }
    }
    source='"use strict";\n'+source;
    if(status){
      // Unportable fixture shapes still fail closed.
    }else if(Buffer.byteLength(source,'utf8')>2048){
      status='source_bundle_limit';
      reason='Original entry plus genuine helpers exceeds current model source bundle';
    }else{
      checked=verifyTrainingCase({source,entry,args,
        maxSteps:10000,maxGenerated:1024});
      status=checked.status;
      reason=checked.reason??null;
    }
  }
  if(status==='locally_verified'){
    // Re-run independent outcome and source-operation/control audits from the
    // serialized archive before emitting any local training candidate.
    const evidence=recheckIndependentTrainingEvidence(checked.exported);
    if(!evidence.valid){
      status='evidence_recheck_failure';
      reason=evidence.reason;
    }else if(localEpisodesPath){
      checked.exported.sidecar.split=row.split;
      checked.exported.sidecar.provenance={
        corpus:'pinned-real-source',family:row.family,index:row.index,
        project:row.project,revision:row.pinnedRevision,license:row.license,
        sourceURL:row.sourceURL,sourceFileSha256:row.sourceFileSha256,
        independentNativeFinalOutcome:true,independentOwnedReplay:true,
        admission:'pending external megatoken gate'
      };
      localEpisodes.push(JSON.stringify(checked.exported));
    }
  }
  const item={family:row.family,index:row.index,sourceURL:row.sourceURL,
    nativeVerified:row.verified&&row.returned,ownedStatus:status,
    reason:reason?String(reason).slice(0,400):null};
  observations.push(item);add(counts,status);
  const project=byProject[spec.project]??={invocations:0,ownedVerified:0,counts:{}};
  project.invocations++;add(project.counts,status);
  if(status==='locally_verified')project.ownedVerified++;
  const family=families.get(row.family)??{project:row.project,
    verifiedNative:0,verifiedOwned:0,attempted:0,statuses:[]};
  family.attempted++;
  if(item.nativeVerified)family.verifiedNative++;
  if(status==='locally_verified')family.verifiedOwned++;
  family.statuses.push(status);
  families.set(row.family,family);
  if(status!=='locally_verified')blockers.set(status,(blockers.get(status)??0)+1);
}
if(requireComplete){
  for(const spec of cases){
    const family=spec.project+'/'+spec.file+'/'+spec.entry;
    for(let index=indexStart;index<indexEnd;index++)
      if(!seen.has(family+'#'+index))
        throw new Error('Missing corpus invocation '+family+'#'+index);
  }
  if(observations.length!==cases.length*(indexEnd-indexStart))
    throw new Error('Unexpected corpus invocation count');
}
const output={schema:'real-source-owned-coverage/1',admitted:false,
  basis:'unchanged upstream functions and optional owned callback wrapper; independent V8 outcome/operation verification; diagnostic only',
  options:{perFunction,indexStart,indexEnd,requireComplete},
  coverage:requireComplete && indexStart===0 && indexEnd===12
    ?'all-pinned-real-source-invocations':requireComplete?'complete-index-partition':'partial',
  totalFamilies:families.size,invocations:observations.length,
  ownedVerified:counts.locally_verified??0,counts,byProject,
  blockers:Object.fromEntries([...blockers].sort((a,b)=>b[1]-a[1])),
  byFamily:Object.fromEntries([...families].sort((a,b)=>a[0].localeCompare(b[0]))),
  locallyVerifiedEpisodes:localEpisodesPath?localEpisodes.length:null,
  localEpisodesFile:localEpisodesPath,
  evidence:'owned execution, replay, V8 outcome and intermediate operation/control rechecked',
  examples:observations};
mkdirSync(dirname(out),{recursive:true});
writeFileSync(out,JSON.stringify(output,null,2)+'\n');
if(localEpisodesPath){
  mkdirSync(dirname(localEpisodesPath),{recursive:true});
  writeFileSync(localEpisodesPath,localEpisodes.join('\n')+(localEpisodes.length?'\n':''));
}
console.log(JSON.stringify({families:output.totalFamilies,invocations:output.invocations,
  ownedVerified:output.ownedVerified,blockers:output.blockers,
  localEpisodes:localEpisodes.length}));
if(output.ownedVerified<minOwnedVerified)
  throw new Error('Owned locally verified coverage regression: '+
    output.ownedVerified+' < '+minOwnedVerified);
