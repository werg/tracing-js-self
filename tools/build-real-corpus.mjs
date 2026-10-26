#!/usr/bin/env node
// Reproducible real-source diagnostic corpus, NOT admitted model training data.
// Reads pinned, vendored third-party source and runs both instrumented and
// uninstrumented trusted V8 executions; neither is an owned interpreter replay.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {observeProgram} from '../src/observational.js';
import {cases,sources} from '../corpus/cases.mjs';
import {original,corpusSplit} from '../corpus/pinned-source.mjs';

const args=process.argv.slice(2);
const option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const perFunction=Number(option('--per-function','12'));
const maxEvents=Number(option('--max-events','2400'));
const limit=Number(option('--limit',String(cases.length)));
const output=resolve(option('--output','corpus/observations.jsonl'));
const reportPath=resolve(option('--report','corpus/report.json'));
const reviewPath=resolve(option('--review','corpus/review.md'));
const strict=Number(option('--min-checked','0'));
if(!Number.isInteger(perFunction)||perFunction<1||perFunction>128||
   !Number.isInteger(maxEvents)||maxEvents<10||maxEvents>50000||
   !Number.isInteger(limit)||limit<1||limit>cases.length)
  throw new TypeError('Invalid corpus generator limits');

const sha=text=>createHash('sha256').update(text).digest('hex');
// The owned-coverage bridge uses the same pinned source construction.
const split=corpusSplit;
const fmt=v=>{
  if(!Array.isArray(v))return JSON.stringify(v);
  if(v[0]==='ref')return '&'+v[1];
  if(v[0]==='undefined'||v[0]==='null'||v[0]==='absent')return v[0];
  if(v[0]==='str')return JSON.stringify(v[1]);
  if(v[0]==='bigint')return v[1]+'n';
  return String(v[1]);
};
function render(e,source){
  const expression=(e.kind==='enter'||e.kind==='end'?'':source.slice(
    e.site.start,e.site.end)).replace(/\s+/g,' ').slice(0,86);
  let line=e.kind+(expression?' '+expression:'');
  if(e.kind==='branch')line+=' → '+e.path;
  else if(e.kind==='enter')line+=' → '+e.name;
  else line+=' → '+fmt(e.result);
  if(e.binding)line+=' ('+e.binding+')';
  if(e.effects?.length)line+='  ['+e.effects.slice(0,4).map(w=>
    '&'+w.identity+'.'+w.key+': '+fmt(w.before)+' → '+fmt(w.after)).join('; ')+
    (e.effects.length>4?'; …':'')+']';
  return line;
}
const records=[],stats=[],failures=[];
const selected=cases.slice(0,limit);
const totals={requested:selected.length*perFunction,functions:selected.length,checked:0,
  returned:0,throws:0,mismatches:0,errors:0,examples:0,generatedBytes:0,
  sourceBytes:0,effects:0,expressionEvents:0,branchEvents:0,
  byProject:{},bySplit:{}};
const kinds={};
for(const spec of selected){
  const family=spec.project+'/'+spec.file+'/'+spec.entry;
  let src;
  try {src=original(spec);}
  catch(error){failures.push({family,error:String(error)});totals.errors+=perFunction;continue;}
  for(let i=0;i<perFunction;i++){
    const vector=spec.args(i);
    let observation;
    const input=spec.setup?{setupSource:spec.setup(i),args:[]}: {args:vector};
    try {
      observation=await observeProgram({
        source:src.text,entry:spec.entry,language:spec.project==='vscode'?'ts':'js',
        filename:spec.project+'/'+spec.file,timeoutMs:1500,maxEvents,
        maxNodes:256,...input
      });
    }catch(error){
      totals.errors++;failures.push({family,index:i,kind:'observation_error',
        message:String(error?.message??error)});
      continue;
    }
    const verified=observation.evidence.independentUninstrumentedV8;
    const returned=observation.completion.kind==='return';
    if(verified)totals.checked++;else totals.mismatches++;
    if(returned)totals.returned++;else totals.throws++;
    const bytes=Buffer.byteLength(JSON.stringify(observation.events),'utf8');
    const sourceBytes=Buffer.byteLength(src.text,'utf8');
    const effectCount=observation.events.reduce((n,e)=>n+(e.effects?.length??0),0);
    const byKind={};
    for(const event of observation.events){
      kinds[event.kind]=(kinds[event.kind]??0)+1;
      byKind[event.kind]=(byKind[event.kind]??0)+1;
    }
    totals.effects+=effectCount;
    totals.generatedBytes+=bytes;totals.sourceBytes+=sourceBytes;
    totals.expressionEvents+=observation.events.length;
    totals.branchEvents+=byKind.branch??0;
    const project=totals.byProject[spec.project]??={checked:0,total:0};
    project.total++;if(verified&&returned)project.checked++;
    const group=split(family);
    const s=totals.bySplit[group]??={total:0,checked:0};
    s.total++;if(verified&&returned)s.checked++;
    const item={
      schema:'real-source-corpus/1',project:spec.project,
      pinnedRevision:sources[spec.project].revision,license:sources[spec.project].license,
      family,split:group,index:i,invocationKind:spec.setup?'guest-fixture':'portable-input',
      sourceURL:src.sourceURL,sourceFileSha256:sha(src.sourceFile),
      mutatesInput:!!spec.mutatesInput,verified,returned,
      traceBytes:bytes,sourceBytes,events:observation.events.length,
      effectCount,byKind,observation
    };
    records.push(item);
    stats.push({family,project:spec.project,split:group,
      verified,returned,bytes,events:item.events,effectCount,
      read:byKind.read??0,branch:byKind.branch??0,kindCount:byKind});
  }
}
totals.examples=records.length;
const accepted=stats.filter(x=>x.verified&&x.returned);
const acceptedFamilies=new Set(accepted.map(x=>x.family));
const metrics=key=>{
  const values=accepted.map(x=>x[key]).sort((a,b)=>a-b);
  return {mean:values.length?values.reduce((a,b)=>a+b,0)/values.length:null,
    p50:values[Math.floor(values.length*.5)]??null,
    p90:values[Math.floor(values.length*.9)]??null,
    max:values.at(-1)??null};
};
const byFamily=Object.fromEntries([...new Set(stats.map(x=>x.family))].sort().map(f=>{
  const values=stats.filter(x=>x.family===f);
  return [f,{requested:perFunction,checked:values.filter(x=>x.verified&&x.returned).length,
    mismatches:values.filter(x=>!x.verified).length,
    throws:values.filter(x=>!x.returned).length,
    medianBytes:values.map(x=>x.bytes).sort((a,b)=>a-b)[Math.floor(values.length/2)]}];
}));
const report={schema:'real-source-corpus-report/1',mode:'diagnostic-only',
  sources,options:{perFunction,maxEvents,limit},totals,
  acceptedFunctions:acceptedFamilies.size,acceptedExamples:accepted.length,
  metrics:{traceBytes:metrics('bytes'),logicalEvents:metrics('events'),
    mutations:metrics('effectCount'),reads:metrics('read'),branches:metrics('branch')},
  kinds,byFamily,failures};
