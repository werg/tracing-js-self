import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from 'acorn';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {writeFileSync} from 'node:fs';
import {createRuntime} from '../src/runtime.js';
import {realizeGraph} from '../src/training/graph.js';
import {linkEvaluatedModules} from '../src/evaluated-modules.js';
import {deriveModuleSchedulerSourceCutsV8} from '../src/semantic/module-scheduler-source-v8.js';

const wire=value=>JSON.parse(JSON.stringify(value));
const evidence=[];
const helper='__moduleLifecycleObserverForTest';
function instrument(source,file){
  assert(!source.includes(helper));
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});
  function render(root){
    const awaits=[];
    function walk(node){
      if(!node||typeof node!=='object'||/Function/.test(node.type))return;
      if(node.type==='AwaitExpression'){awaits.push(node);return;}
      for(const [key,child]of Object.entries(node)){
        if(['start','end','loc','range'].includes(key))continue;
        if(Array.isArray(child))child.forEach(walk);else walk(child);
      }
    }
    walk(root);let text=source.slice(root.start,root.end);
    for(const node of awaits.sort((a,b)=>b.start-a.start)){
      const replacement='(await '+helper+'('+JSON.stringify(file)+',"await",('+render(node.argument)+')))';
      text=text.slice(0,node.start-root.start)+replacement+text.slice(node.end-root.start);
    }
    return text;
  }
  return helper+'('+JSON.stringify(file)+',"start");\n'+render(ast)+'\n'+
    helper+'('+JSON.stringify(file)+',"complete");';
}
async function original(modules,observe=false){
  const observations=[],context=vm.createContext(observe?{[helper]:(file,type,value)=>{
    observations.push({file,type});return value;
  }}:{});
  const table=new Map(Object.entries(modules).map(([file,source])=>[file,new vm.SourceTextModule(
    observe?instrument(source,file):source,{context,identifier:file})]));
  const root=table.get('main.js');
  await root.link((specifier,referencing)=>table.get(new URL(specifier,'file:///'+referencing.identifier).pathname.slice(1)));
  let outcome;
  try{await root.evaluate();outcome={status:'fulfilled',value:wire(await root.namespace.run())};}
  catch(error){outcome={status:'rejected',value:typeof error==='object'?{name:error.name}:error};}
  await new Promise(resolve=>setImmediate(resolve));
  return {outcome,observations};
}
function owned(modules){
  const request={modules,entryModule:'main.js',exportName:'run'},linked=linkEvaluatedModules(request),
    runtime=createRuntime().startEntry({text:linked.source,functionName:linked.entryFunction,args:[linked.entryInput],allowAsync:true});
  assert.equal(runtime.drive().kind,'terminated');
  const bundle=wire(runtime.exportRun()),promise=bundle.finalState.promises[
    bundle.initialState.frames[bundle.initialState.control.a0.activeFrameId].asyncPromiseId],
    value=realizeGraph(bundle.finalState.heap,[promise.value.value])[0];
  return {request,bundle,outcome:{status:promise.status,value:promise.status==='rejected'&&value&&typeof value==='object'?{name:value.name}:value}};
}
function nativeCuts(projection){
  if(!process.env.MEGATOKEN_ROOT)return null;
  const root=resolve(process.env.MEGATOKEN_ROOT),python=`
import json,sys
from megatoken.data.module_scheduler_state_v8 import create_module_scheduler_state_v8,apply_module_scheduler_action_v8
payload=json.load(sys.stdin)
state=create_module_scheduler_state_v8(payload['plan'])
result=[]
for cut in payload['cuts']:
    assert state==cut['before']
    state=apply_module_scheduler_action_v8(payload['plan'],state,cut['action'],cut['facts'])
    assert state==cut['after']
    result.append(state)
assert state==payload['state']
print(json.dumps({'cuts':len(result),'state':state}))
`;
  const result=spawnSync(process.env.MEGATOKEN_PYTHON||'python',['-c',python],{
    cwd:root,env:{...process.env,PYTHONPATH:join(root,'src')},input:JSON.stringify(projection),encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr||String(result.error));return JSON.parse(result.stdout);
}
const cases=[
  ['already-settled rejection is caught, a sibling finishes, and the synchronous parent has no execution Promise',{
    'left.js':'export let x=0;try {await Promise.reject(7);} catch(e){x=e;}',
    'right.js':'await 0; export const x=2;',
    'main.js':"import {x} from './left.js';import {x as y} from './right.js';export function run(){return x+y;}"
  }],
  ['shared asynchronous dependency, nested awaits and catch/finally retain actual driver identity',{
    'shared.js':'await 0; export const value=1;',
    'left.js':"import {value} from './shared.js'; let x=0;try {x=await await Promise.resolve(value);}finally {await 0;} export {x};",
    'right.js':"import {value} from './shared.js';await Promise.resolve(value);export const x=2;",
    'main.js':"import {x} from './left.js';import {x as y} from './right.js';export function run(){return x+y;}"
  }],
  ['uncaught async failure rejects its parent while an already-started sibling completes',{
    'left.js':'await 0; throw 7;',
    'right.js':'await 0; export const value=2;',
    'main.js':"import './left.js';import './right.js';export function run(){return 1;}"
  }],
  ['synchronous shared dependency completes once before two async children',{
    'shared.js':'export const value=1;',
    'left.js':"import {value} from './shared.js';await 0;export const x=value;",
    'right.js':"import {value} from './shared.js';await 0;export const x=value+1;",
    'main.js':"import {x} from './left.js';import {x as y} from './right.js';export function run(){return x+y;}"
  }],
  ['syntactic TLA without suspension still retains its async completion job',{
    'left.js':'if(false){await 0;} export const x=1;',
    'right.js':'await 0; export const x=2;',
    'main.js':"import {x} from './left.js';import {x as y} from './right.js';export function run(){return x+y;}"
  }],
  ['failure before the first await is separated from already-started sibling work',{
    'left.js':'throw 7; await 0;',
    'right.js':'await 0; export const x=2;',
    'main.js':"import './left.js';import './right.js';export function run(){return 1;}"
  }]
];

for(const [name,modules]of cases)test(name,async()=>{
  const run=owned(modules),baseline=await original(modules),observed=await original(modules,true);
  assert.deepEqual(run.outcome,baseline.outcome);
  assert.deepEqual(observed.outcome,baseline.outcome,'observation does not alter original ESM outcome');
  const projection=deriveModuleSchedulerSourceCutsV8(run);
  assert.deepEqual(projection.observations.filter(row=>row.type!=='throw'),observed.observations,
    'actual owned module body lifecycle agrees with independently observed original ESM');
  assert.equal(projection.ownedEventCount,projection.cuts.length);
  assert.equal(new Set(projection.cuts.map(cut=>cut.certificate.eventId)).size,projection.cuts.length);
  assert(projection.cuts.every((cut,index)=>!index||cut.certificate.sequence>projection.cuts[index-1].certificate.sequence));
  for(const module of projection.plan.modules.filter(row=>!row.hasTLA))
    assert.equal(projection.state.modules[module.file].executionPromiseId,null);
  assert.equal(projection.publicAdmission,false);assert.equal(projection.trainingAdmission,false);
  const native=nativeCuts(projection);if(native)assert.deepEqual(native.state,projection.state);
  evidence.push({name,request:run.request,outcome:baseline.outcome,originalObservations:observed.observations,projection,native});
});

test('source ownership refuses a different source graph, changed dependency and changed instruction',()=>{
  const run=owned(cases[0][1]);
  for(const changed of [
    {...run.request.modules,'left.js':run.request.modules['left.js'].replace('7','8')},
    {...run.request.modules,'main.js':"import {x} from './left.js';export function run(){return x;}"}
  ])assert.throws(()=>deriveModuleSchedulerSourceCutsV8({...run,request:{...run.request,modules:changed}}));
  const bundle=structuredClone(run.bundle),program=Object.values(bundle.programs).find(row=>row.async&&row.params?.[0]==='record');
  program.instructions.find(row=>row.op==='AWAIT').op='POP';
  assert.throws(()=>deriveModuleSchedulerSourceCutsV8({...run,bundle}));
});

test('the dedicated source/native gate requires its paired consumer',{
  skip:!process.env.MEGATOKEN_ROOT
},()=>{
  const run=owned(cases[0][1]),projection=deriveModuleSchedulerSourceCutsV8(run);
  const native=nativeCuts(projection);assert(native&&native.cuts===projection.cuts.length);
});

after(()=>{
  if(process.env.RUNNER_TEMP)writeFileSync(join(process.env.RUNNER_TEMP,'module-scheduler-source-evidence.json'),
    JSON.stringify({schema:'module-scheduler-source-ownership-evidence/1',cases:evidence,
      sourceCases:evidence.length,actualNativeCases:evidence.filter(row=>row.native!==null).length,
      ownedTransitions:evidence.reduce((n,row)=>n+row.projection.cuts.length,0),
      publicAdmission:false,trainingAdmission:false,optimizerUpdates:0})+'\n');
});
