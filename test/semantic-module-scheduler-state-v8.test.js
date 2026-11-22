import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  buildModuleSchedulerPlanV8,
  createModuleSchedulerStateV8,
  applyModuleSchedulerActionV8
} from '../src/semantic/module-scheduler-state-v8.js';
import {linkEvaluatedModules,executeEvaluatedModules} from '../src/evaluated-modules.js';

const graph={
  'shared.js': "export let starts=0; export const trace=[]; trace.push('shared:start'); export function started(name){starts++;trace.push(name);}",
  'left.js': "import {started,trace} from './shared.js'; started('left:start'); await Promise.resolve(); trace.push('left:end'); export const value='L';",
  'right.js': "import {started,trace} from './shared.js'; started('right:start'); await Promise.resolve(); trace.push('right:end'); export const value='R';",
  'main.js': "import {starts,trace} from './shared.js'; import {value as left} from './left.js'; import {value as right} from './right.js'; export function run(){return [starts,left,right,trace.slice()];}"
};

async function reference(modules, entry) {
  const context=vm.createContext({});
  const table=new Map(Object.entries(modules).map(([file,source])=>
    [file,new vm.SourceTextModule(source,{context,identifier:file})]));
  const root=table.get(entry);
  await root.link((specifier,referencing)=>table.get(new URL(specifier,'file:///'+referencing.identifier).pathname.slice(1)));
  await root.evaluate();
  return root.namespace;
}
const fact=(frameId,moduleFile,promiseId,status='pending',extra={})=>({
  frames:{[frameId]:{id:frameId,moduleFile,executionPromiseId:promiseId}},
  promises:{[promiseId]:{id:promiseId,status,...extra}},
  jobs:{}
});
const awaitFacts=(file,frameId,executionPromiseId,promiseId,status='pending',jobId=null)=>({frames:{[frameId]:{id:frameId,moduleFile:file,executionPromiseId,awaitedPromiseId:promiseId}},promises:{[promiseId]:{id:promiseId,status,...(status==='pending'?{}:{value:null})}},jobs:jobId?{[jobId]:{id:jobId,promiseId,frameId,status,kind:'promise-reaction',moduleFile:file,value:null}}:{}});
function complete(plan,state,file,n) {
  const frameId='frame-'+n, promiseId='exec-'+n, jobId='job-'+n;
  const startFacts=fact(frameId,file,promiseId);
  state=applyModuleSchedulerActionV8(plan,state,{type:'module.start',file,frameId,executionPromiseId:promiseId},startFacts);
  const facts={frames:startFacts.frames,promises:{[promiseId]:{id:promiseId,status:'fulfilled',value:null}},
    jobs:{[jobId]:{id:jobId,promiseId,frameId,status:'fulfilled',kind:'module-execution-settle',moduleFile:file,value:null}}};
  return applyModuleSchedulerActionV8(plan,state,{type:'module.complete',file,frameId,promiseId,jobId},facts);
}

test('scheduler DAG plan comes from linker and ESM observation; shared dependency is evaluated once',async()=>{
  const linked=linkEvaluatedModules({modules:graph,entryModule:'main.js',exportName:'run'});
  const plan=buildModuleSchedulerPlanV8(linked.metadata);
  assert.equal(plan.modules.find(row=>row.file==='shared.js').dependencies.length,0);
  assert.equal(plan.modules.find(row=>row.file==='left.js').dependencies.includes('shared.js'),true);
  assert.equal(plan.modules.find(row=>row.file==='right.js').dependencies.includes('shared.js'),true);

  const ns=await reference(graph,'main.js');
  const original=ns.run();
  const owned=await executeEvaluatedModules({modules:graph,entryModule:'main.js',exportName:'run'});
  assert.deepEqual(owned.result,JSON.parse(JSON.stringify(original)));
  assert.equal(original[0],2);
  assert.equal(original[3].filter(item=>item==='shared:start').length,1);
  const starts=original[3].filter(item=>item==='left:start'||item==='right:start');
  assert.equal(starts.length,2);
  const firstEnd=original[3].findIndex(item=>item==='left:end'||item==='right:end');
  assert(starts.every(item=>original[3].indexOf(item)<firstEnd));

  let state=createModuleSchedulerStateV8(plan);
  state=complete(plan,state,'shared.js',0);
  assert.equal(state.nextStartOrder,1);
  assert.equal(state.modules['shared.js'].status,'fulfilled');
  assert.equal(state.modules['left.js'].status,'waiting');
});

