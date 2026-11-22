// A nested async call owns its execution Promise and retained source scope.
// Its first await returns to the caller; later resumptions own separate turns.
import {assertAlgorithmFields,assertAlgorithmDataArray} from './ir.js';
import {assertPlainPromiseResolutionWithApiV8} from './promise-resolution-shape-v8.js';

export const ASYNC_CALL_PROFILE_V8='async-scoped-call/1';
export const ASYNC_CALL_STATE_V8='semantic-async-call-state/1';
export const ASYNC_CALL_FIELDS_V8=Object.freeze(['schema','owner','invocation','callee','receiver','arguments','parent',
  'phase','attached','continuations','resumeScope','completion','resolution']);
export const ASYNC_CALL_RECORD_FIELDS=Object.freeze(Object.fromEntries(Object.entries({
  'async.function':['kind','object'],
  'async.call':['kind','promise','child','callee','receiver','arguments'],
  'async.await':['kind','promise','invocation','awaited','continuation'],
  'async.resume':['kind','promise','invocation','continuation','status','value'],
  'async.complete':['kind','promise','invocation','completion'],
  'async.resolve.enqueue':['kind','promise','invocation','target','job','settlementJob'],
  'async.resolve.subscribe':['kind','promise','invocation','target','job','settlementJob'],
  'async.resolve.settle':['kind','promise','invocation','target','job','status','value']
}).map(([kind,fields])=>[kind,Object.freeze(fields)])));
const copy=structuredClone,U=['undefined'],bound=4096,
  resolutionSchema='semantic-async-promise-resolution/1';
