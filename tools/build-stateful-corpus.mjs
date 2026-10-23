#!/usr/bin/env node
// Reproducible native-V8 diagnostic corpus of stateful real production code.
// The upstream source is unchanged on disk; compilation, module linking and
// all scenario drivers are explicit. This is NOT owned interpreter execution,
// an independent intermediate-event oracle, or admitted training data.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {observeProgram} from '../src/observational.js';
import {scenarios as baselineScenarios,upstream,pinnedSha256} from '../corpus/stateful/cases.mjs';
import {adversarialScenarios} from '../corpus/stateful/extension-cases.mjs';

const argv=process.argv.slice(2);
const arg=(name,fallback)=>argv.includes(name)?argv[argv.indexOf(name)+1]:fallback;
const suite=arg('--suite','baseline');
if(!['baseline','adversarial','combined'].includes(suite))throw new Error('Invalid --suite');
const scenarios=suite==='baseline'?baselineScenarios:suite==='adversarial'?
  adversarialScenarios:[...baselineScenarios,...adversarialScenarios];
const output=resolve(arg('--output','corpus/out/stateful-traces.jsonl'));
const reportFile=resolve(arg('--report','corpus/out/stateful-report.json'));
const reviewFile=resolve(arg('--review','corpus/out/stateful-review.md'));
const perScenario=Number(arg('--per-scenario','12'));
const limit=Number(arg('--limit',String(scenarios.length)));
const projectFilter=arg('--project',null);
const maxEvents=Number(arg('--max-events','2400'));
const timeoutMs=Number(arg('--timeout-ms','2500'));
const minVerified=Number(arg('--min-verified','0'));
if(!Number.isSafeInteger(perScenario)||perScenario<1||perScenario>128||
   !Number.isSafeInteger(limit)||limit<1||limit>scenarios.length||
   !Number.isSafeInteger(maxEvents)||maxEvents<10||maxEvents>50000||
   !Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||
   !Number.isSafeInteger(minVerified)||minVerified<0)
  throw new TypeError('Invalid stateful corpus generator bounds');