test('TLA resumes bind to existing Promise and reaction job identities; sibling order is accepted dynamically',()=>{
  const plan=buildModuleSchedulerPlanV8(linkEvaluatedModules({
    modules:graph,entryModule:'main.js',exportName:'run'
  }).metadata);
  let state=createModuleSchedulerStateV8(plan);
  state=complete(plan,state,'shared.js',0);

  for (const [file,n] of [['right.js',1],['left.js',2]]) {
    const frameId='frame-'+n, executionPromiseId='exec-'+n, awaitedId='await-'+n;
    state=applyModuleSchedulerActionV8(plan,state,{type:'module.start',file,frameId,executionPromiseId},
      fact(frameId,file,executionPromiseId));
    state=applyModuleSchedulerActionV8(plan,state,{type:'module.await',file,frameId,promiseId:awaitedId},
      awaitFacts(file,frameId,executionPromiseId,awaitedId));
    const jobId='reaction-'+n;
    const facts=awaitFacts(file,frameId,executionPromiseId,awaitedId,'fulfilled',jobId);
    const wrongJob=structuredClone(facts);
    wrongJob.jobs[jobId].promiseId='wrong';
    assert.throws(()=>applyModuleSchedulerActionV8(plan,state,
      {type:'module.resume',file,frameId,promiseId:awaitedId,jobId},wrongJob),/existing promise job/);
    assert.equal(state.modules[file].status,'suspended');
    state=applyModuleSchedulerActionV8(plan,state,
      {type:'module.resume',file,frameId,promiseId:awaitedId,jobId},facts);
    const doneJob='done-'+n;
    state=applyModuleSchedulerActionV8(plan,state,
      {type:'module.complete',file,frameId,promiseId:executionPromiseId,jobId:doneJob},
      {promises:{[executionPromiseId]:{id:executionPromiseId,status:'fulfilled',value:null}},
        jobs:{[doneJob]:{id:doneJob,promiseId:executionPromiseId,frameId,status:'fulfilled',kind:'module-execution-settle',moduleFile:file,value:null}}});
  }
  assert.deepEqual(new Set([state.modules['left.js'].startOrder,state.modules['right.js'].startOrder]),new Set([1,2]));
  assert.equal(state.modules['left.js'].status,'fulfilled');
  assert.equal(state.modules['right.js'].status,'fulfilled');
});

test('rejection propagates through a dependency while an independent sibling settles',()=>{
  const modules={
    'bad.js':"await Promise.resolve(); throw 'rejected'; export const bad=1;",
    'sibling.js':"await Promise.resolve(); export const ok=1;",
    'main.js':"import './bad.js'; import './sibling.js'; export function run(){return 1;}"
  };
  const plan=buildModuleSchedulerPlanV8(linkEvaluatedModules({
    modules,entryModule:'main.js',exportName:'run'
  }).metadata);
  let state=createModuleSchedulerStateV8(plan);
  const badFrame='bad-frame', badExec='bad-exec', badAwait='bad-await';
  state=applyModuleSchedulerActionV8(plan,state,
    {type:'module.start',file:'bad.js',frameId:badFrame,executionPromiseId:badExec},
    fact(badFrame,'bad.js',badExec));
  state=applyModuleSchedulerActionV8(plan,state,
    {type:'module.await',file:'bad.js',frameId:badFrame,promiseId:badAwait},
    awaitFacts('bad.js',badFrame,badExec,badAwait));

  const siblingFrame='sibling-frame', siblingExec='sibling-exec', siblingAwait='sibling-await';
  state=applyModuleSchedulerActionV8(plan,state,
    {type:'module.start',file:'sibling.js',frameId:siblingFrame,executionPromiseId:siblingExec},
    fact(siblingFrame,'sibling.js',siblingExec));
  state=applyModuleSchedulerActionV8(plan,state,
    {type:'module.await',file:'sibling.js',frameId:siblingFrame,promiseId:siblingAwait},
    awaitFacts('sibling.js',siblingFrame,siblingExec,siblingAwait));

  const rejectionJob='bad-reject-job';
  const mismatched=awaitFacts('bad.js',badFrame,badExec,badAwait,'rejected',rejectionJob);
  mismatched.jobs[rejectionJob].value='wrong-reason';
  assert.throws(()=>applyModuleSchedulerActionV8(plan,state,
    {type:'module.resume',file:'bad.js',frameId:badFrame,promiseId:badAwait,jobId:rejectionJob},
    mismatched),/outcome mismatch/);
  assert.equal(state.modules['bad.js'].status,'suspended');
  state=applyModuleSchedulerActionV8(plan,state,
    {type:'module.resume',file:'bad.js',frameId:badFrame,promiseId:badAwait,jobId:rejectionJob},
    awaitFacts('bad.js',badFrame,badExec,badAwait,'rejected',rejectionJob));
  const badSettle='bad-settle-job';
  state=applyModuleSchedulerActionV8(plan,state,
    {type:'module.reject',file:'bad.js',frameId:badFrame,promiseId:badExec,jobId:badSettle},
    {promises:{[badExec]:{id:badExec,status:'rejected',value:null}},
      jobs:{[badSettle]:{id:badSettle,promiseId:badExec,frameId:badFrame,status:'rejected',kind:'module-evaluation-failure',moduleFile:'bad.js',value:null}}});
  assert.equal(state.modules['main.js'].status,'waiting');

  state=applyModuleSchedulerActionV8(plan,state,
    {type:'module.propagateFailure',file:'main.js',dependencyFile:'bad.js',
      promiseId:badExec,jobId:badSettle},
    {promises:{[badExec]:{id:badExec,status:'rejected',value:null}},
      jobs:{[badSettle]:{id:badSettle,promiseId:badExec,status:'rejected',
        kind:'module-evaluation-failure',moduleFile:'bad.js',frameId:badFrame,value:null}}});
  assert.equal(state.modules['main.js'].status,'rejected');
  assert.equal(state.modules['sibling.js'].status,'suspended');

  const siblingJob='sibling-reaction';
  state=applyModuleSchedulerActionV8(plan,state,
    {type:'module.resume',file:'sibling.js',frameId:siblingFrame,
      promiseId:siblingAwait,jobId:siblingJob},
    awaitFacts('sibling.js',siblingFrame,siblingExec,siblingAwait,'fulfilled',siblingJob));
  const siblingDone='sibling-complete';
  state=applyModuleSchedulerActionV8(plan,state,
    {type:'module.complete',file:'sibling.js',frameId:siblingFrame,
      promiseId:siblingExec,jobId:siblingDone},
    {promises:{[siblingExec]:{id:siblingExec,status:'fulfilled',value:null}},
      jobs:{[siblingDone]:{id:siblingDone,promiseId:siblingExec,
        frameId:siblingFrame,status:'fulfilled',kind:'module-execution-settle',moduleFile:'sibling.js',value:null}}});
  assert.equal(state.modules['sibling.js'].status,'fulfilled');
  assert.equal(state.modules['main.js'].status,'rejected');
});
test('original ESM settles an independent sibling after a dependency rejects',async()=>{
  const source={
    'bad.js':"import {trace} from './shared.js'; trace.push('bad:start'); await Promise.resolve(); trace.push('bad:reject'); throw 'bad'; export const x=1;",
    'sibling.js':"import {trace} from './shared.js'; trace.push('sibling:start'); await Promise.resolve(); trace.push('sibling:settle'); export const x=1;",
    'shared.js':"export const trace=[];",
    'main.js':"import './bad.js'; import './sibling.js';"
  };
  const context=vm.createContext({});
  const table=new Map(Object.entries(source).map(([file,text])=>
    [file,new vm.SourceTextModule(text,{context,identifier:file})]));
  const root=table.get('main.js');
  await root.link((specifier,referencing)=>table.get(
    new URL(specifier,'file:///'+referencing.identifier).pathname.slice(1)));
  await assert.rejects(root.evaluate());
  await Promise.resolve();
  await Promise.resolve();
  const trace=table.get('shared.js').namespace.trace;
  assert.equal(trace.filter(item=>item==='bad:start').length,1);
  assert.equal(trace.filter(item=>item==='sibling:start').length,1);
  assert.equal(trace.includes('bad:reject'),true);
  assert.equal(trace.includes('sibling:settle'),true);
});

