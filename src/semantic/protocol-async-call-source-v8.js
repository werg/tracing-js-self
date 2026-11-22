// Teacher-only ownership of nested async calls. The selected protocol keeps
// executable source frames, Promise identities and detached scopes distinct.
import {isDeepStrictEqual as eq} from 'node:util';
import {ASYNC_CALL_COMPONENT_V8 as id,sourceAsyncCallEventV8,sourceAsyncCallAllocationV8,
  sourceAsyncCallCompletionV8,sourceHasSyntaxV8} from './source-projection-base-v8.js';
const copy=structuredClone;

export function createAsyncCallTeacherV8(){return {id,
  initialize:()=>({calls:[],continuation:0}),
  claims:{event:sourceAsyncCallEventV8,allocation:sourceAsyncCallAllocationV8,completion:sourceAsyncCallCompletionV8},
  prepare:{event:(_view,{event})=>({kind:'async-source-event',event:event.eventId}),
    allocation:(_view,input)=>({kind:'async-source-closure',identity:input.identity}),
    completion:(_view,exit)=>({kind:'async-source-completion',invocation:exit.invocation})},
  allocation(ctx,event,fields){
    const fn=event?.stateChanges.find(change=>change.table==='heap'&&ctx.identity(change.id)===fields.name)?.after??ctx.state.heap[fields.name];
    if(fields.kind!=='closure'||fn?.kind!=='function'||fn.async!==true||ctx.bundle.programs[fn.codeId]?.async!==true||fn.generatorFunction)
      ctx.refuse('async source definition lacks its exact ordinary async function');
    const owner=event?ctx.rootFor(event.invocationId):ctx.rootInvocation,
      receiver=fn.arrow?(fn.lexicalThisFrameId?ctx.state.frames[fn.lexicalThisFrameId]?.thisValue:fn.lexicalThis):null;
    ctx.emitProtocol(owner,{kind:'allocate',name:fields.name,objectKind:'closure',length:null,properties:[],code:fields.code,
      captures:copy(fields.captures),functionKind:fn.arrow?'arrow':'ordinary',lexicalReceiver:receiver===null?null:ctx.tag(receiver)},
      event,'source-async-closure/1');
    ctx.emitProtocol(owner,{kind:'async.function',object:fields.name},event,'source-async-callable/1');
    return true;
  },
  event(ctx,event,row){
    const data=ctx.componentState(id),owner=ctx.rootFor(event.invocationId);
    if(event.operation==='call.enter'){
      const raw=event.operands[0],callee=raw[0]==='method'?raw[1]:raw,fn=ctx.state.heap[callee?.[1]],
        child=event.stateChanges.find(change=>change.table==='frames'&&change.id===row?.child&&change.before===null)?.after,
        promise=child?.asyncPromiseId,ownedPromise=event.stateChanges.find(change=>change.table==='promises'&&change.id===promise&&change.before===null)?.after;
      if(fn?.kind!=='function'||fn.async!==true||!child||child.codeId!==fn.codeId||!promise||ownedPromise?.status!=='pending'||
        data.calls.some(([frame])=>frame===child.id))ctx.refuse('async source call lacks its new exact frame and execution Promise');
      ctx.allocations(row,owner,event);ctx.publishInitialClosure(callee[1],owner,event);
      const invocation=ctx.registerFrame(child.id,owner);
      ctx.emitProtocol(owner,{kind:'async.call',promise,child:invocation,callee:ctx.tag(callee),receiver:ctx.tag(row.receiver),
        arguments:row.arguments.map(ctx.tag)},event,'source-async-call/1');
      const env=event.stateChanges.find(change=>change.table==='envs'&&change.id===child.envId)?.after;
      if(!env||env.parent!==fn.closureEnvId)ctx.refuse('async source parameter environment differs');
      for(const [name,binding]of Object.entries(env.bindings))if(binding.initialized)
        ctx.emit(owner,'bind',{name:ctx.cell(env.id,name),value:ctx.tag(binding.token.value)},event,'source-async-parameter/1');
      data.calls.push([child.id,{promise,owner,callee:copy(callee),continuation:null}]);return true;
    }
    if(event.operation==='async.await'){
      const call=data.calls.find(([frame])=>frame===event.invocationId)?.[1],
        frame=event.stateChanges.find(change=>change.table==='frames'&&change.id===event.invocationId)?.after;
      if(!call||frame?.status!=='suspended'||frame.asyncPromiseId!==call.promise||frame.awaiting!==row.promise)
        ctx.refuse('async await lacks its retained frame and dependency');
      const continuation='asyncwait'+(++data.continuation);
      ctx.emitProtocol(call.owner,{kind:'async.await',promise:call.promise,invocation:ctx.frameId(frame.id),
        awaited:row.promise,continuation},event,'source-async-await/1');call.continuation=continuation;return true;
    }
    if(event.operation==='job.enter'){
      const queued=ctx.state.control.a0.queue?.[0],call=data.calls.find(([frame])=>frame===queued?.frameId)?.[1],
        frame=call&&ctx.state.frames[queued.frameId],awaited=call&&ctx.state.promises[queued.promiseId];
      if(queued?.kind!=='await'||!call||frame.awaiting!==queued.promiseId||frame.asyncPromiseId!==call.promise||
        !['fulfilled','rejected'].includes(awaited?.status)||!call.continuation)
        ctx.refuse('async resume lacks its exact queued dependency');
      ctx.emitProtocol(call.owner,{kind:'async.resume',promise:call.promise,invocation:ctx.frameId(frame.id),
        continuation:call.continuation,status:awaited.status,value:ctx.tag(awaited.value.value)},event,'source-async-resume/1');return true;
    }
    return false;
  },
  completion(ctx,event,_row,exit){
    const call=ctx.componentState(id).calls.find(([frame])=>frame===exit.invocation)?.[1],
      frame=event.stateChanges.find(change=>change.table==='frames'&&change.id===exit.invocation)?.after;
    if(!call||!['completed','thrown'].includes(frame?.status)||frame.asyncPromiseId!==call.promise||
      !['return','throw'].includes(frame.completion?.type))ctx.refuse('async source completion lacks its exact retained body outcome');
    ctx.emitProtocol(call.owner,{kind:'async.complete',promise:call.promise,invocation:ctx.frameId(frame.id),
      completion:{kind:frame.completion.type,value:ctx.tag(frame.completion.value.value)}},event,'source-async-complete/1');return true;
  },
  checkEvent(ctx){
    for(const [identity,entry]of ctx.componentState(id).calls){
      const frame=ctx.state.frames[identity],owned=ctx.state.promises[entry.promise],controller=ctx.controller(entry.owner),
        promise=controller.heap.get(entry.promise),call=promise?.asyncCall;
      if(!frame||frame.asyncPromiseId!==entry.promise||!call||call.invocation!==ctx.frameId(identity)||
        !eq(call.callee,ctx.tag(entry.callee))||promise.state!==owned.status||
        !eq(promise.result,owned.value===null?null:ctx.tag(owned.value.value)))
        ctx.refuse('async execution Promise, callable or source frame differs');
      const phase=frame.status==='suspended'?'suspended':['completed','thrown'].includes(frame.status)?'completed':'running';
      if(call.phase!==phase||!eq(call.receiver,ctx.tag(frame.thisValue)))ctx.refuse('async retained source lifecycle or receiver differs');
      if(phase==='suspended'){
        const continuation=controller.continuations.get(entry.continuation);
        if(call.continuations.at(-1)!==entry.continuation||continuation?.promise!==frame.awaiting)
          ctx.refuse('async retained await dependency differs');
      }
      if(phase==='completed'&&!eq(call.completion,{kind:frame.completion.type,value:ctx.tag(frame.completion.value.value)}))
        ctx.refuse('async retained source completion differs');
    }
    return true;
  }
};}

export function createAsyncCallSourceAdapterV8(input={}){
  if(!sourceHasSyntaxV8(input,node=>/Function/.test(node.type)&&node.async===true&&
    (node.type!=='FunctionDeclaration'||node.id?.name!==input.bundle?.entrySpec?.functionName)))return null;
  return {id,sourceComponent:createAsyncCallTeacherV8(),sourceProfile:'async-scoped-call-source/1'};
}