const fail=message=>{throw new TypeError('Async scoped call: '+message);};
const id=value=>{if(typeof value!=='string'||!value||value.length>256)fail('bounded identity required');};
function completion(value,validate){
  assertAlgorithmFields(value,['kind','value'],'async completion');
  if(!['return','throw'].includes(value.kind))fail('completion kind');validate(value.value);
}
export function validateAsyncCallRecordV8(record,{value:validate}={}){
  const fields=ASYNC_CALL_RECORD_FIELDS[record?.kind];if(!fields)return false;
  assertAlgorithmFields(record,fields,'async call record');
  for(const key of ['object','promise','child','invocation','awaited','continuation','target','job','settlementJob'])
    if(Object.hasOwn(record,key))id(record[key]);
  if(record.kind==='async.call'){
    validate(record.callee);if(record.callee[0]!=='ref')fail('owned async callable required');
    validate(record.receiver);assertAlgorithmDataArray(record.arguments,'async arguments');
    if(record.arguments.length>bound)fail('argument bound');record.arguments.forEach(validate);
  }else if(record.kind==='async.resume'){
    if(!['fulfilled','rejected'].includes(record.status))fail('resume settlement');validate(record.value);
  }else if(record.kind==='async.resolve.settle'){
    if(!['fulfilled','rejected'].includes(record.status))fail('resolution settlement');validate(record.value);
  }else if(record.kind==='async.complete')completion(record.completion,validate);
  return true;
}
const entries=controller=>[...controller.heap].filter(([,node])=>node.asyncCall!==undefined);
function promise(controller,identity,api){
  const node=controller.heap.get(identity);
  api.require(node?.kind==='promise'&&node.external===null,'owned internal execution Promise required');return node;
}
function entry(controller,record,api){
  const node=promise(controller,record.promise,api),call=node.asyncCall;
  api.require(call?.schema===ASYNC_CALL_STATE_V8&&call.owner===controller.rootInvocation&&call.invocation===record.invocation,
    'execution Promise does not own this async invocation');return {node,call};
}
function scope(controller){return {receiver:copy(controller.receiver??U),aliases:[...controller.captureAliases]};}
function restoreScope(controller,saved){controller.receiver=copy(saved.receiver);controller.captureAliases=new Map(saved.aliases);}
function detach(controller,call,api){
  api.require(controller.stack.at(-1)===call.invocation,'async body is not active');
  if(call.attached){
    const frame=controller.protocol.callFrames.at(-1);
    api.require(frame?.child===call.invocation&&frame.parent===call.parent&&controller.stack.at(-2)===call.parent,
      'async first suspension lost its caller scope');
    controller.protocol.callFrames.pop();controller.stack.pop();
    restoreScope(controller,{receiver:frame.priorReceiver,aliases:frame.priorAliases});
  }else{
    api.require(controller.stack.length===1&&!controller.activeJob&&call.resumeScope,
      'detached async turn has a foreign caller or job');
    controller.stack.pop();restoreScope(controller,call.resumeScope);call.resumeScope=null;
  }
}
export function applyAsyncCallRecordV8(controller,record,api){
  if(!validateAsyncCallRecordV8(record,{value:value=>api.known(controller,value)}))return false;
  if(record.kind==='async.function'){
    const fn=controller.heap.get(record.object);
    api.require(fn?.kind==='closure'&&!fn.asyncFunction&&!fn.generatorFunction&&!fn.promiseResolver&&!fn.callable,
      'async definition requires an undeclared source closure');
    fn.asyncFunction=true;return true;
  }
  if(record.kind==='async.call'){
    const fn=controller.heap.get(record.callee[1]),node=promise(controller,record.promise,api);
    api.require(fn?.kind==='closure'&&fn.asyncFunction===true,'declared async source callable required');
    api.require(node.state==='pending'&&node.adopted===null&&!node.join&&!node.asyncCall&&
      !controller.protocol.promiseExecutors?.capabilities.some(row=>row.promise===record.promise),
      'async call requires a fresh unclaimed execution Promise');
    api.require(entries(controller).length<bound,'async call bound');
    const parent=controller.stack.at(-1);api.require(parent,'async call requires its active parent');
    api.call(controller,{child:record.child,callee:record.callee,receiver:record.receiver,arguments:record.arguments},{async:true});
    node.asyncCall={schema:ASYNC_CALL_STATE_V8,owner:controller.rootInvocation,invocation:record.child,
      callee:copy(record.callee),receiver:copy(controller.receiver),arguments:copy(record.arguments),parent,
      phase:'running',attached:true,continuations:[],resumeScope:null,completion:null,resolution:null};return true;
  }
  const {node,call}=entry(controller,record,api);
  if(record.kind==='async.await'){
    api.require(call.phase==='running'&&node.state==='pending'&&controller.stack.at(-1)===call.invocation,
      'await requires the running unsettled async invocation');
    controller.promise(record.awaited);
    api.require(!controller.continuations.has(record.continuation)&&!controller.jobs.has(record.continuation),
      'continuation identity is not fresh');
    api.require(call.continuations.length<bound,'async await bound');
    const saved=scope(controller),attached=call.attached;
    detach(controller,call,api);
    controller.continuations.set(record.continuation,{state:'waiting',promise:record.awaited,invocation:call.invocation,
      sequence:++controller.scheduler.registration,activeJob:null,captureAliases:saved.aliases,receiver:saved.receiver});
    call.attached=false;call.phase='suspended';call.continuations.push(record.continuation);
    if(attached)controller.lastReturn={kind:'return',value:['ref',record.promise]};
    controller.refreshReady();return true;
  }
  if(record.kind==='async.resume'){
    const continuation=controller.continuations.get(record.continuation);
    api.require(call.phase==='suspended'&&!call.attached&&call.continuations.at(-1)===record.continuation&&
      continuation?.invocation===call.invocation&&continuation.state==='ready'&&continuation.activeJob===null,
      'resume requires this async call\'s latest ready continuation');
    api.require(!controller.stack.length&&!controller.activeJob&&!controller.protocol.callFrames.length&&
      !controller.protocol.pendingCalls.length&&controller.ready[0]===record.continuation,
      'async resume violates FIFO or active turn ownership');
    const awaited=controller.promise(continuation.promise);
    api.require(awaited.state===record.status&&api.eq(awaited.result,record.value),'async resume contradicts settled dependency');
    call.resumeScope=scope(controller);controller.ready.shift();continuation.state='resumed';
    controller.stack.push(call.invocation);restoreScope(controller,{receiver:continuation.receiver,aliases:continuation.captureAliases});
    call.phase='running';return true;
  }
  if(record.kind==='async.resolve.enqueue'){
    const resolution=call.resolution,target=controller.heap.get(record.target);
    api.require(call.phase==='completed'&&resolution?.schema===resolutionSchema&&
      resolution.phase==='enqueue-pending'&&resolution.target===record.target&&
      call.completion?.kind==='return'&&api.eq(call.completion.value,['ref',record.target])&&
      target?.kind==='promise'&&target.external===null&&record.target!==record.promise,
    'Promise-resolution enqueue differs from the exact completed async return');
    api.require(!resolutionCycle(controller,record.promise,record.target),'Promise-resolution dependency cycle');
    api.require(record.job!==record.settlementJob&&
      !controller.jobs.has(record.job)&&!controller.jobs.has(record.settlementJob)&&
      !controller.continuations.has(record.job)&&!controller.continuations.has(record.settlementJob),
    'Promise-resolution job identities must be fresh');
    resolution.assimilationJob=record.job;resolution.settlementJob=record.settlementJob;resolution.phase='queued';
    controller.jobs.set(record.job,{status:'queued',owner:call.owner,promise:null,reaction:'async-resolution-enqueue',
      closure:null,rejectionClosure:null,target:record.promise,sequence:null,
      asyncResolution:{promise:record.promise,target:record.target,phase:'enqueue'}});
    controller.ready.push(record.job);controller.jobs.get(record.job).readySequence=++controller.scheduler.ready;
    return true;
  }
  if(record.kind==='async.resolve.subscribe'){
    const resolution=call.resolution,job=controller.jobs.get(record.job),target=controller.heap.get(record.target);
    api.require(call.phase==='completed'&&resolution?.schema===resolutionSchema&&resolution.phase==='queued'&&
      resolution.target===record.target&&resolution.assimilationJob===record.job&&
      resolution.settlementJob===record.settlementJob&&record.job!==record.settlementJob&&
      call.completion?.kind==='return'&&api.eq(call.completion.value,['ref',record.target])&&
      job?.owner===call.owner&&job.status==='queued'&&job.reaction==='async-resolution-enqueue'&&
      api.eq(job.asyncResolution,{promise:record.promise,target:record.target,phase:'enqueue'})&&
      controller.ready[0]===record.job&&!controller.stack.length&&!controller.activeJob&&
      target?.kind==='promise'&&target.external===null,
    'Promise-resolution subscription requires its exact FIFO enqueue job');
    controller.ready.shift();job.status='completed';
    resolution.phase='subscribed';
    controller.jobs.set(record.settlementJob,{status:'waiting',owner:call.owner,promise:record.target,
      reaction:'async-resolution-settle',closure:null,rejectionClosure:null,target:record.promise,
      sequence:++controller.scheduler.registration,
      asyncResolution:{promise:record.promise,target:record.target,phase:'settle'}});
    controller.refreshReady();return true;
  }
  if(record.kind==='async.resolve.settle'){
    const resolution=call.resolution,job=controller.jobs.get(record.job),target=controller.heap.get(record.target);
    api.require(call.phase==='completed'&&resolution?.schema===resolutionSchema&&resolution.phase==='subscribed'&&
      resolution.target===record.target&&resolution.settlementJob===record.job&&
      resolution.assimilationJob!==record.job&&job?.owner===call.owner&&job.status==='queued'&&
      job.reaction==='async-resolution-settle'&&job.promise===record.target&&job.target===record.promise&&
      api.eq(job.asyncResolution,{promise:record.promise,target:record.target,phase:'settle'})&&
      controller.ready[0]===record.job&&!controller.stack.length&&!controller.activeJob&&
      ['fulfilled','rejected'].includes(target?.state)&&target.external===null&&
      target.state===record.status&&api.eq(target.result,record.value),
    'Promise-resolution settlement requires its exact subscribed FIFO observer');
    const outer=promise(controller,record.promise,api);
    api.require(outer.state==='pending'&&outer.adopted===null,'async execution Promise changed before adoption');
    if(record.status==='fulfilled')assertPlainPromiseResolutionWithApiV8(controller,record.value,api);
    controller.ready.shift();job.status='completed';resolution.phase='settled';
    controller.settlePromise(record.promise,record.status,record.value);return true;
  }
  api.require(call.phase==='running'&&node.state==='pending'&&controller.stack.at(-1)===call.invocation,
    'completion requires the running unsettled async invocation');
  const returned=record.completion.value,
    adoption=record.completion.kind==='return'&&returned?.[0]==='ref'&&
      controller.heap.get(returned[1])?.kind==='promise';
  if(record.completion.kind==='return'&&!adoption)assertPlainPromiseResolutionWithApiV8(controller,returned,api);
  if(adoption){const target=controller.heap.get(returned[1]);
    api.require(target.external===null&&returned[1]!==record.promise&&!resolutionCycle(controller,record.promise,returned[1]),
      'async Promise return requires a distinct owned target without a resolution cycle');}
  const attached=call.attached;detach(controller,call,api);
  call.phase='completed';call.completion=copy(record.completion);
  if(adoption)call.resolution={schema:resolutionSchema,target:returned[1],assimilationJob:null,
    settlementJob:null,phase:'enqueue-pending'};
  else{call.resolution=null;
    controller.settlePromise(record.promise,record.completion.kind==='return'?'fulfilled':'rejected',record.completion.value);}
  if(attached)controller.lastReturn={kind:'return',value:['ref',record.promise]};
  return true;
}

