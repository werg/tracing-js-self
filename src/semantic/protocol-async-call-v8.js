// A nested async call owns its execution Promise and retained source scope.
// Its first await returns to the caller; later resumptions own separate turns.
import {assertAlgorithmFields,assertAlgorithmDataArray} from './ir.js';
import {assertPlainPromiseResolutionWithApiV8} from './promise-resolution-shape-v8.js';

export const ASYNC_CALL_PROFILE_V8='async-scoped-call/1';
export const ASYNC_CALL_STATE_V8='semantic-async-call-state/1';
export const ASYNC_CALL_FIELDS_V8=Object.freeze(['schema','owner','invocation','callee','receiver','arguments','parent',
  'phase','attached','continuations','resumeScope','completion']);
export const ASYNC_CALL_RECORD_FIELDS=Object.freeze(Object.fromEntries(Object.entries({
  'async.function':['kind','object'],
  'async.call':['kind','promise','child','callee','receiver','arguments'],
  'async.await':['kind','promise','invocation','awaited','continuation'],
  'async.resume':['kind','promise','invocation','continuation','status','value'],
  'async.complete':['kind','promise','invocation','completion']
}).map(([kind,fields])=>[kind,Object.freeze(fields)])));
const copy=structuredClone,U=['undefined'],bound=4096;
const fail=message=>{throw new TypeError('Async scoped call: '+message);};
const id=value=>{if(typeof value!=='string'||!value||value.length>256)fail('bounded identity required');};
function completion(value,validate){
  assertAlgorithmFields(value,['kind','value'],'async completion');
  if(!['return','throw'].includes(value.kind))fail('completion kind');validate(value.value);
}
export function validateAsyncCallRecordV8(record,{value:validate}={}){
  const fields=ASYNC_CALL_RECORD_FIELDS[record?.kind];if(!fields)return false;
  assertAlgorithmFields(record,fields,'async call record');
  for(const key of ['object','promise','child','invocation','awaited','continuation'])if(Object.hasOwn(record,key))id(record[key]);
  if(record.kind==='async.call'){
    validate(record.callee);if(record.callee[0]!=='ref')fail('owned async callable required');
    validate(record.receiver);assertAlgorithmDataArray(record.arguments,'async arguments');
    if(record.arguments.length>bound)fail('argument bound');record.arguments.forEach(validate);
  }else if(record.kind==='async.resume'){
    if(!['fulfilled','rejected'].includes(record.status))fail('resume settlement');validate(record.value);
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
      phase:'running',attached:true,continuations:[],resumeScope:null,completion:null};return true;
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
  api.require(call.phase==='running'&&node.state==='pending'&&controller.stack.at(-1)===call.invocation,
    'completion requires the running unsettled async invocation');
  if(record.completion.kind==='return')assertPlainPromiseResolutionWithApiV8(controller,record.completion.value,api);
  const attached=call.attached;detach(controller,call,api);
  call.phase='completed';call.completion=copy(record.completion);
  controller.settlePromise(record.promise,record.completion.kind==='return'?'fulfilled':'rejected',record.completion.value);
  if(attached)controller.lastReturn={kind:'return',value:['ref',record.promise]};
  return true;
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
export function allowsAsyncCallWithoutStackV8(_controller,record){return record.kind==='async.resume';}
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
      api.require(node.state===(call.completion.kind==='return'?'fulfilled':'rejected')&&api.eq(node.result,call.completion.value),
        'retained async completion differs from execution Promise');
    }else api.require(node.state==='pending'&&call.completion===null,'unfinished async execution Promise is settled');
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
        api.require(node.state===(call.completion.kind==='return'?'fulfilled':'rejected')&&api.eq(node.result,call.completion.value),
          'retained async completion differs from execution Promise');
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
  return {valid:true,calls:calls.length};
}