mkdirSync(dirname(output),{recursive:true});
mkdirSync(dirname(reportPath),{recursive:true});
mkdirSync(dirname(reviewPath),{recursive:true});
writeFileSync(output,records.map(x=>JSON.stringify(x)).join('\n')+'\n');
writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
const pickedNames=[
  'vscode/numbers.ts/clamp','vscode/arrays.ts/coalesceInPlace',
  'vscode/strings.ts/trim','lodash/_arrayMap.js/arrayMap',
  'lodash/_baseClamp.js/baseClamp'
];
const review=[
'# Real-world effective execution trace inspection',
'',
'These are **native V8 diagnostic observations**, not independently admitted',
'owned semantic-execution/5 trajectories. Every accepted example matches a',
'second, uninstrumented V8 run on its return/throw and reachable argument/result',
'graph. Source family (not individual invocation) determines the frozen split.',
'',
'## Dataset measurements',
'',
'- Invocations attempted: '+totals.requested,
'- Verified completed observations: '+accepted.length,
'- Verified distinct source functions: '+acceptedFamilies.size,
'- Instrumentation/reference disagreements: '+totals.mismatches,
'- Guest throws: '+totals.throws+'; generation errors: '+totals.errors,
'- Median serialized event bytes: '+report.metrics.traceBytes.p50,
'- Median logical events: '+report.metrics.logicalEvents.p50,
'- Median visible state changes: '+report.metrics.mutations.p50,
'',
'## Representative executions',
''
];
for(const wanted of pickedNames){
  const row=records.find(x=>x.family===wanted&&x.verified&&x.returned);
  if(!row)continue;
  review.push('### '+wanted,'','Source: '+row.sourceURL,'',
    'Invoked with fixture '+row.index+'; '+row.events+' events, '+row.effectCount+
    ' state changes, '+row.traceBytes+' serialized event bytes.','','~~~text',
    ...row.observation.events.slice(0,36).map(e=>render(e,row.observation.source.text)));
  if(row.observation.events.length>36)review.push('… ('+
    (row.observation.events.length-36)+' further events)');
  review.push('~~~','','Result graph: '+JSON.stringify(row.observation.observableGraph).slice(0,700),'');
}
review.push('## Coverage and interpretation','',
  '- The measured trace contains source-anchored arithmetic, read, call, branch,',
  '  return and write observations; state differences capture native array methods.',
  '- Some intermediate local values remain implicit; inspect call/return and',
  '  property values together when assessing reasoning sufficiency.',
  '- Accessors and proxy traps are not invoked by the graph snapshot. Proxy',
  '  internals, native module effects and asynchronous host work are incomplete.',
  '- A large event count can indicate over-instrumented reads or repeated',
  '  condition bookkeeping. Causal compaction should be evaluated separately.',
  '- Do not equate uninstrumented-V8 outcome agreement with complete event-level',
  '  verification or model-training admission.','');
writeFileSync(reviewPath,review.join('\n')+'\n');
const compact={requested:totals.requested,functions:totals.functions,
  accepted:accepted.length,acceptedFunctions:acceptedFamilies.size,
  mismatches:totals.mismatches,throws:totals.throws,errors:totals.errors,
  medianBytes:report.metrics.traceBytes.p50,
  medianEvents:report.metrics.logicalEvents.p50,
  p90Bytes:report.metrics.traceBytes.p90,
  mutationEvents:totals.effects};
console.log(JSON.stringify(compact));
console.log('Per-function checks: '+JSON.stringify(
  Object.entries(byFamily).map(([k,v])=>[k,v.checked]).filter(([,v])=>v<perFunction)));
if(strict>0&&accepted.length<strict)
  throw new Error('Insufficient independently checked real-world observations: '+
    accepted.length+' < '+strict);