const sha=text=>createHash('sha256').update(text).digest('hex');
const sources=new Map();
for(const [name,ref] of Object.entries(upstream)) {
  const path=resolve('corpus/stateful/upstream',ref.path);
  const source=readFileSync(path,'utf8');
  if(!source.trim())throw new Error('Empty upstream source '+name);
  if(sha(source)!==pinnedSha256[name])throw new Error('Vendored source hash differs from pinned upstream: '+name);
  sources.set(name,{...ref,sha256:sha(source),source});
}
function encodeModule(name) {
  const item=sources.get(name);
  if(!item)throw new TypeError('Unpinned module '+name);
  const compiled=ts.transpileModule(item.source,{fileName:item.path,
    compilerOptions:{allowJs:true,target:ts.ScriptTarget.ES2022,
      module:ts.ModuleKind.CommonJS,esModuleInterop:true},
    reportDiagnostics:true});
  const problems=(compiled.diagnostics??[]).filter(x=>x.category===ts.DiagnosticCategory.Error);
  if(problems.length)throw new Error('Invalid vendored module '+name+': '+
    ts.flattenDiagnosticMessageText(problems[0].messageText,'\n'));
  return '__factories['+JSON.stringify(name)+']=function(module,exports,require){\n'+
    compiled.outputText+'\n};\n';
}
function bundle(scenario) {
  // The guest loader never delegates to native require or other host APIs.
  // All linked modules are exact pinned copies (after TS/CJS lowering).
  const header=`"use strict";
const process = Object.freeze({env:Object.freeze({NODE_ENV:'development'})});
const queueMicrotask = callback => Promise.resolve().then(callback);
const __factories = Object.create(null);
const __cache = Object.create(null);
function __require(id) {
  if(!Object.prototype.hasOwnProperty.call(__factories,id))
    throw new Error('Undeclared guest module: '+id);
  if(Object.prototype.hasOwnProperty.call(__cache,id))return __cache[id].exports;
  const instance={exports:{}};
  __cache[id]=instance;
  __factories[id](instance,instance.exports,__require);
  return instance.exports;
}
`;
  const names=new Set([...scenario.modules]);
  // If a module uses a true imported dependency, preserve that dependency.
  if(names.has('p-limit'))names.add('yocto-queue');
  if(names.has('axios-interceptors')){names.add('axios-utils');names.add('axios-bind');}
  const modules=[...names].map(encodeModule).join('\n');
  // Only these declared Axios dependency names are mapped. No ambient require.
  const linkedAliases=names.has('axios-interceptors')?
    '__factories["../utils.js"]=__factories["axios-utils"];\n'+
    '__factories["./helpers/bind.js"]=__factories["axios-bind"];\n':'';
  const text=header+modules+linkedAliases+'\n// BEGIN BENCHMARK DRIVER: '+scenario.id+'\n'+
    scenario.run+'\n// END BENCHMARK DRIVER\n';
  if(!/\b(?:async\s+)?function\s+run\s*\(/.test(scenario.run))
    throw new Error('Scenario missing explicit run(seed) function: '+scenario.id);
  return {text,modules:[...names],sourceHashes:Object.fromEntries([...names].map(n=>[n,sources.get(n).sha256]))};
}
function split(scenario){
  // Package-level, not per-invocation random splitting. Mixed application
  // workloads go to test to avoid training on test-project dependencies.
  if(scenario.project==='application'||['quick-lru','koa-compose'].includes(scenario.project))return 'test';
  if(['p-limit','eventemitter3'].includes(scenario.project))return 'validation';
  return 'train';
}
const categoryCount={},statuses={},byProject={},byFamily={},bySplit={};
const records=[],failed=[],review=[],perKind={};
let effects=0,events=0,traceBytes=0,sourceBytes=0,traceCalls=0,traceReturns=0;
if(projectFilter&&!scenarios.some(s=>s.project===projectFilter))
  throw new Error('Unknown pinned benchmark project '+projectFilter);
const first=(projectFilter?scenarios.filter(s=>s.project===projectFilter):scenarios).slice(0,limit);
for(const scenario of first) {
 const built=bundle(scenario),family=scenario.id,trainSplit=split(scenario);
 for(let i=0;i<perScenario;i++){
  const seed=((i*17+5)%41)-18;
  const group=byFamily[family]??={project:scenario.project,split:trainSplit,modules:built.modules,
    requested:0,checked:0,throws:0,errors:0,events:0,mutationEffects:0,avgBytes:0};
  group.requested++;
  const row=byProject[scenario.project]??={requested:0,checked:0,throws:0,errors:0};
  row.requested++;
  const s=bySplit[trainSplit]??={requested:0,checked:0};s.requested++;
  try{
   const obs=await observeProgram({
    source:built.text,entry:'run',args:[seed],language:'js',
    filename:'stateful/'+family+'.js',timeoutMs,maxEvents,maxNodes:800,
    randomSeed:42,clockNow:1700000000000+seed*1000
   });
   const checked=obs.evidence.independentUninstrumentedV8;
   const kind=obs.completion.kind;
   if(checked){group.checked++;row.checked++;s.checked++;}else{
    failed.push({family,index:i,status:'reference_mismatch',completion:obs.completion,
      reference:obs.evidence.referenceCompletion});
   }
   if(kind==='throw'){group.throws++;row.throws++;}
   const perRecord={};
   let changes=0;
   for(const e of obs.events){
    perKind[e.kind]=(perKind[e.kind]??0)+1;
    perRecord[e.kind]=(perRecord[e.kind]??0)+1;
    changes+=e.effects?.length??0;
   }
   const bytes=Buffer.byteLength(JSON.stringify(obs.events),'utf8');
   effects+=changes;events+=obs.events.length;traceBytes+=bytes;sourceBytes+=Buffer.byteLength(built.text,'utf8');
   traceCalls+=perRecord.call??0;traceReturns+=perRecord.return??0;
   group.events+=obs.events.length;group.mutationEffects+=changes;group.avgBytes+=bytes;
   const item={schema:'stateful-real-source/1',authority:'trusted-v8-diagnostic-only',
    admitted:false,project:scenario.project,family,split:trainSplit,
    adversarial:scenario.adversarial,modules:built.modules,upstreamHashes:built.sourceHashes,
    scenarioIndex:i,seed,verified:checked,completionKind:kind,
    events:obs.events.length,changes,traceBytes:bytes,perKind:perRecord,observation:obs};
   records.push(item);
   if(i===0)review.push(item);
  }catch(error){
   const message=String(error?.stack??error).slice(0,900);
   failed.push({family,index:i,status:'observer_error',message});
   group.errors++;row.errors++;
  }
 }
}
const counts={scenarioFamilies:first.length,productionLibraries:8,
 crossLibraryScenarios:first.filter(s=>s.project==='application').length,
 requested:first.length*perScenario,examples:records.length,
 agreed:records.filter(x=>x.verified).length,disagreed:failed.filter(x=>x.status==='reference_mismatch').length,
 observerErrors:failed.filter(x=>x.status==='observer_error').length,
 returns:records.filter(x=>x.completionKind==='return').length,
 throws:records.filter(x=>x.completionKind==='throw').length,
 events,mutationEffects:effects,traceCalls,traceReturns,traceBytes,sourceBytes};
const sortedBytes=records.filter(x=>x.verified).map(x=>x.traceBytes).sort((a,b)=>a-b);
const sortedEvents=records.filter(x=>x.verified).map(x=>x.events).sort((a,b)=>a-b);
const quantile=(v,q)=>v[Math.min(v.length-1,Math.floor((v.length-1)*q))]??null;
const report={schema:'stateful-real-source-report/1',admitted:false,
 authority:'native-V8-final-observable-outcome-only',
 fixtureEnvironment:{randomSeed:42,clock:'fixed-per-seed',externalAccess:'none',moduleLoader:'vendored-only',
  sideEffects:'captured in explicit scenario return graph; no real network/disk'},
 options:{suite,perScenario,maxEvents,limit,timeoutMs},counts,
 quantiles:{bytes:{p50:quantile(sortedBytes,.5),p90:quantile(sortedBytes,.9)},
  events:{p50:quantile(sortedEvents,.5),p90:quantile(sortedEvents,.9)}},
 byProject,byFamily,bySplit,perKind,failures:failed,
 upstream:Object.fromEntries([...sources].map(([name,row])=>[name,{
  repository:row.repository,revision:row.revision,path:row.path,sha256:row.sha256,license:row.license}])),
 limitations:[
  'Independent uninstrumented V8 runs compare final observable argument/result graph, not each intermediate event.',
  'V8 instrumentation and scenario drivers are diagnostics; no trace is owned-interpreter admitted.',
  'Imported guest code is transpiled into an isolated synthetic CommonJS loader; no native dependency fallback.',
  'No real filesystem, network, timer or process effects; application integrations use logged in-memory adapters.',
  'A matched final result is not an independently verified trace of hidden Map/Set slots, Proxy traps or all async scheduling.'
 ]};
const fmt=v=>Array.isArray(v)?v[0]==='ref'?'&'+v[1]:
  v[0]==='undefined'? 'undefined':
  v[0]==='str'?JSON.stringify(v[1]):
  v.length>1?String(v[1]):v[0]:JSON.stringify(v);
const examples=['# Stateful real-source execution trace review','',
 'These examples execute unmodified upstream libraries after pinned TS/CJS lowering, inside a deterministic in-memory scenario harness. Only final observable outcomes have been cross-checked against uninstrumented V8. The trace records are **not** owned semantic training data.','',
 '## Summary',
 ...Object.entries(counts).map(([name,count])=>'- '+name+': '+count),
 '','## Project-level splits',
 ...Object.entries(bySplit).map(([name,item])=>'- '+name+': '+item.checked+'/'+item.requested),
 '','## Representative traces',''];
for(const item of review){
 const text=item.observation.source.text;
 examples.push('### '+item.family+' — '+item.adversarial,'',
  'Modules: '+item.modules.join(', ')+'; '+item.events+' events; '+
   item.changes+' property effects; '+item.traceBytes+' bytes.','','```text');
 for(const e of item.observation.events.slice(0,42)){
  const expr=text.slice(e.site?.start??0,e.site?.end??0).replace(/\s+/g,' ').slice(0,86);
  const effects=(e.effects??[]).slice(0,3).map(w=>'&'+w.identity+'.'+w.key+':'+fmt(w.before)+'→'+fmt(w.after));
  examples.push(e.kind+(expr?' '+expr:'')+(e.kind==='branch'?' ['+e.path+']':'')+
   ' → '+fmt(e.result)+(effects.length?'  {'+effects.join('; ')+'}':''));
 }
 if(item.observation.events.length>42)examples.push('… ('+(item.observation.events.length-42)+' more events)');
 examples.push('```','',
   'Observable completion: '+JSON.stringify(item.observation.completion),
   'Independent final-state match: '+item.verified,'');
}
examples.push('## Interpretation','',
  '- When reading this trace, check callback entry/completion, environment-visible logs, aliases, cache/state mutations and rejected/fulfilled promise order.',
  '- A `call` record can arrive after the callee `return` in the native observer: it denotes completion of a calling expression, not invocation start.',
  '- Object graph snapshots cover known Map/Set data but may miss internal protocol effects. Never delete writes merely because the diff is empty.',
  '- This corpus stresses non-pure business flows; it must not be silently promoted to `semantic-execution/2` training without an owned trace or separately justified observation contract.');
for(const [path,content] of [
 [output,records.map(x=>JSON.stringify(x)).join('\n')+'\n'],
 [reportFile,JSON.stringify(report,null,2)+'\n'],
 [reviewFile,examples.join('\n')+'\n']
]){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,content);}
console.log(JSON.stringify({counts,bytes:report.quantiles.bytes,events:report.quantiles.events,
 byProject,bySplit,failures:failed.slice(0,6)}));
if(counts.agreed<minVerified)throw new Error('Insufficient independently compared stateful observations: '+counts.agreed+' < '+minVerified);
