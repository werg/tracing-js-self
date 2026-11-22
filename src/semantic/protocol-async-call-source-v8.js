// Teacher-only ownership of nested async calls. The selected protocol keeps
// executable source frames, Promise identities and detached scopes distinct.
import {isDeepStrictEqual as eq} from 'node:util';
import {parse} from 'acorn';
import {ASYNC_CALL_COMPONENT_V8 as id,sourceAsyncCallEventV8,sourceAsyncCallAllocationV8,
  sourceAsyncCallCompletionV8,sourceHasSyntaxV8} from './source-projection-base-v8.js';
const copy=structuredClone;

function promiseResolutionLookupSafety(input){
  const source=input.source??input.bundle?.sources?.find(row=>row.sourceId===input.bundle?.entrySpec?.sourceId)?.text;
  if(typeof source!=='string')return {unsafe:false,candidate:false};
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'script'}),visit=(node,fn)=>{
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){for(const child of node)visit(child,fn);return;}
    if(typeof node.type==='string')fn(node);
    for(const [key,child]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))visit(child,fn);
  },propertyName=node=>node?.type==='Identifier'?node.name:
    node?.type==='Literal'&&typeof node.value==='string'?node.value:null,
    path=node=>node?.type==='Identifier'?[node.name]:node?.type==='MemberExpression'?
      [...path(node.object),propertyName(node.property)??'*']:[],
    hasPromiseBinding=pattern=>!pattern?false:pattern.type==='Identifier'?pattern.name==='Promise':
      pattern.type==='RestElement'?hasPromiseBinding(pattern.argument):
      pattern.type==='AssignmentPattern'?hasPromiseBinding(pattern.left):
      pattern.type==='ArrayPattern'?pattern.elements.some(hasPromiseBinding):
      pattern.type==='ObjectPattern'?pattern.properties.some(item=>hasPromiseBinding(item.value??item.argument)):false,
    asyncNames=new Set(),promiseBindings=new Set(),resolverAliases=new Set(),mutatedTargets=new Set();
  let resolverShadow=false,globalMutation=false;
  visit(ast,node=>{
    if(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type)&&node.async){
      if(node.id?.name)asyncNames.add(node.id.name);
    }
    if(node.type==='VariableDeclarator'&&node.id?.type==='Identifier'&&
      ['FunctionExpression','ArrowFunctionExpression'].includes(node.init?.type)&&node.init.async)
      asyncNames.add(node.id.name);
    if(node.type==='VariableDeclarator'&&hasPromiseBinding(node.id)||
      ['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type)&&
      (node.id?.name==='Promise'||node.params?.some(hasPromiseBinding))||
      node.type==='ClassDeclaration'&&node.id?.name==='Promise'||
      node.type==='AssignmentExpression'&&node.left?.type==='Identifier'&&node.left.name==='Promise')
      resolverShadow=true;
    if(node.type==='VariableDeclarator'&&node.id?.type==='Identifier'&&node.init?.type==='MemberExpression'&&
      path(node.init).join('.')==='Promise.resolve')resolverAliases.add(node.id.name);
  });
  const isPromiseExpression=expression=>expression?.type==='Identifier'&&promiseBindings.has(expression.name)||
    expression?.type==='CallExpression'&&(
      expression.callee?.type==='Identifier'&&(asyncNames.has(expression.callee.name)||resolverAliases.has(expression.callee.name))||
      expression.callee?.type==='MemberExpression'&&path(expression.callee).join('.')==='Promise.resolve');
  let extended=true;
  while(extended){
    extended=false;
    visit(ast,node=>{
      if(node.type==='VariableDeclarator'&&node.id?.type==='Identifier'&&isPromiseExpression(node.init)&&
        !promiseBindings.has(node.id.name)){promiseBindings.add(node.id.name);extended=true;}
      if(node.type==='AssignmentExpression'&&node.left?.type==='Identifier'&&isPromiseExpression(node.right)&&
        !promiseBindings.has(node.left.name)){promiseBindings.add(node.left.name);extended=true;}
    });
  }
  const objectHasKey=(object,key)=>object?.type==='ObjectExpression'&&object.properties.some(property=>
    property.type==='SpreadElement'||propertyName(property.key)===key),
    markTarget=target=>{
    const targetPath=path(target);
    if(targetPath[0]==='Promise'){globalMutation=true;return;}
    if(targetPath[0])mutatedTargets.add(targetPath[0]);
  };
  visit(ast,node=>{
    if(node.type==='AssignmentExpression'&&node.left?.type==='MemberExpression'||
      node.type==='UpdateExpression'&&node.argument?.type==='MemberExpression'||
      node.type==='UnaryExpression'&&node.operator==='delete'&&node.argument?.type==='MemberExpression'){
      const member=node.type==='AssignmentExpression'?node.left:
        node.type==='UpdateExpression'?node.argument:node.argument,memberPath=path(member),key=memberPath.at(-1);
      if(memberPath[0]==='Promise'&&(key==='then'||key==='resolve'||key==='*'))globalMutation=true;
      else if(key==='then'||key==='*')markTarget(member.object);
    }
    if(node.type!=='CallExpression'||node.callee?.type!=='MemberExpression')return;
    const method=propertyName(node.callee.property),objectPath=path(node.callee.object),args=node.arguments??[],target=args[0];
    if(['Object','Reflect'].includes(objectPath[0])&&method==='setPrototypeOf')markTarget(target);
    else if(['Object','Reflect'].includes(objectPath[0])&&(method==='defineProperty'||method==='defineProperties')){
      const key=method==='defineProperty'?propertyName(args[1]):null,
        descriptors=method==='defineProperties'?args[1]:null;
      if(key==='then'||key===null&&method==='defineProperty'||method==='defineProperties'&&
        (!descriptors||descriptors.type!=='ObjectExpression'||objectHasKey(descriptors,'then')))markTarget(target);
      if(path(target)[0]==='Promise'&&(key==='resolve'||method==='defineProperties'&&
        (!descriptors||descriptors.type!=='ObjectExpression'||objectHasKey(descriptors,'resolve'))))globalMutation=true;
    }else if(objectPath[0]==='Object'&&method==='assign'){
      if(args.slice(1).some(object=>objectHasKey(object,'then')))markTarget(target);
      if(path(target)[0]==='Promise'&&args.slice(1).some(object=>objectHasKey(object,'resolve')))globalMutation=true;
    }else if(objectPath[0]==='Reflect'&&method==='set'&&
      (propertyName(args[1])==='then'||propertyName(args[1])===null))markTarget(target);
    if(objectPath[0]==='Reflect'&&method==='set'&&path(target)[0]==='Promise'&&
      propertyName(args[1])==='resolve')globalMutation=true;
  });
  const asyncReturnNames=new Set();let asyncPromiseCallReturn=false;
  const inspectReturns=(node,inAsync=false)=>{
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){for(const child of node)inspectReturns(child,inAsync);return;}
    if(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type)){
      inspectReturns(node.body,node.async===true);return;
    }
    if(node.type==='ReturnStatement'&&inAsync&&node.argument){
      if(node.argument.type==='Identifier')asyncReturnNames.add(node.argument.name);
      if(isPromiseExpression(node.argument))asyncPromiseCallReturn=true;
    }
    for(const [key,child]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))inspectReturns(child,inAsync);
  };
  inspectReturns(ast);
  const unsafe=resolverShadow||globalMutation||[...mutatedTargets].some(name=>
    promiseBindings.has(name)||asyncReturnNames.has(name));
  return {unsafe,candidate:asyncPromiseCallReturn||[...asyncReturnNames].some(name=>
    promiseBindings.has(name)||mutatedTargets.has(name))};
}

