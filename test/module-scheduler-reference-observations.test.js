import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {linkEvaluatedModules,executeEvaluatedModules} from '../src/evaluated-modules.js';
import {buildModuleSchedulerPlanV8} from '../src/semantic/module-scheduler-state-v8.js';
import {deriveModuleSchedulerSourceSitesV8} from '../src/semantic/module-scheduler-source-sites-v8.js';
import {
  prepareOriginalModuleSchedulerModules,
  observeOriginalModuleSchedulerV8
} from '../tools/module-scheduler-reference-observations.mjs';

const copy=value=>JSON.parse(JSON.stringify(value));
async function originalEsm(modules,entryModule,plan){
  return observeOriginalModuleSchedulerV8({
    modules,entryModule,moduleSchedulerPlan:plan,entryExportName:'run',callEntry:true
  });
}
function canonical(value){
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
}
// Reference-only adversarial cases include source rejected by the owned
// compiler. This source-hash plan is an observer input, not owned/native admission.
function referenceOnlyPlan(source){
  const body={schema:'semantic-module-scheduler-plan/1',entryModule:'main.mjs',
    modules:[{file:'main.mjs',index:0,
      sourceDigest:createHash('sha256').update(source).digest('hex'),
      dependencies:[],hasTLA:false}]};
  return {...body,digest:createHash('sha256').update(canonical(body)).digest('hex')};
}
function reindexPlan(plan){
  const output=copy(plan);
  output.modules.sort((a,b)=>b.file.localeCompare(a.file));
  output.modules.forEach((row,index)=>{row.index=index;});
  const body={schema:output.schema,entryModule:output.entryModule,modules:output.modules};
  output.digest=createHash('sha256').update(canonical(body)).digest('hex');
  return output;
}
function scheduledModules(mainSource,extra={}){
  // A TLA dependency followed by an independent sibling requires the real
  // dependency scheduler. A simple TLA chain uses the concatenation strategy.
  return {
    'gate.mjs':'await 0;',
    'sibling.mjs':'export const marker=1;',
    ...extra,
    'main.mjs':"import './gate.mjs';import './sibling.mjs';"+mainSource
  };
}
function planFor(modules,entryModule,exportName='run'){
  const metadata=linkEvaluatedModules({modules,entryModule,exportName}).metadata;
  assert.equal(metadata.evaluationStrategy,'async-dependency-scheduler',
    'fixture must exercise the actual dependency scheduler');
  return buildModuleSchedulerPlanV8(metadata);
}

test('scheduler source sites bind generated helper bodies and module records to the relinked plan',()=>{
  const modules={
    'leaf.mjs':'await 0;export const value=1;',
    'sibling.mjs':'export const sibling=2;',
    'main.mjs':"import {value} from './leaf.mjs';import './sibling.mjs';export function run(){return value;}"
  };
  const linked=linkEvaluatedModules({modules,entryModule:'main.mjs',exportName:'run'});
  const plan=buildModuleSchedulerPlanV8(linked.metadata);
  const sites=deriveModuleSchedulerSourceSitesV8({source:linked.source,moduleSchedulerPlan:plan});
  assert.equal(sites.schema,'semantic-module-scheduler-source-sites/1');
  assert.equal(sites.records.length,3);
  assert.equal(sites.completionAwaitSites.length,1);
  assert(sites.calls.some(row=>row.helper==='__traced_eval_async'));
  assert(sites.calls.some(row=>row.helper==='__traced_eval_failed'));
  assert(sites.awaitSites.some(row=>row.owner==='__traced_eval_async'));
  assert.equal(sites.planDigest,plan.digest);
});

test('original ESM observer binds sibling TLA lifecycle to source files without fixing sibling order',async()=>{
  const modules={
    'state.mjs':"export let starts=0;export function started(){starts++;}",
    'left.mjs':"import {started} from './state.mjs';started();await Promise.resolve();export const value='L';",
    'right.mjs':"import {started} from './state.mjs';started();await 0;export const value='R';",
    'main.mjs':"import {starts} from './state.mjs';import {value as left} from './left.mjs';import {value as right} from './right.mjs';export function run(){return [starts,left,right];}"
  };
  const plan=planFor(modules,'main.mjs'),reference=await originalEsm(modules,'main.mjs',plan);
  const owned=await executeEvaluatedModules({modules,entryModule:'main.mjs',exportName:'run'});
  assert.deepEqual(owned.result,structuredClone(reference.outcome.value));
  const starts=reference.observations.rows.filter(row=>row.kind==='module.start'&&
    (row.moduleFile==='left.mjs'||row.moduleFile==='right.mjs'));
  const resumes=reference.observations.rows.filter(row=>row.kind==='module.resume'&&
    (row.moduleFile==='left.mjs'||row.moduleFile==='right.mjs'));
  assert.equal(starts.length,2);
  assert.equal(resumes.length,2);
  const firstResume=reference.observations.rows.findIndex(row=>row.kind==='module.resume');
  assert(starts.every(row=>reference.observations.rows.findIndex(value=>value===row)<firstResume));
  assert.equal(reference.observations.rows.filter(row=>row.kind==='module.complete'&&row.moduleFile==='state.mjs').length,1);
});

