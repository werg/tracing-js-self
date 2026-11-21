// Resolving functions are identities bound to a public capability. No future
// settlement or callback is used to choose a current public source record.
import {isDeepStrictEqual as eq} from 'node:util';
import {parse} from 'acorn';
import {sourcePromiseResolverV8,sourcePromiseConstructorV8,sourcePromiseExecutorEventV8,
  sourceExecutorCompletionV8,sourceHasSyntaxV8} from './source-projection-base-v8.js';
const id='promise-executor/1',copy=structuredClone;
const resolver=sourcePromiseResolverV8;
const resolverId=(promise,mode)=>promise+mode;
const isConstructor=sourcePromiseConstructorV8;
export function createPromiseExecutorTeacherV8(){
  function parameters(ctx,event,child,fn,owner){
    const environment=event.stateChanges.find(change=>change.table==='envs'&&change.id===child.envId)?.after;
    if(!environment||environment.parent!==fn.closureEnvId)ctx.refuse('source call environment differs');
    for(const [name,binding]of Object.entries(environment.bindings))if(binding.initialized)
      ctx.emit(owner,'bind',{name:ctx.cell(environment.id,name),value:ctx.tag(binding.token.value)},event,'source-parameter-binding');
  }
  return {id,
  initialize(view){
    const constructorSites=[];
    function visit(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}
      if(node.type==='NewExpression'&&node.callee.type==='Identifier'&&node.callee.name==='Promise')constructorSites.push(node.start+':'+node.end);
      for(const [key,child]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))visit(child);
    }visit(parse(view.source,{ecmaVersion:'latest',sourceType:'script'}));
    return {executors:[],calls:[],constructorSites};
  },
  claims:{
    value:(_view,value)=>resolver(value)!==null,
    allocation:(_view,input)=>input.kind==='closure',
    event:sourcePromiseExecutorEventV8,
    completion:(view,exit)=>['return','throw','unhandled-throw'].includes(exit.operation)&&sourceExecutorCompletionV8(view,exit)
  },
  prepare:{
    value:(_view,value)=>({kind:'resolving-function-value',value}),
    allocation:(_view,input)=>({kind:'source-closure',identity:input.identity}),
    event:(_view,input)=>({kind:'executor-event',operation:input.event.operation}),
    completion:(_view,exit)=>({kind:'executor-scope-exit',invocation:exit.invocation})
  },
  tag(_ctx,value){const match=resolver(value);return match?['ref',resolverId(match[2],match[1])]:null;},
  allocation(ctx,event,fields){
    if(fields.kind!=='closure')return null;
    const fn=event?.stateChanges.find(change=>change.table==='heap'&&ctx.identity(change.id)===fields.name)?.after??ctx.state.heap[fields.name];
    if(fn?.kind!=='function')ctx.refuse('source closure allocation lacks its current owned metadata');
    const receiver=fn.arrow?(fn.lexicalThisFrameId?ctx.state.frames[fn.lexicalThisFrameId]?.thisValue:fn.lexicalThis):null;
    return {kind:'allocate',name:fields.name,objectKind:'closure',length:null,properties:[],code:fields.code,
      captures:copy(fields.captures),functionKind:fn.arrow?'arrow':'ordinary',lexicalReceiver:receiver===null?null:ctx.tag(receiver)};
  },
  event(ctx,event,row){
    const owner=ctx.rootFor(event.invocationId),{executors,calls,constructorSites}=ctx.componentState(id);
    if(isConstructor(event)){
      if(!row?.source||!constructorSites.includes(row.source.start+':'+row.source.end))ctx.refuse('Promise constructor must be a direct source NewExpression');
      const child=event.stateChanges.find(change=>change.table==='frames'&&change.before===null)?.after,
        promise=child?.promiseExecutorTarget,executor=event.operands[1],fn=ctx.state.heap[executor?.[1]],
        parent=event.stateChanges.find(change=>change.table==='frames'&&change.id===event.invocationId)?.after;
      if(!promise||fn?.kind!=='function'||fn.async||ctx.bundle.programs[fn.codeId]?.generator||
        child.asyncPromiseId||parent?.pendingPromiseExecutor?.waitingFrameId!==child.id||
        parent.pendingPromiseExecutor.promiseId!==promise||row?.child!==child.id)
        ctx.refuse('Promise executor requires a synchronous source closure');
      ctx.allocations(row,owner,event);
      ctx.publishInitialClosure(executor[1],owner,event);
      const invocation=ctx.registerFrame(child.id,owner),resolve=resolverId(promise,'resolve'),reject=resolverId(promise,'reject');
      ctx.emitProtocol(owner,{kind:'promise.executor.enter',promise,executor:ctx.tag(executor),child:invocation,resolve,reject},event,'source-promise-executor-enter/1');
      parameters(ctx,event,child,fn,owner);
      executors.push([child.id,{promise,parent:event.invocationId,owner}]);return true;
    }
    const callee=row?.operands?.[0],method=callee?.[0]==='method'?callee[1]:callee,match=resolver(method);
    if(event.operation==='call.enter'&&match){
      if(row?.child||row.result?.[0]!=='undefined')ctx.refuse('resolver call has an unexpected guest invocation or result');
      ctx.emitProtocol(owner,{kind:'promise.resolver.call',resolver:ctx.tag(method),value:ctx.tag(row.operands[1]??['undefined'])},event,'source-promise-resolver-call/1');
      ctx.writes(row,owner,event);return true;
    }
    if(row?.op==='call'&&event.operation!=='job.enter'){
      const fn=method?.[0]==='ref'?ctx.state.heap[method[1]]:null,
        child=event.stateChanges.find(change=>change.table==='frames'&&change.id===row.child&&change.before===null)?.after;
      if(event.operation!=='call.enter'||fn?.kind!=='function'||fn.async||ctx.bundle.programs[fn.codeId]?.generator||
        !child||child.asyncPromiseId)ctx.refuse('Promise source helper requires a synchronous owned closure');
      ctx.allocations(row,owner,event);ctx.publishInitialClosure(method[1],owner,event);
      const invocation=ctx.registerFrame(child.id,owner);
      ctx.emitProtocol(owner,{kind:'call',child:invocation,callee:ctx.tag(method),receiver:ctx.tag(row.receiver),
        arguments:row.arguments.map(ctx.tag)},event,'source-promise-helper-call/1');
      parameters(ctx,event,child,fn,owner);ctx.writes(row,owner,event);calls.push([child.id,{owner}]);return true;
    }
    return false;
  },
  completion(ctx,event,row,exit){
      const {executors,calls}=ctx.componentState(id),executor=executors.find(([frame])=>frame===exit.invocation)?.[1],
        entry=executor??calls.find(([frame])=>frame===exit.invocation)?.[1];if(!entry)return false;
      const changed=event.stateChanges.find(change=>change.table==='frames'&&change.id===exit.invocation&&
        ['completed','thrown'].includes(change.after?.status)),completion=changed?.after.completion;
      if(!['return','throw'].includes(completion?.type)||!completion.value?.value)
        ctx.refuse('source call lacks its completed owned value');
      const invocation=ctx.frameId(exit.invocation),value=ctx.tag(completion.value.value);
      ctx.emitProtocol(entry.owner,executor?{kind:'promise.executor.finish',promise:entry.promise,invocation,
        completion:{kind:completion.type,value}}:{kind:completion.type,invocation,value},event,
        executor?'source-promise-executor-finish/1':'source-promise-helper-completion/1');
      return true;
  },
  checkEvent(ctx,event){
    if(event.operation==='job.enter'&&event.stateChanges.some(change=>
      change.table==='frames'&&change.before===null&&change.after?.asyncPromiseId))
      ctx.refuse('async Promise callbacks require their resolving-function job protocol');
    const controller=ctx.controller(ctx.rootInvocation),data=controller.protocol?.promiseExecutors;
    for(const change of event.stateChanges){
      const completed=change.after;
      if(change.table==='frames'&&completed?.status==='completed'&&completed.completion?.type==='return'&&
        completed.completion.value?.value?.[0]==='promise'&&(completed.asyncPromiseId||completed.reactionPromiseId))
        ctx.refuse('Promise return adoption requires its resolving-function job protocol');
      if(change.table==='frames'&&change.after?.status==='running'&&
        ctx.frameId(change.id)===controller.stack.at(-1)&&
        !eq(controller.receiver??['undefined'],ctx.tag(change.after.thisValue)))
        ctx.refuse('public source call receiver differs from current owned frame');
      if(!data)continue;
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
export function createPromiseExecutorSourceAdapterV8(input={}){
  if(!sourceHasSyntaxV8(input,node=>node.type==='NewExpression'&&
    node.callee.type==='Identifier'&&node.callee.name==='Promise'))return null;
  return {id,sourceComponent:createPromiseExecutorTeacherV8(),sourceProfile:'promise-executors-source/1'};
}
