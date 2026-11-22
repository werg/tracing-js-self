import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createRuntime} from '../src/runtime.js';
import {linkEvaluatedModules} from '../src/evaluated-modules.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {deriveModuleSchedulerSourceCutsV8} from '../src/semantic/module-scheduler-source-v8.js';
import {buildBoundModuleSchedulerPlanFromLinkerV8,verifyBoundModuleSchedulerPlanV8} from '../src/semantic/module-scheduler-plan-v8.js';
import {validateBoundModuleSchedulerStateV8} from '../src/semantic/protocol-module-scheduler-v8.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {independentModuleRegionReference,verifyRegionModuleTrainingCase} from '../src/semantic/module-v8.js';
import {compareObservableGraphs} from '../src/semantic/observables.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState,defineRegionProgram} from '../src/semantic/regions.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

const cases=[
  {name:'caught rejection and sibling FIFO',modules:{
    'left.js':'export let x=0;try {await Promise.reject(7);} catch(e){x=e;}',
    'right.js':'await 0;export const x=2;',
    'main.js':"import {x} from './left.js';import {x as y} from './right.js';export function run(){return x+y;}"}},
  {name:'execution rejection propagates to its waiting parent',modules:{
    'left.js':'await 0;throw 7;export const x=1;',
    'right.js':'await 0;export const x=2;',
    'main.js':"import {x} from './left.js';import {x as y} from './right.js';export function run(){return x+y;}"}},
  {name:'syntactic TLA with no executed await',modules:{
    'left.js':'if(false)await 0;export const x=4;',
    'right.js':'await 0;export const y=2;',
    'main.js':"import {x} from './left.js';import {y} from './right.js';export function run(){return x+y;}"}},
  {name:'diamond owns one shared dependency execution',modules:{
    's.js':'export let n=1;',
    'a.js':"import './s.js';await 0;",
    'b.js':"import './s.js';await 0;",
    'main.js':"import './a.js';import './b.js';import {n} from './s.js';export function run(){return n;}"}}
].map(row=>({...row,request:{modules:row.modules,entryModule:'main.js',exportName:'run'}}));
const artifacts=[],invalidStates=[],invalidPlans=[];
let nativeEvidence=null;
const copy=structuredClone;
const ledger=controller=>[...controller.heap.values()].find(node=>node.kind==='module-scheduler');
const fieldRecord=row=>JSON.parse(row.fields.line.slice(row.fields.line.indexOf(' ')+1));
const prefix=(example,count)=>RegionExecutionHarness.replay({...example.artifact.public,
  timeline:example.artifact.public.timeline.slice(0,count)},{requireTerminal:false});
function rehash(plan){plan.modulePlan.digest=hashAlgorithmData(Object.fromEntries(Object.entries(plan.modulePlan).filter(([key])=>key!=='digest')));
  plan.digest=hashAlgorithmData(Object.fromEntries(Object.entries(plan).filter(([key])=>key!=='digest')));return plan;}
function normalizedModuleState(state,frames=new Map()){
  return Object.fromEntries(Object.entries(state.modules).map(([file,row])=>[file,{status:row.status,
    pendingDependencies:row.pendingDependencies,startOrder:row.startOrder,frameId:frames.get(row.frameId)??row.frameId,
    executionPromiseId:row.executionPromiseId,awaited:row.awaited,completedDependencies:row.completedDependencies,
    failure:row.failure&&{moduleFile:row.failure.moduleFile,promiseId:row.failure.promiseId}}]));
}
function atomicRefusal(h,record,pattern){const before=copy(h.checkpoint());
  assert.throws(()=>h.select('invocation1',record),pattern);assert.deepEqual(h.checkpoint(),before);}