test('scheduler refuses early and duplicate completion without mutating prior state',()=>{
  const plan=buildModuleSchedulerPlanV8(linkEvaluatedModules({
    modules:graph,entryModule:'main.js',exportName:'run'
  }).metadata);
  const initial=createModuleSchedulerStateV8(plan);
  const frameId='shared-frame', promiseId='shared-exec', jobId='shared-job';
  const pending=fact(frameId,'shared.js',promiseId);
  assert.throws(()=>applyModuleSchedulerActionV8(plan,initial,
    {type:'module.complete',file:'shared.js',frameId,promiseId,jobId},pending),/module settlement/);
  assert.equal(initial.modules['shared.js'].status,'waiting');
  const malformed=structuredClone(initial);
  malformed.nextStartOrder=1;
  Object.assign(malformed.modules['left.js'],{status:'running',startOrder:0,
    frameId:'forged-frame',executionPromiseId:'forged-exec'});
  assert.throws(()=>applyModuleSchedulerActionV8(plan,malformed,
    {type:'module.start',file:'shared.js',frameId,promiseId,executionPromiseId:promiseId},pending),/module state/);
  assert.equal(initial.modules['left.js'].status,'waiting');
  const completed=complete(plan,initial,'shared.js',0);
  const terminal=structuredClone(completed);
  terminal.modules['shared.js'].awaited={promiseId:'forged-await'};
  assert.throws(()=>applyModuleSchedulerActionV8(plan,terminal,
    {type:'module.start',file:'left.js',frameId,promiseId,executionPromiseId:promiseId},pending),/module state/);
  assert.throws(()=>applyModuleSchedulerActionV8(plan,completed,
    {type:'module.start',file:'shared.js',frameId,promiseId},pending),/module start/);
  assert.equal(completed.modules['shared.js'].status,'fulfilled');
  assert.throws(()=>applyModuleSchedulerActionV8(plan,completed,
    {type:'module.complete',file:'shared.js',frameId,promiseId,jobId},
    {promises:{[promiseId]:{id:promiseId,status:'fulfilled'}},
      jobs:{[jobId]:{id:jobId,promiseId,frameId,status:'fulfilled'}}}),/module settlement/);
});