function resolutionCycle(controller,promiseId,targetId){
  const seen=new Set();let cursor=targetId;
  while(cursor&&!seen.has(cursor)){
    if(cursor===promiseId)return true;seen.add(cursor);
    const resolution=controller.heap.get(cursor)?.asyncCall?.resolution;
    cursor=resolution&&resolution.phase!=='settled'?resolution.target:null;
  }
  return false;
}
export function assertAsyncCallV8(controller,callee,options,api){
  if(callee?.[0]==='ref'&&controller.heap.get(callee[1])?.asyncFunction)
    api.require(options?.async===true,'async callable requires its execution-Promise call protocol');
  return true;
}
export function assertAsyncCallNextV8(controller,record,api){
  const fields=record.fields??record,calls=entries(controller),active=calls.find(([,node])=>
    node.asyncCall.invocation===controller.stack.at(-1)&&node.asyncCall.phase==='running');
  if(active&&['return','throw','await'].includes(record.kind))return false;
  if(record.kind==='job'&&controller.jobs.get(fields.job)?.asyncResolution)return false;
  if(record.kind==='async.complete'&&fields.completion?.kind==='return'&&fields.completion.value?.[0]==='ref'&&
      controller.heap.get(fields.completion.value[1])?.kind==='promise'){
    const row=controller.heap.get(fields.promise)?.asyncCall;
    if(row?.phase!=='running'||controller.stack.at(-1)!==row.invocation)return false;
  }
  for(const [,node]of calls){const resolution=node.asyncCall.resolution;
    if(resolution?.phase==='enqueue-pending'&&record.kind!=='async.resolve.enqueue')return false;}
  if(record.kind==='resume'&&calls.some(([,node])=>node.asyncCall.continuations.includes(fields.continuation)))return false;
  if(record.kind==='end'&&calls.some(([,node])=>node.asyncCall.owner===controller.rootInvocation&&node.asyncCall.phase!=='completed'))return false;
  if(record.kind==='promise'&&['resolve','reject','adopt'].includes(fields.action)&&controller.heap.get(fields.promise)?.asyncCall)return false;
  if(record.kind==='promise.join'&&controller.heap.get(fields.result)?.asyncCall)return false;
  if(record.kind==='promise.executor.enter'&&controller.heap.get(fields.promise)?.asyncCall)return false;
  if(record.kind==='call')assertAsyncCallV8(controller,fields.callee,{},api);
  return true;
}
export function allowsAsyncCallInternalSchedulerV8(controller,record){
  return record?.kind.startsWith('async.')||entries(controller).some(([,node])=>node.asyncCall.owner===controller.rootInvocation)||
    [...controller.heap.values()].some(node=>node.asyncFunction===true);
}
export function allowsAsyncCallWithoutStackV8(_controller,record){return record.kind==='async.resume'||
  record.kind.startsWith('async.resolve.');}