for(const scenario of cases)test('bound module original source: '+scenario.name,async()=>{
  const request=scenario.request,linked=linkEvaluatedModules(request),plan=buildBoundModuleSchedulerPlanFromLinkerV8(linked),
    runtime=createRuntime().startEntry({text:linked.source,functionName:linked.entryFunction,args:[linked.entryInput],allowAsync:true});
  assert.equal(runtime.drive().kind,'terminated');
  const bundle=JSON.parse(JSON.stringify(runtime.exportRun())),ownership=deriveModuleSchedulerSourceCutsV8({request,bundle}),
    projection=compileProtocolSourceV8(bundle),reference=await independentModuleRegionReference({...request,calls:null,
      inputGraph:encodeNativeGraph([linked.entryInput])});
  assert.equal(reference.status,'passed');assert.equal(reference.outcome.kind,projection.outcome.kind);
  assert(compareObservableGraphs(reference.outcome.graph,projection.outcome.graph,{leftInputIds:['o0'],rightInputIds:['o0']}).equal);
  const h=new RegionExecutionHarness({sessionId:'bound-module-source',automaticDelivery:false,now:()=>-Infinity});
  h.publishProgram({programId:'program1',source:projection.source,entry:projection.entry,moduleSchedulerPlan:plan,capabilities:[]});
  h.admitInvocation({programId:'program1',invocationId:'invocation1',trackId:'worker1',realmId:'realm1',triggerId:'module-entry',
    inputGraph:projection.inputGraph,realmPolicy:'fresh',completionPolicy:projection.completionPolicy});
  const contexts=[h.modelContext('invocation1')],cuts=[],frames=new Map(),owned=new Set();
  h.select('invocation1',{kind:'module.scheduler.initialize',object:'module-ledger',planDigest:plan.digest});
  for(const cut of ownership.cuts){
    const event=cut.certificate.eventId;
    assert(!owned.has(event),'a lifecycle event cannot have two owners');owned.add(event);
    const indices=projection.claims.flatMap((claim,index)=>claim.certificate.journalEvents.includes(event)?[index]:[]);
    assert(indices.length&&indices.every((index,position)=>index===indices[0]+position),'one exact owned public transaction required');
    if(cut.action.type==='module.start'){
      const entered=indices.map(index=>projection.claims[index].record).filter(record=>['call','async.call'].includes(record.kind));
      assert.equal(entered.length,1);frames.set(cut.action.frameId,entered[0].child);
    }
    cuts.push({...cut,publicClaimIndices:indices});
  }
  for(const [index,claim]of projection.claims.entries()){
    contexts.push(h.modelContext('invocation1'));h.select('invocation1',claim.line);
    for(const cut of cuts.filter(row=>row.publicClaimIndices.at(-1)===index)){
      cut.publicSequence=h.timeline.at(-1).sequence;
      assert.deepEqual(normalizedModuleState(ledger(h.controller).state),normalizedModuleState(cut.after,frames));
    }
  }
  assert.deepEqual({kind:h.controller.completion.kind,graph:h.controller.observedGraph()},projection.outcome);
  assert.equal(ledger(h.controller).sequence,cuts.length);
  const artifact={public:h.exportEpisode(),contexts,sidecar:{schema:'bound-module-engineering-evidence/1'}},state=sharedRegionState(h.controller),
    example={name:scenario.name,request,plan,artifact,state,cuts,reference,sourceEvents:bundle.events.length};
  assert.deepEqual(sharedRegionState(RegionExecutionHarness.replay(artifact).controller),state);
  const selected=cuts.find(cut=>cut.action.type==='module.await')??cuts[0],checkpoint=prefix(example,selected.publicSequence),
    restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(checkpoint.checkpoint())));
  assert.deepEqual(restored.modelContext('invocation1'),checkpoint.modelContext('invocation1'));
  for(const row of artifact.public.timeline.slice(selected.publicSequence))restored.select('invocation1',row.fields.line);
  assert.deepEqual(sharedRegionState(restored.controller),state);
  artifacts.push(example);
});

test('a bound module plan rejects changed source, entry, graph and completion callback positions',()=>{
  const example=artifacts[0],source=example.artifact.public.timeline[0].fields.source,entry=example.plan.entry;
  const mutations=[p=>{p.sourceDigest='0'.repeat(64);},p=>{p.entry='invented';},
    p=>{p.functions.fulfilled=p.functions.rejected;},p=>{p.functions.fulfilled='function:0';},
    p=>{p.modulePlan.modules[0].hasTLA=false;},p=>{p.modulePlan.modules[2].dependencies=[];}];
  for(const mutate of mutations){const plan=copy(example.plan);mutate(plan);rehash(plan);
    assert.throws(()=>verifyBoundModuleSchedulerPlanV8(plan,{source,entry}),/module|source|plan|function|completion|TLA/i);
    invalidPlans.push({plan,source,entry});
  }
  assert.throws(()=>defineRegionProgram({source:source+'\n',entry,moduleSchedulerPlan:example.plan}),/source program/);
});