export function createAsyncCallTeacherV8(){return {id,
  initialize:()=>({calls:[],continuation:0,resolution:0}),
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
      data.calls.push([child.id,{promise,owner,callee:copy(callee),invocation,continuation:null,resolution:null}]);return true;
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
      const queued=ctx.state.control.a0.queue?.[0];
      if(queued?.kind==='promise-adopt'){
        const call=data.calls.find(([,entry])=>entry.promise===queued.promiseId)?.[1],
          state=call?.resolution,controller=call&&ctx.controller(call.owner),
          enter=event.stateChanges.find(change=>change.table==='control')?.before?.queue?.[0];
        if(!call||state?.target!==queued.targetId||state.phase!=='queued'||enter?.kind!=='promise-adopt'||
          enter.promiseId!==call.promise||enter.targetId!==state.target)
          ctx.refuse('async Promise adoption lacks its exact queued source return');
        ctx.emitProtocol(call.owner,{kind:'async.resolve.subscribe',promise:call.promise,
          invocation:call.invocation,target:state.target,job:state.job,
          settlementJob:state.settlementJob},event,'source-async-resolution-subscribe/1');
        state.phase='subscribed';return true;
      }
      if(queued?.kind==='adoption'){
        const call=data.calls.find(([,entry])=>entry.promise===queued.resultId)?.[1],
          state=call?.resolution,target=state&&ctx.state.promises[state.target];
        if(!call||state?.phase!=='subscribed'||state.target!==queued.promiseId||
          !target||!['fulfilled','rejected'].includes(target.status)||
          queued.resultId!==call.promise)
          ctx.refuse('async Promise settlement lacks its exact target observer');
        ctx.emitProtocol(call.owner,{kind:'async.resolve.settle',promise:call.promise,
          invocation:call.invocation,target:state.target,job:state.settlementJob,
          status:target.status,value:ctx.tag(target.value.value)},event,'source-async-resolution-settle/1');
        state.phase='settled';return true;
      }
      const call=data.calls.find(([frame])=>frame===queued?.frameId)?.[1],
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
    const data=ctx.componentState(id),call=data.calls.find(([frame])=>frame===exit.invocation)?.[1],
      frame=event.stateChanges.find(change=>change.table==='frames'&&change.id===exit.invocation)?.after;
    if(!call||!['completed','thrown'].includes(frame?.status)||frame.asyncPromiseId!==call.promise||
      !['return','throw'].includes(frame.completion?.type))ctx.refuse('async source completion lacks its exact retained body outcome');
    ctx.emitProtocol(call.owner,{kind:'async.complete',promise:call.promise,invocation:ctx.frameId(frame.id),
      completion:{kind:frame.completion.type,value:ctx.tag(frame.completion.value.value)}},event,'source-async-complete/1');
    const returned=frame.completion.value.value;
    if(frame.completion.type==='return'&&returned?.[0]==='promise'){
      if(ctx.componentState(id).unsafePromiseResolutionLookup)
        ctx.refuse('async Promise return cannot prove its then lookup and resolver are unmodified');
      const target=returned[1],queued=event.stateChanges.find(change=>change.table==='control')?.after?.queue??[],
        adopted=queued.find(job=>job.kind==='promise-adopt'&&job.promiseId===call.promise&&job.targetId===target),
        targetState=ctx.state.promises[target],publicTarget=ctx.controller(call.owner).heap.get(target);
      if(!adopted||!targetState||!publicTarget||publicTarget.kind!=='promise'||publicTarget.external!==null)
        ctx.refuse('async returned Promise lacks its exact owned assimilation queue entry');
      const controller=ctx.controller(call.owner),fresh=()=>{
        let job;
        do{job='asyncresolve'+(++data.resolution);}while(controller.jobs.has(job)||controller.continuations.has(job));
        return job;
      },job=fresh(),settlementJob=fresh();
      ctx.emitProtocol(call.owner,{kind:'async.resolve.enqueue',promise:call.promise,
        invocation:ctx.frameId(frame.id),target,job,settlementJob},event,'source-async-resolution-enqueue/1');
      call.resolution={target,job,settlementJob,phase:'queued'};
    }
    return true;
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
      if(entry.resolution){
        const resolution=call.resolution,target=controller.heap.get(entry.resolution.target),
          assimilation=controller.jobs.get(entry.resolution.job),settlement=controller.jobs.get(entry.resolution.settlementJob);
        if(phase!=='completed'||frame.completion.type!=='return'||
          !eq(call.completion?.value,['ref',entry.resolution.target])||
          resolution?.target!==entry.resolution.target||resolution.assimilationJob!==entry.resolution.job||
          resolution.settlementJob!==entry.resolution.settlementJob||resolution.phase!==entry.resolution.phase||
          target?.kind!=='promise'||target.external!==null)
          ctx.refuse('async Promise resolution differs from its exact source return');
        if(entry.resolution.phase==='queued'&&
          (assimilation?.reaction!=='async-resolution-enqueue'||assimilation.status!=='queued'||
            !controller.ready.includes(entry.resolution.job)||settlement?.owner!==entry.owner||
            settlement.status!=='reserved'||settlement.promise!==null||
            settlement.reaction!=='async-resolution-reserved'||settlement.closure!==null||
            settlement.rejectionClosure!==null||settlement.target!==entry.promise||settlement.sequence!==null||
            !eq(settlement.asyncResolution,{promise:entry.promise,target:entry.resolution.target,phase:'reserved'})))
          ctx.refuse('async Promise enqueue checkpoint lost its assimilation job');
        if(entry.resolution.phase==='subscribed'&&
          (assimilation?.status!=='completed'||settlement?.reaction!=='async-resolution-settle'||
            settlement.promise!==entry.resolution.target||settlement.target!==entry.promise||
            target.state==='pending'&&settlement.status!=='waiting'||
            target.state!=='pending'&&settlement.status!=='queued'))
          ctx.refuse('async Promise subscription checkpoint lost its target observer');
        if(entry.resolution.phase==='settled'&&
          (settlement?.status!=='completed'||promise.state!==target.state||!eq(promise.result,target.result)))
          ctx.refuse('async Promise settlement checkpoint differs from its target');
      }else if(call.resolution!==null)ctx.refuse('async source Promise resolution has no runtime return');
    }
    return true;
  }
};}

export function createAsyncCallSourceAdapterV8(input={}){
  if(!sourceHasSyntaxV8(input,node=>/Function/.test(node.type)&&node.async===true&&
    (node.type!=='FunctionDeclaration'||node.id?.name!==input.bundle?.entrySpec?.functionName)))return null;
  const {unsafe:unsafePromiseResolutionLookup,candidate}=promiseResolutionLookupSafety(input);
  if(unsafePromiseResolutionLookup&&candidate)
    throw new TypeError('Protocol source projection: async Promise return cannot prove its then lookup and resolver are unmodified');
  const sourceComponent=createAsyncCallTeacherV8();
  sourceComponent.initialize=()=>({calls:[],continuation:0,resolution:0,unsafePromiseResolutionLookup});
  return {id,sourceComponent,sourceProfile:'async-scoped-call-source/1'};
}