test('original ESM observer records rejection and lets the already-started sibling settle',async()=>{
  const modules={
    'state.mjs':'export const trace=[];',
    'bad.mjs':"import {trace} from './state.mjs';trace.push('bad:start');await Promise.resolve();throw 'bad';",
    'sibling.mjs':"import {trace} from './state.mjs';trace.push('sibling:start');await 0;trace.push('sibling:end');",
    'main.mjs':"import './bad.mjs';import './sibling.mjs';export function run(){return 1;}"
  };
  const plan=planFor(modules,'main.mjs'),reference=await originalEsm(modules,'main.mjs',plan);
  assert.equal(reference.outcome.status,'rejected');
  assert(reference.observations.rows.some(row=>row.kind==='module.reject'&&row.moduleFile==='bad.mjs'));
  assert(reference.observations.rows.some(row=>row.kind==='module.complete'&&row.moduleFile==='sibling.mjs'));
  assert.equal(reference.observations.rows.filter(row=>row.kind==='module.start'&&row.moduleFile==='sibling.mjs').length,1);
});


test('original ESM observer accepts linker index order independently of file-name order',()=>{
  const modules=scheduledModules(
    "import {value} from './state.mjs';export function run(){return value;}",
    {'state.mjs':'export let value=1;'}
  );
  const plan=reindexPlan(planFor(modules,'main.mjs'));
  assert.notDeepEqual(plan.modules.map(row=>row.file),plan.modules.map(row=>row.file).slice().sort());
  const prepared=prepareOriginalModuleSchedulerModules({
    modules,entryModule:'main.mjs',moduleSchedulerPlan:plan,
    observerSpecifier:'./observer.mjs',observerLocal:'__moduleSchedulerObserver'
  });
  assert.equal(Object.keys(prepared.modules).length,Object.keys(modules).length);
  assert(prepared.modules['main.mjs'].indexOf("import {value}") <
    prepared.modules['main.mjs'].indexOf("import __moduleSchedulerObserver"));
});

test('original ESM observer refuses nested uncaught rejection sites it cannot own',()=>{
  const modules=scheduledModules('if (true) throw new Error("x"); export function run(){return 1;}');
  const plan=planFor(modules,'main.mjs');
  assert.throws(()=>prepareOriginalModuleSchedulerModules({
    modules,entryModule:'main.mjs',moduleSchedulerPlan:plan,
    observerSpecifier:'./observer.mjs',observerLocal:'__moduleSchedulerObserver'
  }),/nested uncaught throws/);
});

test('original ESM observer refuses a colliding observer module specifier',()=>{
  const modules=scheduledModules(
    "import './observer.mjs';import {value} from './state.mjs';export function run(){return value;}",
    {'state.mjs':'export const value=1;','observer.mjs':'export default {};'}
  );
  const plan=planFor(modules,'main.mjs');
  assert.throws(()=>prepareOriginalModuleSchedulerModules({
    modules,entryModule:'main.mjs',moduleSchedulerPlan:plan,
    observerSpecifier:'./observer.mjs',observerLocal:'__moduleSchedulerObserver'
  }),/specifier collides/);
});


test('reference-only ESM observer refuses lexical inspection and exposes no global sink',async()=>{
  for(const source of [
    'eval("typeof __moduleSchedulerObserver"); export function run(){return 1;}',
    'export function run(){return import.meta.url;}'
  ]){
    const modules={'main.mjs':source},plan=referenceOnlyPlan(source);
    assert.throws(()=>prepareOriginalModuleSchedulerModules({
      modules,entryModule:'main.mjs',moduleSchedulerPlan:plan,
      observerSpecifier:'./observer.mjs',observerLocal:'__moduleSchedulerObserver'
    }),/observer profile/);
  }
  const source=
    'export function run(){return [globalThis.__moduleSchedulerRows,(()=>{}).constructor("return this")().__moduleSchedulerRows];}';
  const result=await originalEsm({'main.mjs':source},'main.mjs',referenceOnlyPlan(source));
  assert.equal(result.outcome.status,'fulfilled');
  assert.deepEqual(structuredClone(result.outcome.value),[undefined,undefined]);
});

test('source start marker precedes a first-statement rejection',async()=>{
  const modules=scheduledModules('throw "early"; export function run(){return 1;}');
  const result=await originalEsm(modules,'main.mjs',planFor(modules,'main.mjs'));
  assert.equal(result.outcome.status,'rejected');
  assert.deepEqual(result.observations.rows.filter(row=>row.moduleFile==='main.mjs').map(row=>row.kind),
    ['module.start','module.reject']);
});