test('initialization, compact routes and early completion refuse atomically',()=>{
  const example=artifacts[0],first=prefix(example,2),initialize=fieldRecord(example.artifact.public.timeline[2]);
  atomicRefusal(first,example.artifact.public.timeline[3].fields.line,/initialize/);
  atomicRefusal(first,{...initialize,planDigest:'0'.repeat(64)},/active source-bound plan/);
  first.select('invocation1',initialize);
  atomicRefusal(first,initialize,/fresh entry|duplicate|initialize/);
  atomicRefusal(first,fieldRecord(example.artifact.public.timeline.at(-1)),/unfinished/);
  atomicRefusal(first,'region {}',/explicit source records/);
  atomicRefusal(first,'algorithm {}',/explicit source records/);
  atomicRefusal(first,{kind:'bind',name:'escape',value:['ref','module-ledger']},/cannot escape/);
  atomicRefusal(first,{kind:'property.hasOwn',object:'module-ledger',key:['str','x'],result:['bool',false]},/cannot be targeted/);
});

test('retained module records, frames and settlement reactions keep exact authority',()=>{
  const example=artifacts[0],base=RegionExecutionHarness.replay(example.artifact).controller;
  const mutations=[
    ['active plan',c=>{delete c.moduleSchedulerPlan;}],
    ['owner',c=>{ledger(c).owner='foreign';}],
    ['record identity',c=>{ledger(c).records[0].object=ledger(c).records[1].object;}],
    ['source dependency',c=>{const owner=ledger(c).records.find(row=>row.file==='main.js'),ref=c.heap.get(owner.object).properties.get('dependencies');c.heap.get(ref[1]).properties.set('0',['num',1]);}],
    ['driver frame',c=>{c.frameFunctions.set(ledger(c).records[0].frame,'invented');}],
    ['execution Promise',c=>{ledger(c).records[0].execution=ledger(c).records[1].execution;}],
    ['completion authority',c=>{ledger(c).settlements.shift();}],
    ['reaction owner',c=>{c.jobs.get(ledger(c).settlements[0].job).owner='foreign';}],
    ['reaction value',c=>{c.jobs.get(ledger(c).settlements[0].job).originalResult=['num',99];}],
    ['reaction source',c=>{const job=c.jobs.get(ledger(c).settlements[0].job);job.closure=c.jobs.get(ledger(c).settlements[1].job).closure;}]
  ];
  for(const [name,mutate]of mutations){const c=Object.assign(Object.create(Object.getPrototypeOf(base)),copy(base));mutate(c);
    assert.throws(()=>validateBoundModuleSchedulerStateV8(c),TypeError,name);
    invalidStates.push({name,state:sharedRegionState(c),plan:c.moduleSchedulerPlan??null});
  }
});

test('cycles and namespace composition remain refused by the bound plan',()=>{
  const cycles=linkEvaluatedModules({modules:{'a.js':"import './b.js';await 0;export function run(){return 1;}",
    'b.js':"import './a.js';await 0;"},entryModule:'a.js',exportName:'run'});
  assert.throws(()=>buildBoundModuleSchedulerPlanFromLinkerV8(cycles),/cyclic/);
  const example=artifacts[0];assert.throws(()=>defineRegionProgram({source:example.artifact.public.timeline[0].fields.source,
    entry:example.plan.entry,moduleSchedulerPlan:example.plan,moduleNamespacePlan:{}}),/composition/);
});

test('larger module source publication retains the existing record byte budget',()=>{
  const linked=linkEvaluatedModules({entryModule:'main.js',exportName:'run',modules:{
    'shared.js':'export const n=1;',
    'left.js':"import {n} from './shared.js';await 0;export const x=n+1;",
    'right.js':"import {n} from './shared.js';await 0;export const y=n+2;",
    'main.js':"import {x} from './left.js';import {y} from './right.js';export function run(){return x+y;}"}});
  assert.throws(()=>new RegionExecutionHarness().publishProgram({programId:'program1',source:linked.source,
    entry:linked.entryFunction,capabilities:[]}),/record byte budget/);
});

