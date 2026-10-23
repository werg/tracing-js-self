#!/usr/bin/env node
// Strict audit of pinned real-library V8 observations. A final-outcome match
// is not an intermediate-event oracle or an admitted owned trace.
import {createHash} from 'node:crypto';
import {createReadStream,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {resolve,dirname} from 'node:path';
import {scenarios,upstream,pinnedSha256} from '../corpus/stateful/cases.mjs';

const argv=process.argv.slice(2),arg=(f,d)=>argv.includes(f)?argv[argv.indexOf(f)+1]:d;
const input=resolve(arg('--input','corpus/out/stateful-traces.jsonl'));
const output=resolve(arg('--output','corpus/out/stateful-quality.json'));
const review=resolve(arg('--review','corpus/out/stateful-quality.md'));
const complete=argv.includes('--require-complete');
const minVerified=Number(arg('--min-verified','0'));
if(!Number.isSafeInteger(minVerified)||minVerified<0)throw new TypeError('Invalid minimum');
const known=new Map(scenarios.map(s=>[s.id,s]));
const pinned=new Map(Object.entries(upstream).map(([name,meta])=>{
  const contents=readFileSync(resolve('corpus/stateful/upstream',meta.path),'utf8');
  const sha=createHash('sha256').update(contents).digest('hex');
  if(sha!==pinnedSha256[name])throw new Error('Changed upstream vendor module '+name);
  return [name,sha];
}));
const split=project=>project==='application'||['quick-lru','koa-compose'].includes(project)?'test':
  ['p-limit','eventemitter3'].includes(project)?'validation':'train';
const totals={invocations:0,nativeVerified:0,unverified:0,returnCompletions:0,
  throwCompletions:0,events:0,heapChanges:0,sourceSiteViolations:0,
  recordedByteDisagreements:0,vendorOrLoaderSourceEvents:0,driverSourceEvents:0,
  loaderSourceEvents:0,effectEvents:0,awaitEvents:0,opaqueEvents:0,sideEffectMismatches:0};
const byFamily={},byProject={},kinds={},failures=[],seen=new Set(),projectSplits={},byModuleSource={};
let lineNumber=0;
for await(const line of createInterface({input:createReadStream(input),crlfDelay:Infinity})){
  if(!line.trim())continue;
  lineNumber++;
  const x=JSON.parse(line),s=known.get(x.family);
  if(x.schema!=='stateful-real-source/1'||x.admitted!==false||
     x.authority!=='trusted-v8-diagnostic-only'||!s||
     x.project!==s.project||x.split!==split(s.project)||
     !Number.isInteger(x.scenarioIndex)||x.scenarioIndex<0||x.scenarioIndex>=12)
    throw new Error('Invalid stateful row or family at line '+lineNumber);
  const id=x.family+'#'+x.scenarioIndex;
  if(seen.has(id))throw new Error('Duplicate stateful invocation '+id);
  seen.add(id);
  if(x.seed!==((x.scenarioIndex*17+5)%41)-18)
    throw new Error('Changed pinned stateful seed '+id);
  const expectedModules=[...new Set([...s.modules,
    ...(s.modules.includes('p-limit')?['yocto-queue']:[]),
    ...(s.modules.includes('axios-interceptors')?['axios-utils','axios-bind']:[])])];
  if(JSON.stringify(x.modules)!==JSON.stringify(expectedModules) ||
     JSON.stringify(x.upstreamHashes)!==JSON.stringify(Object.fromEntries(
       expectedModules.map(m=>[m,pinned.get(m)]))))
    throw new Error('Stateful vendored module provenance mismatch '+id);
  const obs=x.observation,evs=obs?.events;
  if(!Array.isArray(evs)||obs.schema!=='effective-observation/1'||
     x.verified!==obs.evidence?.independentUninstrumentedV8||
     x.completionKind!==obs.completion?.kind||
     !['return','throw'].includes(x.completionKind)||!Array.isArray(obs.sideEffects)||
     !Array.isArray(obs.evidence?.referenceSideEffects))
    throw new Error('Stateful observational evidence mismatch '+id);
  const project=byProject[s.project]??={attempted:0,verified:0,throws:0,events:0};
  const family=byFamily[x.family]??={project:s.project,split:x.split,
    invocations:0,verified:0,throws:0,events:0,heapChanges:0,
    vendorSourceEvents:0,loaderSourceEvents:0,sourceSiteViolations:0};
  projectSplits[s.project]=x.split;
  totals.invocations++;family.invocations++;project.attempted++;
  if(x.verified){totals.nativeVerified++;family.verified++;project.verified++;}
  else{totals.unverified++;failures.push({family:x.family,index:x.scenarioIndex,
    kind:'native-outcome-disagreement'});}
  if(x.completionKind==='throw'){
    totals.throwCompletions++;family.throws++;project.throws++;
  }else totals.returnCompletions++;
  if(JSON.stringify(obs.sideEffects)!==JSON.stringify(obs.evidence.referenceSideEffects)){
    totals.sideEffectMismatches++;
    failures.push({family:x.family,index:x.scenarioIndex,kind:'side-effect-mismatch'});
  }
  const source=obs.source?.text;
  if(typeof source!=='string'||!source.includes('// BEGIN BENCHMARK DRIVER: '+s.id))
    throw new Error('Missing observed benchmark driver provenance '+id);
  const driverStart=source.indexOf('// BEGIN BENCHMARK DRIVER: '+s.id);
  // Source spans refer to the implementation a call executes, not a phase:
  // vendor-site events can be dynamically invoked after driver entry.
  const factories=[...source.matchAll(/__factories\["([^"]+)"\]=function\(module,exports,require\)\{/g)]
    .filter(match=>expectedModules.includes(match[1]))
    .map(match=>({name:match[1],start:match.index}));
  if(factories.length!==expectedModules.length)
    throw new Error('Missing source span for a pinned vendor dependency '+id);
  const firstFactory=factories[0].start;
  let changes=0;
  const bytes=Buffer.byteLength(JSON.stringify(evs),'utf8');
  if(bytes!==x.traceBytes)totals.recordedByteDisagreements++;
  if(evs.length!==x.events)throw new Error('Stateful event-count corruption '+id);
  const perKind={};
  for(const e of evs){
    if(typeof e.kind!=='string')throw new Error('Invalid event kind '+id);
    kinds[e.kind]=(kinds[e.kind]??0)+1;
    perKind[e.kind]=(perKind[e.kind]??0)+1;
    totals.events++;family.events++;project.events++;
    const effects=e.effects??[];
    if(!Array.isArray(effects))throw new Error('Invalid heap effects '+id);
    changes+=effects.length;
    const {start,end}=e.site??{};
    if(e.kind!=='end'&&e.kind!=='effect'&&(!Number.isInteger(start)||
       !Number.isInteger(end)||start<0||end<start||end>source.length)){
      totals.sourceSiteViolations++;family.sourceSiteViolations++;
    }
    if(e.kind!=='end'&&e.kind!=='effect'&&Number.isInteger(start)){
      if(start>=driverStart)totals.driverSourceEvents++;
      else if(start<firstFactory){
        totals.loaderSourceEvents++;family.loaderSourceEvents++;
      }else{
        totals.vendorOrLoaderSourceEvents++;family.vendorSourceEvents++;
        const origin=factories.findLast(x=>x.start<=start)?.name;
        if(origin)byModuleSource[origin]=(byModuleSource[origin]??0)+1;
      }
    }
    if(e.kind==='await')totals.awaitEvents++;
    if(e.kind==='effect')totals.effectEvents++;
    if(e.result?.[0]==='unknown'||e.result?.[0]==='symbol')totals.opaqueEvents++;
  }
  if(changes!==x.changes||
     JSON.stringify(perKind)!==JSON.stringify(x.perKind))
    throw new Error('Stateful event accounting disagreement '+id);
  family.heapChanges+=changes;totals.heapChanges+=changes;
}
if(complete){
  for(const scenario of scenarios)for(let i=0;i<12;i++)
    if(!seen.has(scenario.id+'#'+i))throw new Error('Missing stateful scenario '+scenario.id+'#'+i);
  if(totals.invocations!==912)throw new Error('Incomplete pinned 912-case stateful corpus');
}
if(totals.nativeVerified<minVerified)
  throw new Error('Insufficient independent stateful outcomes: '+totals.nativeVerified+' < '+minVerified);
if(totals.recordedByteDisagreements||totals.sideEffectMismatches||totals.sourceSiteViolations)
  throw new Error('Stateful diagnostic integrity check failed: '+JSON.stringify(totals));
const data={schema:'stateful-quality-audit/1',admitted:false,
  authority:'trusted-V8-final-observable-outcome-only',fullCorpus:complete,
  scenarioFamilies:scenarios.length,upstreamModules:pinned.size,
  totals,projectSplits,kinds,byProject,byFamily,byModuleSource,failures,
  risks:[
    'Vendor source-site events may be dynamically executed library work, not only initialization.',
    'Getter, proxy, Map/Set internals and async ordering lack independent intermediate checks.',
    'Application test scenarios reuse train/validation vendor modules; holdout is not entirely independent.',
    'Native V8 diagnostics are never owned semantic-execution/2 training episodes.'
  ]};
mkdirSync(dirname(output),{recursive:true});mkdirSync(dirname(review),{recursive:true});
writeFileSync(output,JSON.stringify(data,null,2)+'\n');
const lines=['# Stateful full-corpus audit','','**Diagnostic V8 only; no admitted training episodes.**','',
  '- Evaluated: '+totals.invocations+'/912 pinned real-library invocations',
  '- Independently matching final outcomes: '+totals.nativeVerified,
  '- Returns / abrupt completions: '+totals.returnCompletions+' / '+totals.throwCompletions,
  '- Events / heap changes: '+totals.events+' / '+totals.heapChanges,
  '- Vendor-region source sites: '+totals.vendorOrLoaderSourceEvents,
  '- Driver-region source sites: '+totals.driverSourceEvents,
  '- Loader-region source sites: '+totals.loaderSourceEvents,
  '- Source-site violations: '+totals.sourceSiteViolations,
  '- Opaque event results: '+totals.opaqueEvents,'',
  '## Library groups','',
  ...Object.entries(byProject).map(([p,r])=>'- '+p+': '+r.verified+'/'+r.attempted+' final agreements'),
  '','## Source-site grouping','',
  ...Object.entries(byModuleSource).sort((a,b)=>b[1]-a[1]).map(([p,n])=>'- '+p+': '+n),
  '','## Limits','',...data.risks.map(x=>'- '+x),''];
writeFileSync(review,lines.join('\n'));
console.log(JSON.stringify({totals,output,review}));
