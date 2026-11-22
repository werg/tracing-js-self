import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {linkEvaluatedModules} from '../src/evaluated-modules.js';
import {
  buildModuleSchedulerPlanV8, createModuleSchedulerStateV8, applyModuleSchedulerActionV8
} from '../src/semantic/module-scheduler-state-v8.js';

const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':
  value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>
    JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');

test('standalone source-derived scheduler state agrees with actual Python at every accepted and refused cut',
  {skip:!process.env.MEGATOKEN_ROOT},()=>{
  const modules={
    'shared.js':'export const value=1;',
    'left.js':"import {value} from './shared.js'; await Promise.resolve(); export const left=value;",
    'right.js':"import {value} from './shared.js'; await Promise.resolve(); export const right=value;",
    'main.js':"import {left} from './left.js'; import {right} from './right.js'; export function run(){return left+right;}"
  };
  const linked=linkEvaluatedModules({modules,entryModule:'main.js',exportName:'run'});
  const metadata={profile:linked.metadata.profile,evaluationStrategy:linked.metadata.evaluationStrategy,
    modules:linked.metadata.modules.map(({file,source})=>({file,source})),
    asyncDependencies:linked.metadata.asyncDependencies,entryModule:linked.metadata.entryModule};
  const plan=buildModuleSchedulerPlanV8(metadata),initial=createModuleSchedulerStateV8(plan);
  const cuts=[];
  let state=initial;
  const frame=file=>'frame:'+file,execution=file=>'execution:'+file,awaited=file=>'awaited:'+file;
  const startAction=file=>({type:'module.start',file,frameId:frame(file),executionPromiseId:execution(file)});
  const startFacts=file=>({frames:{[frame(file)]:{id:frame(file),moduleFile:file,
    executionPromiseId:execution(file)}},promises:{[execution(file)]:{id:execution(file),status:'pending'}},jobs:{}});
  function cut(label,action,facts,accepted=true,before=state,advance=accepted){
    const snapshot=structuredClone(before);
    let result;
    if(accepted)result=applyModuleSchedulerActionV8(plan,before,action,facts);
    else assert.throws(()=>applyModuleSchedulerActionV8(plan,before,action,facts),TypeError,label);
    assert.deepEqual(before,snapshot,label+' must not mutate prior state');
    cuts.push({label,before:snapshot,action:structuredClone(action),facts:structuredClone(facts),
      accepted,...(accepted?{after:result}:{})});
    if(advance)state=result;
    return result;
  }
  function settle(file,rejected=false){
    const promiseId=execution(file),jobId='settle:'+file,status=rejected?'rejected':'fulfilled';
    return [{type:rejected?'module.reject':'module.complete',file,frameId:frame(file),promiseId,jobId},
      {promises:{[promiseId]:{id:promiseId,status,value:rejected?'failure':null}},
        jobs:{[jobId]:{id:jobId,promiseId,frameId:frame(file),moduleFile:file,status,
          kind:rejected?'module-evaluation-failure':'module-execution-settle',
          value:rejected?'failure':null}}}];
  }
  function awaitCut(file){
    const promiseId=awaited(file);
    cut('await '+file,{type:'module.await',file,frameId:frame(file),promiseId},
      {frames:{[frame(file)]:{id:frame(file),moduleFile:file,executionPromiseId:execution(file),
        awaitedPromiseId:promiseId}},promises:{[promiseId]:{id:promiseId,status:'pending'}},jobs:{}});
  }
  function resume(file,rejected=false){
    const promiseId=awaited(file),jobId='reaction:'+file,status=rejected?'rejected':'fulfilled',
      value=rejected?'failure':2;
    return [{type:'module.resume',file,frameId:frame(file),promiseId,jobId},
      {frames:{[frame(file)]:{id:frame(file),moduleFile:file,executionPromiseId:execution(file),
        awaitedPromiseId:promiseId}},promises:{[promiseId]:{id:promiseId,status,value}},
        jobs:{[jobId]:{id:jobId,promiseId,frameId:frame(file),moduleFile:file,status,
          kind:'promise-reaction',value}}}];
  }
  cut('parent cannot start early',startAction('left.js'),startFacts('left.js'),false);
  const falseEdge=structuredClone(state);
  falseEdge.modules['left.js'].pendingDependencies=0;
  falseEdge.modules['left.js'].completedDependencies=['shared.js'];
  cut('forged completed dependency edge',startAction('shared.js'),startFacts('shared.js'),false,falseEdge);
  const booleanCount=structuredClone(state);booleanCount.modules['shared.js'].pendingDependencies=false;
  cut('boolean is not a dependency count',startAction('shared.js'),startFacts('shared.js'),false,booleanCount);
  cut('shared module starts once',startAction('shared.js'),startFacts('shared.js'));
  cut('shared module completes',...settle('shared.js'));
  cut('duplicate shared completion',...settle('shared.js'),false);
  const terminalAwait=structuredClone(state);terminalAwait.modules['shared.js'].awaited={promiseId:'forged'};
  cut('fulfilled state cannot retain await',startAction('left.js'),startFacts('left.js'),false,terminalAwait);
  const reused=startAction('left.js');reused.frameId=frame('shared.js');
  const reusedFacts=startFacts('left.js');reusedFacts.frames[frame('shared.js')]={id:frame('shared.js'),
    moduleFile:'left.js',executionPromiseId:execution('left.js')};
  cut('execution frame cannot be shared',reused,reusedFacts,false);
  cut('left module starts',startAction('left.js'),startFacts('left.js'));
  cut('right module starts',startAction('right.js'),startFacts('right.js'));
  awaitCut('left.js');awaitCut('right.js');
  cut('suspended body cannot complete',...settle('left.js'),false);
  const [leftResume,leftFacts]=resume('left.js');
  const wrongJob=structuredClone(leftFacts);wrongJob.jobs[leftResume.jobId].promiseId='unrelated';
  cut('reaction must own the promise',leftResume,wrongJob,false);
  const wrongValue=structuredClone(leftFacts);wrongValue.jobs[leftResume.jobId].value=3;
  cut('fulfilled reaction outcome must agree',leftResume,wrongValue,false);
  cut('left resumes',leftResume,leftFacts);
  cut('left completes',...settle('left.js'));
  const fork=structuredClone(state);
  const [rightReject,rightFacts]=resume('right.js',true);
  const wrongReason=structuredClone(rightFacts);wrongReason.jobs[rightReject.jobId].value='different';
  cut('rejected reaction outcome must agree',rightReject,wrongReason,false);
  cut('right await rejects',rightReject,rightFacts);
  cut('rejected await cannot fulfill module',...settle('right.js'),false);
  cut('right execution rejects',...settle('right.js',true));
  const propagate={type:'module.propagateFailure',file:'main.js',dependencyFile:'right.js',
    promiseId:execution('right.js'),jobId:'settle:right.js'};
  const propagationFacts=settle('right.js',true)[1];
  const forgedRejected=structuredClone(state);
  forgedRejected.modules['right.js'].awaited={promiseId:'forged'};
  cut('rejected terminal state cannot retain await',propagate,propagationFacts,false,forgedRejected);
  cut('failure propagates through exact dependency',propagate,propagationFacts);
  cut('propagated failure cannot run parent',startAction('main.js'),startFacts('main.js'),false);
  const fakeFailure=structuredClone(fork);
  Object.assign(fakeFailure.modules['main.js'],{status:'rejected',completionJobId:'fake',
    failure:{moduleFile:'right.js',promiseId:execution('right.js'),jobId:'fake'}});
  cut('failure state needs a rejected dependency',rightReject,rightFacts,false,fakeFailure);
  state=structuredClone(fork);
  cut('independent success branch resumes right',...resume('right.js'));
  cut('success branch completes right',...settle('right.js'));
  cut('completed DAG starts entry',startAction('main.js'),startFacts('main.js'));
  cut('entry completes',...settle('main.js'));
  const badBody={schema:plan.schema,entryModule:plan.entryModule,modules:structuredClone(plan.modules)};
  badBody.modules[0].index=false;
  const badPlan={...badBody,digest:digest(badBody)};
  assert.throws(()=>createModuleSchedulerStateV8(badPlan),TypeError);
  const payload={metadata,plan,initial,cuts,refusedPlans:[badPlan]};
  const nativeRoot=resolve(process.env.MEGATOKEN_ROOT);
  const python="\nimport json,sys\nfrom megatoken.data.module_scheduler_state_v8 import (\n    build_module_scheduler_plan_v8, create_module_scheduler_state_v8,\n    apply_module_scheduler_action_v8)\npayload=json.load(sys.stdin)\nplan=build_module_scheduler_plan_v8(payload[\"metadata\"])\nassert plan == payload[\"plan\"]\nassert create_module_scheduler_state_v8(plan) == payload[\"initial\"]\nout=[]\nfor cut in payload[\"cuts\"]:\n    try:\n        state=apply_module_scheduler_action_v8(plan,cut[\"before\"],cut[\"action\"],cut[\"facts\"])\n        out.append({\"accepted\":True,\"after\":state})\n    except Exception as error:\n        out.append({\"accepted\":False,\"errorType\":type(error).__name__})\nrefused=[]\nfor candidate in payload[\"refusedPlans\"]:\n    try:\n        create_module_scheduler_state_v8(candidate)\n        refused.append(False)\n    except Exception:\n        refused.append(True)\nprint(json.dumps({\"cuts\":out,\"refusedPlans\":refused}))\n";
  const child=spawnSync(process.env.MEGATOKEN_PYTHON||'python',['-c',python],{
    cwd:nativeRoot,env:{...process.env,PYTHONPATH:join(nativeRoot,'src')},
    input:JSON.stringify(payload),encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024});
  assert.equal(child.status,0,child.stderr||String(child.error));
  const native=JSON.parse(child.stdout);
  assert.equal(native.cuts.length,cuts.length);
  for(let index=0;index<cuts.length;index++){
    const expected=cuts[index],actual=native.cuts[index];
    assert.equal(actual.accepted,expected.accepted,expected.label);
    if(expected.accepted)assert.deepEqual(actual.after,expected.after,expected.label);
  }
  assert.deepEqual(native.refusedPlans,[true]);
  const evidence={schema:'experimental-module-scheduler-state-differential/1',planDigest:plan.digest,
    acceptedCuts:cuts.filter(c=>c.accepted).length,refusedCuts:cuts.filter(c=>!c.accepted).length,
    refusedPlans:1,publicAdmission:false,payload,native};
  if(process.env.RUNNER_TEMP)writeFileSync(join(process.env.RUNNER_TEMP,'module-scheduler-state-evidence.json'),
    JSON.stringify(evidence)+'\n',{flag:'wx'});
  assert(cuts.length>=28);
});
