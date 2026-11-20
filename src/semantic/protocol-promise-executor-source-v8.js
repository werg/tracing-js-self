// Resolving functions are identities bound to a public capability. No future
// settlement or callback is used to choose a current public source record.
import {isDeepStrictEqual as eq} from 'node:util';
import {parse} from 'acorn';
import {createPromiseJoinTeacherV8,compilePromiseSourceProjectionV8} from './protocol-promise-join-source-v8.js';
const id='promise-executor/1',copy=structuredClone;
const resolver=value=>value?.[0]==='builtinfn'?/^Promise\.executor\.(resolve|reject):(p[0-9]+)$/.exec(value[1]):null;
const resolverId=(promise,mode)=>promise+mode;
const isConstructor=event=>event.operation==='object.construct'&&event.operands?.[0]?.[0]==='intrinsic'&&event.operands[0][1]==='Promise';
function teacher(){const executors=new Map(),calls=new Map(),constructorSites=new Set();
  function parameters(ctx,event,child,fn,owner){
    const environment=event.stateChanges.find(change=>change.table==='envs'&&change.id===child.envId)?.after;
    if(!environment||environment.parent!==fn.closureEnvId)ctx.refuse('source call environment differs');
    for(const [name,binding]of Object.entries(environment.bindings))if(binding.initialized)
      ctx.emit(owner,'bind',{name:ctx.cell(environment.id,name),value:ctx.tag(binding.token.value)},event,'source-parameter-binding');
  }
  return {id,
  setup(ctx){
    function visit(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}
      if(node.type==='NewExpression'&&node.callee.type==='Identifier'&&node.callee.name==='Promise')constructorSites.add(node.start+':'+node.end);
      for(const [key,child]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))visit(child);
    }visit(parse(ctx.source,{ecmaVersion:'latest',sourceType:'script'}));
  },
  isValue:value=>resolver(value)!==null,
  tag(value){const match=resolver(value);return match?['ref',resolverId(match[2],match[1])]:null;},
  allocation(ctx,event,fields){
    if(fields.kind!=='closure')return null;
    const fn=event?.stateChanges.find(change=>change.table==='heap'&&ctx.identity(change.id)===fields.name)?.after??ctx.state.heap[fields.name];
    if(fn?.kind!=='function')ctx.refuse('source closure allocation lacks its current owned metadata');
    const receiver=fn.arrow?(fn.lexicalThisFrameId?ctx.state.frames[fn.lexicalThisFrameId]?.thisValue:fn.lexicalThis):null;
    return {kind:'allocate',name:fields.name,objectKind:'closure',length:null,properties:[],code:fields.code,
      captures:copy(fields.captures),functionKind:fn.arrow?'arrow':'ordinary',lexicalReceiver:receiver===null?null:ctx.tag(receiver)};
  },
  event(ctx,event,row){
    const owner=ctx.rootFor(event.invocationId);
    if(event.operation==='job.enter'&&event.stateChanges.some(change=>
      change.table==='frames'&&change.before===null&&change.after?.asyncPromiseId))
      ctx.refuse('async Promise callbacks require their resolving-function job protocol');
    if(isConstructor(event)){
      if(!row?.source||!constructorSites.has(row.source.start+':'+row.source.end))ctx.refuse('Promise constructor must be a direct source NewExpression');
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
      executors.set(child.id,{promise,parent:event.invocationId,owner});return true;
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
      parameters(ctx,event,child,fn,owner);ctx.writes(row,owner,event);calls.set(child.id,{owner});return true;
    }
    return false;
  },
  completion(ctx,event,row,fact){
    if(!['return','throw','unhandled-throw'].includes(fact?.operation))return false;
    for(const change of event.stateChanges){
      const frame=change.after;
      if(change.table==='frames'&&frame?.status==='completed'&&frame.completion?.type==='return'&&
        frame.completion.value?.value?.[0]==='promise'&&(frame.asyncPromiseId||frame.reactionPromiseId))
        ctx.refuse('Promise return adoption requires its resolving-function job protocol');
    }
    const invocations=[];
    for(const exit of [fact,...(fact.unwound??[])]){
      const executor=executors.get(exit.invocation),entry=executor??calls.get(exit.invocation);if(!entry)break;
      const changed=event.stateChanges.find(change=>change.table==='frames'&&change.id===exit.invocation&&
        ['completed','thrown'].includes(change.after?.status)),completion=changed?.after.completion;
      if(!['return','throw'].includes(completion?.type)||!completion.value?.value)
        ctx.refuse('source call lacks its completed owned value');
      if(!invocations.length)ctx.writes(row??{},entry.owner,event);
      const invocation=ctx.frameId(exit.invocation),value=ctx.tag(completion.value.value);
      ctx.emitProtocol(entry.owner,executor?{kind:'promise.executor.finish',promise:entry.promise,invocation,
        completion:{kind:completion.type,value}}:{kind:completion.type,invocation,value},event,
        executor?'source-promise-executor-finish/1':'source-promise-helper-completion/1');
      invocations.push(exit.invocation);
    }
    return invocations.length?{invocations}:false;
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