export function restoreAsyncCallStateV8(controller,api){
  const invocations=new Set(),continuations=new Set(),calls=entries(controller);
  api.require(calls.length<=bound,'restored async call bound');
  for(const [,fn]of controller.heap)if(fn.asyncFunction!==undefined)
    api.require(fn.asyncFunction===true&&fn.kind==='closure'&&!fn.generatorFunction&&!fn.promiseResolver&&!fn.callable,
      'restored async callable capability');
  for(const [identity,node]of calls){
    const call=node.asyncCall;
    assertAlgorithmFields(call,ASYNC_CALL_FIELDS_V8,'retained async call');
    for(const key of ['owner','invocation','parent'])id(call[key]);
    api.require(call.schema===ASYNC_CALL_STATE_V8&&node.kind==='promise'&&node.external===null&&node.adopted===null&&!node.join&&
      typeof call.attached==='boolean'&&['running','suspended','completed'].includes(call.phase),'retained async call shape');
    api.known(controller,call.callee);api.known(controller,call.receiver);
    const fn=call.callee[0]==='ref'&&controller.heap.get(call.callee[1]);
    const invocation=call.owner+'/'+call.invocation;
    api.require(fn?.asyncFunction===true&&!invocations.has(invocation),'retained async callable or invocation identity');
    invocations.add(invocation);assertAlgorithmDataArray(call.arguments,'retained async arguments');
    api.require(call.arguments.length<=bound,'retained async argument bound');call.arguments.forEach(value=>api.known(controller,value));
    assertAlgorithmDataArray(call.continuations,'retained async continuations');
    api.require(call.continuations.length<=bound&&(!call.attached||call.continuations.length===0),'retained async attachment');
    api.require(new Set(call.continuations).size===call.continuations.length,'duplicate retained async continuation');
    call.continuations.forEach(id);
    if(call.phase==='completed'){
      completion(call.completion,value=>api.known(controller,value));
      validateResolutionState(controller,identity,node,call,api);
    }else api.require(node.state==='pending'&&call.completion===null&&call.resolution===null,
      'unfinished async execution Promise is settled');
    if(call.owner!==controller.rootInvocation)continue; // Shared realm heap; only this controller owns its frames/jobs.
    api.require(controller.frameFunctions.get(call.invocation)===fn.code&&controller.frameFunctions.has(call.parent),
      'retained async source frame identity');
    for(const [index,identity]of call.continuations.entries()){
      id(identity);const continuation=controller.continuations.get(identity);
      api.require(!continuations.has(identity)&&continuation?.invocation===call.invocation&&continuation.activeJob===null,
        'retained async continuation ownership');continuations.add(identity);
      api.require(controller.heap.get(continuation.promise)?.kind==='promise','retained async awaited Promise identity');
      api.require(api.eq(continuation.receiver,call.receiver)&&api.eq(continuation.captureAliases,fn.captures.map(row=>[row.binding,row.cell])),
        'retained async continuation receiver or captured cells');
      api.require(index===call.continuations.length-1&&call.phase==='suspended'?
        ['waiting','ready'].includes(continuation.state):continuation.state==='resumed','retained async continuation phase');
    }
    const frame=controller.protocol.callFrames.find(row=>row.child===call.invocation);
    if(call.phase==='running'){
      api.require(node.state==='pending'&&call.completion===null&&controller.stack.includes(call.invocation),
        'retained running async body');
      api.require(call.attached?frame?.parent===call.parent&&call.resumeScope===null:
        !frame&&controller.stack[0]===call.invocation&&call.resumeScope!==null&&!controller.activeJob,'retained async call scope');
      if(controller.stack.at(-1)===call.invocation){
        api.require(api.eq(controller.receiver,call.receiver)&&api.eq([...controller.captureAliases],fn.captures.map(row=>[row.binding,row.cell])),
          'retained async receiver or live capture aliases');
      }
    }else{
      api.require(!controller.stack.includes(call.invocation)&&!frame&&call.resumeScope===null,'inactive async frame retains a live scope');
      if(call.phase==='suspended')api.require(!call.attached&&call.continuations.length>0&&node.state==='pending'&&call.completion===null,
        'retained suspended async body');
      else{
        completion(call.completion,value=>api.known(controller,value));
        validateResolutionState(controller,identity,node,call,api);
      }
    }
    if(call.resumeScope!==null){
      assertAlgorithmFields(call.resumeScope,['receiver','aliases'],'async idle scope');api.known(controller,call.resumeScope.receiver);
      assertAlgorithmDataArray(call.resumeScope.aliases,'async idle aliases');
      const aliases=new Set();for(const pair of call.resumeScope.aliases){assertAlgorithmDataArray(pair,'async idle alias');
        api.require(pair.length===2&&pair.every(value=>typeof value==='string')&&!aliases.has(pair[0])&&controller.locals.has(pair[1]),
          'retained async idle alias');aliases.add(pair[0]);}
    }
  }
  for(const [jobId,job]of controller.jobs)if(job.asyncResolution){
    const resolution=controller.heap.get(job.asyncResolution.promise)?.asyncCall?.resolution;
    api.require(resolution&&[resolution.assimilationJob,resolution.settlementJob].includes(jobId),
      'orphan Promise-resolution job');
  }
  return {valid:true,calls:calls.length};
}