test('engineering evidence does not bypass production module admission',async()=>{
  for(const scenario of cases){const result=await verifyRegionModuleTrainingCase(scenario.request);
    assert.equal(result.category,'unsupported.module-scheduler-projection');assert(!result.exported);}
});

test('independent native replay checks every context, all module cuts and forged ledger controls',
  {skip:!process.env.MEGATOKEN_ROOT},()=>{
  assert.equal(artifacts.length,cases.length);
  const python=`
import json,sys
from megatoken.data.native_v8 import validate_v8_artifact,_replay_shared_state,_native_checkpoint,_restore_native_checkpoint
from megatoken.data.module_scheduler_machine_v8 import validate_shared_state,verify_bound_module_scheduler_plan
data=json.load(sys.stdin);out=[]
for index,case in enumerate(data['cases']):
    artifact=case['artifact'];timeline=artifact['public']['timeline'];contexts=artifact['contexts']
    state=_replay_shared_state(timeline,contexts,{},roundtrip=False,boundary_invocation='invocation1')['state']
    assert state==case['state']
    for cut in case['cuts']:
        context=next(c for c in contexts if c['visibleThrough']==cut['publicSequence'])
        prefix=timeline[:context['visibleThrough']]
        restored=_restore_native_checkpoint(_native_checkpoint(prefix,context),expected_prefix=prefix,
            expected_state=context['state'],expected_cursor=context['regionCursor'],expected_obligations=context['obligations'])
        assert restored==context['state'];validate_shared_state(restored,case['plan'])
    receipt=validate_v8_artifact(artifact) if index==0 else None
    if receipt:
        assert receipt['admitted'] is False
        assert all(receipt['checks'][key]=='passed' for key in ['replay','contexts','continuation'])
    out.append({'name':case['name'],'contexts':len(contexts),'moduleCuts':len(case['cuts']),'finalSharedStateEqual':True,'receipt':receipt})
for case in data['invalidStates']:
    try:validate_shared_state(case['state'],case['plan'])
    except (ValueError,KeyError,TypeError):pass
    else:raise AssertionError('accepted forged state: '+case['name'])
for case in data['invalidPlans']:
    try:verify_bound_module_scheduler_plan(**case)
    except (ValueError,KeyError,TypeError):pass
    else:raise AssertionError('accepted forged source plan')
print(json.dumps({'cases':out,'refusedStates':len(data['invalidStates']),'refusedPlans':len(data['invalidPlans'])}))
`;
  const root=resolve(process.env.MEGATOKEN_ROOT),result=spawnSync(process.env.MEGATOKEN_PYTHON||'python',['-c',python],{
    cwd:root,env:{...process.env,PYTHONPATH:join(root,'src')},input:JSON.stringify({cases:artifacts,invalidStates,invalidPlans}),
    encoding:'utf8',timeout:1200000,maxBuffer:4*1024*1024});
  assert.equal(result.status,0,result.stderr||String(result.error));nativeEvidence=JSON.parse(result.stdout);
  assert.equal(nativeEvidence.cases.length,cases.length);assert.equal(nativeEvidence.refusedStates,10);assert.equal(nativeEvidence.refusedPlans,6);
});

after(()=>{
  const summary={schema:'bound-module-source-engineering/1',cases:artifacts.length,
    modules:artifacts.reduce((n,row)=>n+row.plan.modulePlan.modules.length,0),
    contexts:artifacts.reduce((n,row)=>n+row.artifact.contexts.length,0),
    moduleCuts:artifacts.reduce((n,row)=>n+row.cuts.length,0),nativeCases:nativeEvidence?.cases.length??0,
    nativeContexts:nativeEvidence?.cases.reduce((n,row)=>n+row.contexts,0)??0,
    nativeModuleCuts:nativeEvidence?.cases.reduce((n,row)=>n+row.moduleCuts,0)??0,
    refusedStates:invalidStates.length,refusedPlans:invalidPlans.length,moduleAdmission:false,trainingAdmission:false,optimizerUpdates:0};
  if(process.env.BOUND_MODULE_SOURCE_EVIDENCE)writeFileSync(process.env.BOUND_MODULE_SOURCE_EVIDENCE,
    JSON.stringify({summary,cases:artifacts,native:nativeEvidence}));
  console.log('BOUND_MODULE_SOURCE_EVIDENCE_SUMMARY_JSON '+JSON.stringify(summary));
});
