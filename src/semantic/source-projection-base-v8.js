import {parse} from 'acorn';
import {sharedProtocolSourceEventV8,sharedProtocolSourceCompletionV8,
  sharedProtocolSourceAllocationV8} from './protocol-source-claims-v8.js';
import {promiseObjectSourceEventV8,promiseObjectSourceAllocationV8,promiseObjectSourceCompletionV8} from './protocol-promise-object-source-v8.js';

// The ordinary projector is an explicit peer, not a fallback after extension
// handlers decline. These are the bounded grammar distinctions already used
// by the detailed source projector and the two qualified Promise components.
export const BASE_SOURCE_COMPONENT_V8='ordinary-source/1';
export const PROMISE_EXECUTOR_COMPONENT_V8='promise-executor/1';
export const PROMISE_JOIN_COMPONENT_V8='promise-join/1';
export const ASYNC_CALL_COMPONENT_V8='async-scoped-call-source/1';
export const PROMISE_ADOPTION_COMPONENT_V8='promise-adoption/1';
export function sourcePromiseAdoptionEventV8(view,{event}){
  return event.operation==='job.enter'&&['promise-adopt','adoption'].includes(view.owned.control.a0.queue?.[0]?.kind);
}
export function sourceAsyncCallEventV8(view,{event,row}){
  const data=view.components[ASYNC_CALL_COMPONENT_V8];if(!data)return false;
  const owns=frame=>data.calls.some(([id])=>id===frame),raw=event.operands?.[0],callee=raw?.[0]==='method'?raw[1]:raw;
  return event.operation==='call.enter'&&row?.child&&callee?.[0]==='ref'&&view.owned.heap[callee[1]]?.async===true||
    event.operation==='async.await'&&owns(event.invocationId)||
    event.operation==='job.enter'&&view.owned.control.a0.queue?.[0]?.kind==='await'&&owns(view.owned.control.a0.queue[0].frameId);
}
export function sourceAsyncCallAllocationV8(view,input){
  return Object.hasOwn(view.components,ASYNC_CALL_COMPONENT_V8)&&input.kind==='closure'&&input.node?.async===true;
}
export function sourceAsyncCallCompletionV8(view,exit){
  return ['return','throw','unhandled-throw'].includes(exit.operation)&&
    (view.components[ASYNC_CALL_COMPONENT_V8]?.calls??[]).some(([id])=>id===exit.invocation);
}
export const ordinarySourceValueV8=value=>Array.isArray(value)&&
  ['undefined','null','bool','str','num','bigint','ref','promise'].includes(value[0]);
export const sourcePromiseResolverV8=value=>value?.[0]==='builtinfn'?
  /^Promise\.executor\.(resolve|reject):(p[0-9]+)$/.exec(value[1]):null;
export const sourcePromiseConstructorV8=event=>event.operation==='object.construct'&&
  event.operands?.[0]?.[0]==='intrinsic'&&event.operands[0][1]==='Promise';
export function sourcePromiseJoinEventV8(view,{event,row}){
  const callee=row?.operands?.[0],method=callee?.[0]==='method'?callee[1]:callee;
  return event.operation==='call.enter'&&method?.[0]==='builtinfn'&&
    ['Promise.all','Promise.allSettled','Promise.race'].includes(method[1])||
    event.operation==='job.enter'&&view.owned.control.a0.queue?.[0]?.kind==='combinator';
}
export function sourcePromiseExecutorEventV8(view,{event,row}){
  if(promiseObjectSourceEventV8(view,{event,row}))return false;
  const callee=row?.operands?.[0],method=callee?.[0]==='method'?callee[1]:callee;
  return sourcePromiseConstructorV8(event)||event.operation==='call.enter'&&sourcePromiseResolverV8(method)!==null||
    row?.op==='call'&&event.operation!=='job.enter'&&!sharedProtocolSourceEventV8(view,{event,row})&&
      !sourceAsyncCallEventV8(view,{event,row});
}
export function sourceExecutorCompletionV8(view,exit){
  const state=view.components[PROMISE_EXECUTOR_COMPONENT_V8];
  return Boolean(state&&(state.executors.some(([frame])=>frame===exit.invocation)||
    state.calls.some(([frame])=>frame===exit.invocation)));
}
export function sourceJoinAllocationV8(view,input){
  return ['array','object'].includes(input.kind)&&Boolean(view.event)&&sourcePromiseJoinEventV8(view,{event:view.event,row:view.row})&&
    view.event.stateChanges.some(change=>change.table==='heap'&&change.before===null&&change.id===input.identity);
}
const ordinaryFamilies=new Set(['request','observe','await','call','alloc','value','branch','write','read','carry',
  'loop','return','throw','callback','resume']);
export function createBaseSourceComponentV8(){return {id:BASE_SOURCE_COMPONENT_V8,
  claims:{
    value:(_view,value)=>ordinarySourceValueV8(value),
    allocation:(view,fields)=>['object','array','closure','promise'].includes(fields.kind)&&!promiseObjectSourceAllocationV8(view,fields)&&!sourceJoinAllocationV8(view,fields)&&
      !sharedProtocolSourceAllocationV8(view,fields)&&
      !sourceAsyncCallAllocationV8(view,fields)&&
      !(fields.kind==='closure'&&Object.hasOwn(view.components,PROMISE_EXECUTOR_COMPONENT_V8)),
    event(view,input){
      if(promiseObjectSourceEventV8(view,input))return false;
      if(sharedProtocolSourceEventV8(view,input))return false;
      if(sourceAsyncCallEventV8(view,input))return false;
      if(sourcePromiseAdoptionEventV8(view,input))return false;
      if(sourcePromiseConstructorV8(input.event)||sourcePromiseJoinEventV8(view,input))return false;
      const callee=input.row?.operands?.[0],method=callee?.[0]==='method'?callee[1]:callee;
      if(input.event.operation==='call.enter'&&sourcePromiseResolverV8(method))return false;
      if(Object.hasOwn(view.components,PROMISE_EXECUTOR_COMPONENT_V8)&&sourcePromiseExecutorEventV8(view,input))return false;
      return !input.row||ordinaryFamilies.has(input.row.op);
    },
    completion:(view,exit)=>!promiseObjectSourceCompletionV8(view,exit)&&!sharedProtocolSourceCompletionV8(view,exit)&&!sourceAsyncCallCompletionV8(view,exit)&&
      (!['return','throw','unhandled-throw'].includes(exit.operation)||!sourceExecutorCompletionV8(view,exit))
  },
  prepare:{
    value:(_view,value)=>({kind:'ordinary-value',value}),
    allocation:(_view,fields)=>({kind:'ordinary-allocation',fields}),
    event:(_view,{row})=>({kind:'ordinary-event',family:row?.op??'private-machine-transition'}),
    completion:(_view,exit)=>({kind:'ordinary-completion',exit})
  }
};}

// Component discovery is a source grammar decision. Future owned execution
// cannot decide which representation an earlier closure or value receives.
export function sourceHasSyntaxV8({source,bundle},predicate){
  source??=bundle?.sources?.find(row=>row.sourceId===bundle.entrySpec?.sourceId)?.text;
  if(typeof source!=='string')return false;
  function visit(node){
    if(!node||typeof node!=='object')return false;
    if(Array.isArray(node))return node.some(visit);
    if(typeof node.type==='string'&&predicate(node))return true;
    return Object.entries(node).some(([key,child])=>!['start','end','loc','raw'].includes(key)&&visit(child));
  }
  return visit(parse(source,{ecmaVersion:'latest',sourceType:'script'}));
}