function validateResolutionState(controller,identity,node,call,api){
  const completionValue=call.completion.value,
    targetId=completionValue?.[0]==='ref'&&controller.heap.get(completionValue[1])?.kind==='promise'?
      completionValue[1]:null,resolution=call.resolution;
  if(targetId===null){
    api.require(resolution===null&&node.state===(call.completion.kind==='return'?'fulfilled':'rejected')&&
      api.eq(node.result,completionValue),'retained async completion differs from execution Promise');return;
  }
  api.require(call.completion.kind==='return'&&resolution?.schema===resolutionSchema&&
    resolution.target===targetId&&targetId!==identity&&resolution.phase&&
    ['enqueue-pending','queued','subscribed','settled'].includes(resolution.phase)&&
    controller.heap.get(targetId)?.external===null&&!resolutionCycle(controller,identity,targetId),
  'retained async Promise-resolution identity or phase differs');
  if(resolution.phase==='enqueue-pending'){
    api.require(resolution.assimilationJob===null&&resolution.settlementJob===null&&node.state==='pending'&&node.result===null,
      'pending async Promise-resolution enqueue changed its Promise');return;
  }
  const assimilation=controller.jobs.get(resolution.assimilationJob);
  api.require(typeof resolution.assimilationJob==='string'&&typeof resolution.settlementJob==='string'&&
    resolution.assimilationJob!==resolution.settlementJob&&assimilation?.owner===call.owner&&
    assimilation.reaction==='async-resolution-enqueue'&&assimilation.target===identity&&
    api.eq(assimilation.asyncResolution,{promise:identity,target:targetId,phase:'enqueue'}),
  'retained async assimilation job differs');
  if(resolution.phase==='queued'){
    api.require(assimilation.status==='queued'&&controller.ready.includes(resolution.assimilationJob)&&
      !controller.jobs.has(resolution.settlementJob)&&node.state==='pending'&&node.result===null,
    'queued async assimilation job or unresolved Promise differs');return;
  }
  api.require(assimilation.status==='completed'&&!controller.ready.includes(resolution.assimilationJob),
    'retained async assimilation job is not completed');
  const settlement=controller.jobs.get(resolution.settlementJob),target=controller.heap.get(targetId);
  api.require(settlement?.owner===call.owner&&settlement.reaction==='async-resolution-settle'&&
    settlement.promise===targetId&&settlement.target===identity&&
    api.eq(settlement.asyncResolution,{promise:identity,target:targetId,phase:'settle'}),
  'retained async settlement observer differs');
  if(resolution.phase==='subscribed'){
    api.require(node.state==='pending'&&node.result===null&&
      (target.state==='pending'?settlement.status==='waiting'&&!controller.ready.includes(resolution.settlementJob):
        settlement.status==='queued'&&controller.ready.includes(resolution.settlementJob)),
    'retained async settlement observer disagrees with its target');return;
  }
  api.require(target.state!=='pending'&&settlement.status==='completed'&&
    !controller.ready.includes(resolution.settlementJob)&&node.state===target.state&&api.eq(node.result,target.result),
  'retained async Promise settlement differs from its exact target');
}
