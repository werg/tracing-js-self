// Resolving functions are identities bound to a public capability. No future
// settlement or callback is used to choose a current public source record.
import {isDeepStrictEqual as eq} from 'node:util';
import {parse} from 'acorn';
import {createPromiseJoinTeacherV8,compilePromiseSourceProjectionV8} from './protocol-promise-join-source-v8.js';
const id='promise-executor/1',copy=structuredClone;
const resolver=value=>value?.[0]==='builtinfn'?/^Promise\.executor\.(resolve|reject):(p[0-9]+)$/.exec(value[1]):null;
const resolverId=(promise,mode)=>promise+mode;
const isConstructor=event=>event.operation==='object.construct'&&event.operands?.[0]?.[0]==='intrinsic'&&event.operands[0][1]==='Promise';
function teacher(){const executors=new Map(),constructorSites=new Set();return {id,
  setup(ctx){
    function visit(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}
      if(node.type==='NewExpression'&&node.callee.type==='Identifier'&&node.callee.name==='Promise')constructorSites.add(node.start+':'+node.end);
      for(const [key,child]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))visit(child);
    }visit(parse(ctx.source,{ecmaVersion:'latest',sourceType:'script'}));
  },
  isValue:value=>resolver(value)!==null,
  tag(value){const match=resolver(value);return match?['ref',resolverId(match[2],match[1])]:null;},
  event(ctx,event,row){
    const owner=ctx.rootFor(event.invocationId);
    if(isConstructor(event)){
      if(!row?.source||!constructorSites.has(row.source.start+':'+row.source.end))ctx.refuse('Promise constructor must be a direct source NewExpression');
      const child=event.stateChanges.find(change=>change.table==='frames'&&change.before===null)?.after,
        promise=child?.promiseExecutorTarget,executor=event.operands[1],fn=ctx.state.heap[executor?.[1]],
        parent=event.stateChanges.find(change=>change.table==='frames'&&change.id===event.invocationId)?.after;
      if(!promise||fn?.kind!=='function'||fn.async||ctx.bundle.programs[fn.codeId]?.generator||
        child.asyncPromiseId||parent?.pendingPromiseExecutor?.waitingFrameId!==child.id||
        parent.pendingPromiseExecutor.promiseId!==promise||row?.child!==child.id||
        ctx.controller(owner).activeJob)ctx.refuse('Promise executor requires a synchronous source closure and an ordinary active caller');
      ctx.allocations(row,owner,event);
      const invocation=ctx.registerFrame(child.id,owner),resolve=resolverId(promise,'resolve'),reject=resolverId(promise,'reject');
      ctx.emitProtocol(owner,{kind:'promise.executor.enter',promise,executor:ctx.tag(executor),child:invocation,resolve,reject},event,'source-promise-executor-enter/1');
      const environment=event.stateChanges.find(change=>change.table==='envs'&&change.id===child.envId)?.after;
      if(!environment||environment.parent!==fn.closureEnvId)ctx.refuse('executor source environment differs');
      for(const [name,binding]of Object.entries(environment.bindings))if(binding.initialized)
        ctx.emit(owner,'bind',{name:ctx.cell(environment.id,name),value:ctx.tag(binding.token.value)},event,'executor-parameter-binding');
      executors.set(child.id,{promise,parent:event.invocationId,owner});return true;
    }
    const callee=row?.operands?.[0],method=callee?.[0]==='method'?callee[1]:callee,match=resolver(method);
    if(event.operation==='call.enter'&&match){
      if(row?.child||row.result?.[0]!=='undefined')ctx.refuse('resolver call has an unexpected guest invocation or result');
      ctx.emitProtocol(owner,{kind:'promise.resolver.call',resolver:ctx.tag(method),value:ctx.tag(row.operands[1]??['undefined'])},event,'source-promise-resolver-call/1');
      ctx.writes(row,owner,event);return true;
    }
    return false;
  },
  completion(ctx,event,row,fact){
    const entry=executors.get(event.invocationId);if(!entry)return false;
    const changed=event.stateChanges.find(change=>change.table==='frames'&&change.id===event.invocationId&&['completed','thrown'].includes(change.after?.status));
    if(!changed)return false;
    if(!['return','throw','unhandled-throw'].includes(fact?.operation)||fact.unwound?.length)
      ctx.refuse('executor completion requires its direct owned return or throw');
    const completion=changed.after.completion;
    if(!['return','throw'].includes(completion?.type)||!completion.value?.value)
      ctx.refuse('executor lacks its completed source value');
    ctx.writes(row??{},entry.owner,event);
    ctx.emitProtocol(entry.owner,{kind:'promise.executor.finish',promise:entry.promise,invocation:ctx.frameId(event.invocationId),
      completion:{kind:completion.type,value:ctx.tag(completion.value.value)}},event,'source-promise-executor-finish/1');
    return true;
  },
  checkEvent(ctx,event){
    const controller=ctx.controller(ctx.rootInvocation),data=controller.protocol?.promiseExecutors;
    if(!data)return true;
    for(const change of event.stateChanges){
      if(change.table==='promises'&&change.after){
        const cap=data.capabilities.find(row=>row.promise===change.id);if(!cap)continue;
        const selected=controller.heap.get(change.id),owned=change.after;
        if(cap.called!==owned.resolverCalled||selected.state!==owned.status||
          !eq(selected.result,owned.value===null?null:ctx.tag(owned.value.value))||owned.status==='pending'&&selected.adopted!==(owned.adopting??null))
          ctx.refuse('executor first-call cell, adoption or settlement differs from current owned state');
        if(owned.thenableLocked||owned.thenableSerial||owned.thenableSeen?.length)
          ctx.refuse('thenable resolving state requires its separate protocol');
      }
      if(change.table==='frames'&&change.after){
        const owned=change.after,pending=owned.pendingPromiseExecutor;
        if(pending){const entry=data.executors.find(row=>row.promise===pending.promiseId);
          if(!entry||entry.phase!=='running'||entry.child!==ctx.frameId(pending.waitingFrameId)||entry.parent!==ctx.frameId(owned.id))
            ctx.refuse('executor continuation differs from current owned parent');}
        const target=owned.promiseExecutorTarget;if(target){const entry=data.executors.find(row=>row.promise===target);
          if(!entry||entry.child!==ctx.frameId(owned.id)||(entry.phase==='complete')!==(['completed','thrown'].includes(owned.status)))
            ctx.refuse('executor frame lifecycle differs from owned completion');}
      }
    }
    return true;
  }
};}
export function createPromiseExecutorSourceAdapterV8({bundle}={}){
  if(!bundle?.events?.some(isConstructor))return null;
  const joins=bundle.events.some(event=>event.operation==='call.enter'&&['Promise.all','Promise.race'].includes(
    event.operands?.[0]?.[0]==='method'?event.operands[0][1]?.[1]:event.operands?.[0]?.[1]));
  return {id,compile({maxGenerated}){return compilePromiseSourceProjectionV8(bundle,{maxGenerated,
    extensions:[teacher(),createPromiseJoinTeacherV8()],sourceProfile:'promise-executors-source/1',
    extensionIds:[id,...(joins?['promise-join/1']:[])]});}};
}
