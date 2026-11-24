// Teacher-only allocation/access adapter. Traps enter the existing shared
// invocation stack; no adapter executes a callback or supplies its result.
import {stringPropertyKey,symbolPropertyKey} from '../property-keys.js';
import {ordinaryGet} from '../spec-operations.js';
export const PROXY_SOURCE_PROFILE_V8='ordinary-data-proxy-source/1';
const fields=['targetId','handlerId','properties','propertyVersions','shapeVersion'];
const truthy=value=>value?.[0]==='ref'||value?.[0]==='symbol'||
  !['undefined','null'].includes(value?.[0])&&(value?.[0]==='bool'?value[1]:
    value?.[0]==='num'?Number(value[1])!==0&&!Number.isNaN(Number(value[1])):
    value?.[0]==='bigint'?BigInt(value[1])!==0n:value?.[0]==='str'?value[1].length>0:true);
export function createProxySourceAdapterV8(){
  let active=new Map(),callbacks=new Map(),getMethods=new Map(),getMethodCallbacks=new Map(),getterCandidates=new Set(),faultEvidence=new Map(),revokers=new Map(),next=0;
  const require=(ctx,condition,message)=>{if(!condition)ctx.refuse('Proxy source: '+message);};
  const freshTypeError=(event,value)=>value?.[0]==='ref'&&event.stateChanges.some(change=>
    change.table==='heap'&&change.id===value[1]&&change.before===null&&change.after?.declaredError==='TypeError');
  const faultToken=owner=>{
    if(owner?.completion?.type==='throw'&&owner.completion.value?.value?.[0]==='ref')return owner.completion.value;
    for(const handler of [...(owner?.handlers??[])].reverse()){
      if(handler.caught?.value?.[0]==='ref')return handler.caught;
      if(handler.pending?.type==='throw'&&handler.pending.value?.value?.[0]==='ref')return handler.pending.value;
    }
    return null;
  };
  const requireFaultError=(ctx,event,row,error,origin)=>{
    const changes=event.stateChanges.filter(change=>change.table==='heap'&&change.before===null&&
      change.id===error[1]&&change.after?.declaredError==='TypeError'),node=changes[0]?.after,
      allocation=row?.allocations?.filter(item=>item.identity===error[1])??[],properties=node?.properties??{},
      currentOrigin=event.operation==='call.return'?event.stateChanges.find(change=>
        change.table==='frames'&&change.id===event.invocationId)?.after?.completion?.value?.origin:event.eventId;
    const nativeCompletion=event.completion;
    require(ctx,changes.length===1&&allocation.length===1&&node.kind==='object'&&
      node.prototype==='TypeError.prototype'&&!Object.hasOwn(properties,'name')&&
      ctx.eq(node.dataAttributes?.message,{writable:true,enumerable:false,configurable:true})&&
      properties.message?.value?.[0]==='str'&&properties.message.origin===origin&&
      currentOrigin===origin&&allocation[0].kind==='object'&&allocation[0].properties?.length===1&&
      allocation[0].properties.some(item=>item.key==='message'&&ctx.eq(item.value,properties.message.value))&&
      (event.operation==='call.return'?origin===event.stateChanges.find(change=>
        change.table==='frames'&&change.id===event.invocationId)?.after?.completion?.value?.origin:
        nativeCompletion?.type==='throw'&&nativeCompletion.errorType==='TypeError'&&
        nativeCompletion.origin===event.eventId&&nativeCompletion.value?.origin===event.eventId&&
        ctx.eq(nativeCompletion.value?.value,error)),
      'operation fault lacks its exact fresh TypeError allocation and source origin');
    return node;
  };
  const publicFaultMessage=(ctx,id,message)=>{
    const node=ctx.controller.heap.get(id),actual=node?.properties instanceof Map?node.properties.get('message'):null;
    require(ctx,node?.kind==='object'&&node.declaredError==='TypeError'&&ctx.eq(actual,message),
      'derived Proxy TypeError message differs from its source allocation');
  };
  const emit=(ctx,record,event)=>ctx.emit(record,event,'owned-proxy-operation/1');
  const routeFor=(ctx,object,operation,event)=>{
    const route=[],observations=[],visited=new Set();let identity=object?.[1],node=ctx.state.heap[identity],selected=['undefined'];
    const name=operation==='delete'?'deleteProperty':operation;
    while(node?.kind==='proxy'){
      require(ctx,!visited.has(identity)&&route.length<64,'cyclic or excessive retained target route');visited.add(identity);
      require(ctx,node.targetId!==null&&node.handlerId!==null,'revoked route requires its derived TypeError boundary');
      const target=['ref',node.targetId],handler=['ref',node.handlerId],found=ordinaryGet(ctx.state.heap,handler,name);
      require(ctx,!!found,'handler trap getter requires its explicit continuation');
      selected=ctx.tag(found.method.value,event);
      route.push({object:identity,target,handler,method:selected});observations.push(found.observation);
      if(!['undefined','null'].includes(selected[0]))break;
      identity=node.targetId;node=ctx.state.heap[identity];
    }
    require(ctx,node&&['object','array','proxy'].includes(node.kind),'target internal method is not in the bounded route profile');
    return {route,observations,owner:route.at(-1)?.object??null,
      target:route.at(-1)?.target??['ref',node.id],handler:route.at(-1)?.handler??null,selected,terminal:node};
  };
  const ownHasGetterRoute=(ctx,object,event)=>{
    const node=object?.[0]==='ref'?ctx.state.heap[object[1]]:null;
    require(ctx,node?.kind==='proxy'&&node.targetId!==null&&node.handlerId!==null,
      'has getter requires a live direct Proxy');
    const target=['ref',node.targetId],handler=['ref',node.handlerId],handlerNode=ctx.state.heap[handler[1]],
      found=ordinaryGet(ctx.state.heap,handler,'has',{accessors:true}),descriptor=handlerNode?.accessors?.has,
      getter=descriptor?.get?.value;
    require(ctx,!!found?.accessor&&!!descriptor&&getter?.[0]==='ref'&&ctx.eq(found.accessor.get?.value,getter),
      'has GetMethod is limited to its exact own accessor getter');
    const route=[{object:node.id,target,handler,method:['undefined']}];
    return {object,target,handler,owner:node.id,getter:ctx.tag(getter,event),route,observation:found.observation};
  };
  return {id:PROXY_SOURCE_PROFILE_V8,
  captureState:()=>({active:[...active],callbacks:[...callbacks],getMethods:[...getMethods],
    getMethodCallbacks:[...getMethodCallbacks],getterCandidates:[...getterCandidates],
    faultEvidence:[...faultEvidence],revokers:[...revokers],next}),
  restoreState(state){active=new Map(state.active);callbacks=new Map(state.callbacks);getMethods=new Map(state.getMethods??[]);
    getMethodCallbacks=new Map(state.getMethodCallbacks??[]);getterCandidates=new Set(state.getterCandidates??[]);
    faultEvidence=new Map(state.faultEvidence??[]);revokers=new Map(state.revokers??[]);next=state.next;},
  syntax(node){return node.type==='NewExpression'&&node.callee.type==='Identifier'&&node.callee.name==='Proxy'||
    node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&!node.callee.computed&&
    node.callee.object.type==='Identifier'&&node.callee.object.name==='Proxy'&&node.callee.property.name==='revocable';},
  normalizeTag(_ctx,value){
    const prior=value?.[0]==='builtinfn'?revokers.get(value[1]):null;
    return prior?['ref',prior.revoke]:undefined;
  },
  heapFields(node){return node.kind==='proxy'?fields:null;},
  beforeEvent(ctx,event,row){
    if(event.operation==='primitive.binary'&&row?.child){
      const parent=event.stateChanges.find(change=>change.table==='frames'&&change.id===event.invocationId)?.after;
      if(parent?.pendingProperty?.kind==='proxy-get-method')getterCandidates.add(row.child);
    }
  },
  frameFields(node){return node.pendingProperty?.proxy||node.pendingProperty?.kind==='proxy-get-method'?['pendingProperty']:
    getterCandidates.has(node.id)||getMethodCallbacks.has(node.id)?[]:null;},
  checkHeap(ctx,node){
    if(Object.keys(node.properties??{}).length||Object.keys(node.propertyVersions??{}).length||node.shapeVersion!==0)
      ctx.refuse('Proxy has undeclared own storage');
    return ctx.eq(ctx.controller.heap.get(node.id),{kind:'proxy',target:node.targetId===null?['null']:['ref',node.targetId],
      handler:node.handlerId===null?['null']:['ref',node.handlerId],properties:new Map()});
  },
  allocate(ctx,node){if(node.kind==='proxy')ctx.refuse('Proxy allocation must follow its source constructor');return false;},
  event(ctx,event,row){
    if(event.operation==='call.return'&&getMethodCallbacks.has(event.invocationId))return true;
    if(event.operation==='call.return'&&callbacks.has(event.invocationId)){
      const entry=callbacks.get(event.invocationId),owner=event.stateChanges.find(item=>
        item.table==='frames'&&item.id===entry.owner)?.after,token=faultToken(owner),
        child=event.stateChanges.find(item=>item.table==='frames'&&item.id===event.invocationId)?.after;
      if(token?.value?.[0]==='ref'&&freshTypeError(event,token.value)){
        const returned=child?.completion?.type==='return'?child.completion.value:null,
          retained=ctx.getOwnedFrame(event.invocationId)?.stack?.at(-1);
        require(ctx,returned&&ctx.eq(retained,returned)&&token.origin===returned.origin&&event.operandOrigins?.[0]===returned.origin,
          'Proxy fault is not tied to its retained normal callback completion');
        const node=requireFaultError(ctx,event,row,token.value,returned.origin);
        faultEvidence.set(entry.id,{error:token.value[1],origin:returned.origin,
          message:ctx.copy(node.properties.message.value)});
      }
      for(const change of event.stateChanges.filter(item=>item.table==='heap'&&item.before===null&&
        item.after?.declaredError!=='TypeError'))ctx.publish(change.after,event);
      return true;
    }
    if(event.operation==='proxy.revocable.allocate'){
      const proxyChange=event.stateChanges.find(change=>change.table==='heap'&&change.before===null&&change.after?.kind==='proxy'),
        wrapperChange=event.stateChanges.find(change=>change.table==='heap'&&change.id===event.result?.[1]&&change.after?.kind==='object'),
        wrapper=wrapperChange?.after??null,proxyNode=proxyChange?.after,proxyRef=proxyNode?['ref',proxyChange.id]:null,
        revoke=wrapper?.properties?.revoke?.value,code='Proxy.revoke:'+proxyChange?.id,
        revokeId='proxyrevoker'+proxyChange?.id,target=event.operands[0],handler=event.operands[1];
      if(!proxyNode||event.operands.length!==2||wrapper?.kind!=='object'||
        !ctx.eq(wrapper.properties.proxy?.value,proxyRef)||!ctx.eq(revoke,['builtinfn',code])||
        Object.keys(wrapper.properties).sort().join(',')!=='proxy,revoke'||proxyNode.targetId!==target[1]||
        proxyNode.handlerId!==handler[1])
        ctx.refuse('Proxy.revocable allocation lacks its exact proxy/revoker result');
      emit(ctx,{kind:'proxy.revocable',proxy:proxyChange.id,revoke:revokeId,result:wrapper.id,
        target:ctx.tag(target,event),handler:ctx.tag(handler,event)},event);
      revokers.set(code,{proxy:proxyChange.id,result:wrapper.id,revoke:revokeId});
      ctx.markPublished(proxyChange.id);ctx.markPublished(revokeId);ctx.markPublished(wrapper.id);return true;
    }
    if(event.operation==='property.read'){
      const base=row?.operands?.[0],key=row?.operands?.[1],selected=row?.result?.[0]==='method'?row.result[1]:row?.result,
        code=selected?.[0]==='builtinfn'&&selected[1].startsWith('Proxy.revoke:')?selected[1]:null,
        prior=code&&revokers.get(code);
      if(prior&&base?.[0]==='ref'&&base[1]===prior.result&&ctx.eq(key,['str','revoke'])){
        emit(ctx,{kind:'property.get',object:prior.result,key:['str','revoke'],receiver:ctx.tag(base,event),
          result:['ref',prior.revoke]},event,'owned-source-property-read/1');return true;
      }
    }
    if(event.operation==='call.enter'){
      const selected=getMethods.get(event.invocationId);
      if(selected?.phase==='returned'){
        const parentChange=event.stateChanges.find(change=>change.table==='frames'&&change.id===event.invocationId),
          before=parentChange?.before,after=parentChange?.after,prior=before?.pendingProperty?.proxyGetMethod,
          pending=after?.pendingProperty,method=selected.method;
        require(ctx,event.siteId===selected.siteId&&before?.pendingProperty?.kind==='proxy-get-method'&&
          before.pendingProperty.phase==='getter-returned'&&prior&&prior.object?.[1]===selected.object&&
          ctx.eq(prior.target,selected.target)&&ctx.eq(prior.handler,selected.handler)&&
          ctx.eq(prior.keyValue,selected.key)&&ctx.eq(prior.getter,selected.getter),
          'GetMethod resume differs from its retained getter selection');
        if(method[0]==='undefined'){
          const result=event.result??row?.result;
          require(ctx,!pending&&event.stateChanges.every(change=>change.table!=='frames'||change.id===event.invocationId)&&
            result?.[0]==='bool','nullish GetMethod must transparently continue the saved has target');
          emit(ctx,{kind:'proxy.has',id:selected.id,object:selected.object,key:selected.key,
            result:ctx.tag(result,event),route:selected.route},event);
          getMethods.delete(event.invocationId);return true;
        }
        const child=pending?.proxy&&pending.waitingFrameId?
            event.stateChanges.find(change=>change.table==='frames'&&change.id===pending.waitingFrameId)?.after:null,
          route=selected.route.map((item,index)=>index===selected.route.length-1?{...item,method}:item),
          parentProgram=ctx.bundle.programs[after?.codeId],
          parentInstruction=parentProgram?.instructions.find(instruction=>instruction.siteId===event.siteId);
        require(ctx,child&&pending.kind==='has'&&pending.proxy.strict===false&&
          parentInstruction?.op==='BINARY'&&parentInstruction.arg==='in'&&
          pending.proxy.owner===selected.object&&ctx.eq(pending.proxy.object,['ref',selected.object])&&
          ctx.eq(pending.proxy.target,selected.target)&&ctx.eq(pending.proxy.handler,selected.handler)&&
          ctx.eq(pending.proxy.route,route)&&ctx.eq(selected.route.at(-1)?.method,['undefined']),
          'selected has trap lost its retained GetMethod target or route');
        const invocation=ctx.frame(child.id),receiver=['ref',selected.object];
        emit(ctx,{kind:'proxy.has.call',id:selected.id,object:selected.object,owner:selected.trapOwner,
          receiver,key:selected.key,child:invocation,route},event);
        require(ctx,ctx.eq(ctx.controller.receiver,child.thisValue),'has trap effective receiver differs');
        const call=ctx.controller.protocol.proxyCalls.pending.at(-1),fn=ctx.state.heap[method[1]],
          program=ctx.bundle.programs[fn?.codeId],
          environment=event.stateChanges.find(change=>change.table==='envs'&&change.id===child.envId)?.after,
          args=[call.target,selected.key];
        require(ctx,fn?.kind==='function'&&!fn.async&&!program.generator&&child.codeId===fn.codeId&&
          environment?.parent===fn.closureEnvId,'selected has trap must retain its synchronous source closure');
        require(ctx,program.params.every((name,index)=>environment.bindings[name]?.initialized&&
          ctx.eq(environment.bindings[name].token?.value,args[index]??['undefined'])),
          'selected has trap parameters differ from native arguments');
        for(const [name,binding]of Object.entries(environment?.bindings??{}))if(binding.initialized)
          ctx.bind(ctx.cell(environment.id,name),binding.token.value,event);
        const entry={id:selected.id,owner:event.invocationId,child:child.id,object:selected.object,
          trapOwner:selected.trapOwner,receiver,key:selected.key,operation:'has',strict:false,value:null,route};
        active.set(event.invocationId,entry);callbacks.set(child.id,entry);
        getMethods.delete(event.invocationId);return true;
      }
      const raw=event.operands?.[0],callee=raw?.[0]==='method'?raw[1]:raw,
        code=callee?.[0]==='builtinfn'&&callee[1].startsWith('Proxy.revoke:')?callee[1]:null,
        prior=code&&revokers.get(code),identity=prior?.proxy,
        change=identity&&event.stateChanges.find(item=>item.table==='heap'&&item.id===identity),
        after=change?.after??(identity?ctx.state.heap[identity]:null);
      if(prior){
        require(ctx,after?.kind==='proxy'&&after.targetId===null&&after.handlerId===null&&
          (!change||change.before?.kind==='proxy'&&change.before.targetId!==null&&change.before.handlerId!==null&&
            change.after?.targetId===null&&change.after?.handlerId===null)&&
          event.stateChanges.every(item=>item.table!=='heap'||item.id===identity),
          'revoker call did not clear the retained Proxy internal slots');
        emit(ctx,{kind:'proxy.revoke',object:identity},event);return true;
      }
    }
    if(event.operation==='proxy.allocate'){
      const node=event.stateChanges.find(change=>change.table==='heap'&&change.before===null&&change.id===event.result?.[1])?.after;
      if(node?.kind!=='proxy'||event.operands.length!==2||event.completion?.type==='throw')
        ctx.refuse('Proxy source allocation lacks its target and handler');
      emit(ctx,{kind:'proxy.create',name:node.id,target:ctx.tag(event.operands[0],event),handler:ctx.tag(event.operands[1],event)},event);
      ctx.markPublished(node.id);return true;
    }
    const sourceFrame=ctx.getOwnedFrame(event.invocationId),instruction=ctx.bundle.programs[sourceFrame?.codeId]?.instructions[sourceFrame?.pc],
      has=event.operation==='primitive.binary'&&instruction?.op==='BINARY'&&instruction.arg==='in',
      deletion=event.operation==='property.delete',property=event.operation==='property.read'||event.operation==='property.write',
      stack=sourceFrame?.stack??[],
      directStack=event.completion?.type==='throw'&&instruction?.op==='DELETE_PROP'?stack:[],
      failedRead=event.completion?.type==='throw'&&['GET_PROP','GET_METHOD'].includes(instruction?.op)?stack:[],
      failedWrite=event.completion?.type==='throw'&&instruction?.op==='PUT_PROP'?stack:[],
      failedHas=event.completion?.type==='throw'&&has?stack:[],
      base=has?row?.operands?.[1]??failedHas.at(-1)?.value:
        row?.operands?.[0]??directStack.at(-2)?.value??failedRead.at(-2)?.value??failedWrite.at(-3)?.value,
      node=base?.[0]==='ref'?ctx.state.heap[base[1]]:null;
    if(node?.kind!=='proxy'||!property&&!has&&!deletion)return false;
    const key=ctx.key(has?row?.operands?.[0]??failedHas.at(-2)?.value:
      row?.operands?.[1]??directStack.at(-1)?.value??failedRead.at(-1)?.value??failedWrite.at(-2)?.value);
    if(has&&row?.child){
      const parent=event.stateChanges.find(change=>change.table==='frames'&&change.id===event.invocationId)?.after,
        pending=parent?.pendingProperty;
      if(pending?.kind==='proxy-get-method'){
        const selection=pending.proxyGetMethod,route=ownHasGetterRoute(ctx,base,event),
          child=event.stateChanges.find(change=>change.table==='frames'&&change.id===row.child)?.after,
          getter=ctx.tag(selection?.getter,event),id='proxygetmethod'+(++next),childToken=child&&ctx.frame(child.id);
        require(ctx,child&&selection?.operation==='has'&&ctx.eq(selection.object,base)&&
          ctx.eq(selection.target,route.target)&&ctx.eq(selection.handler,route.handler)&&
          ctx.eq(selection.receiver,route.handler)&&ctx.eq(selection.route,route.route)&&
          ctx.eq(selection.keyValue,row.operands[0])&&ctx.eq(getter,route.getter)&&
          selection.key===(key[0]==='symbol'?symbolPropertyKey(key[1]):stringPropertyKey(key[1])),
          'runtime has getter differs from the exact source GetMethod lookup');
        const entry={id,parent:event.invocationId,child:child.id,childToken,object:base[1],
          target:route.target,handler:route.handler,receiver:route.handler,key:ctx.copy(key),getter,
          trapOwner:route.owner,route:route.route,siteId:event.siteId,phase:'getting',method:null,rawReturn:null};
        emit(ctx,{kind:'proxy.getMethod.begin',id,operation:'has',object:entry.object,target:entry.target,
          handler:entry.handler,receiver:entry.receiver,key:entry.key,child:childToken,getter},event);
        emit(ctx,{kind:'property.get.call',id,child:childToken,object:entry.handler[1],key:['str','has'],
          receiver:entry.receiver},event,'owned-source-accessor-call/1');
        getMethods.set(event.invocationId,entry);getMethodCallbacks.set(child.id,entry);
        getterCandidates.delete(child.id);return true;
      }
    }
    if(event.completion?.type==='throw'){
      const operation=has?'has':deletion?'deleteProperty':event.operation==='property.read'?'get':'set';
      if(node?.targetId===null&&node?.handlerId===null){
        const thrown=event.completion?.type==='throw'?event.completion.value?.value:null;
        require(ctx,freshTypeError(event,thrown),'revoked Proxy operation lacks its exact TypeError allocation');
        const sourceError=requireFaultError(ctx,event,row,thrown,event.eventId);
        emit(ctx,{kind:'proxy.revoked.fault',object:node.id,operation,error:thrown[1]},event);
        publicFaultMessage(ctx,thrown[1],sourceError.properties.message.value);ctx.markPublished(thrown[1]);return true;
      }
      const program=ctx.bundle.programs[ctx.getOwnedFrame(event.invocationId)?.codeId];
      if(deletion&&!row.child&&instruction?.op==='DELETE_PROP'&&program?.strict===true){
        const owner=event.stateChanges.find(item=>item.table==='frames'&&item.id===event.invocationId)?.after;
        let thrown=owner?.completion?.type==='throw'?owner.completion.value?.value:null;
        if(!thrown)for(const handler of [...(owner?.handlers??[])].reverse()){
          if(handler.caught?.value?.[0]==='ref'){thrown=handler.caught.value;break;}
          if(handler.pending?.type==='throw'&&handler.pending.value?.value?.[0]==='ref'){
            thrown=handler.pending.value.value;break;
          }
        }
        require(ctx,freshTypeError(event,thrown),'strict direct Proxy deletion lacks a fresh TypeError identity');
        const sourceError=requireFaultError(ctx,event,row,thrown,event.eventId);
        const routed=routeFor(ctx,base,'delete',event);
        require(ctx,['undefined','null'].includes(routed.selected[0]),'direct strict deletion selected a trap');
        emit(ctx,{kind:'proxy.delete.fault',object:node.id,key,error:thrown[1],route:routed.route},event);
        publicFaultMessage(ctx,thrown[1],sourceError.properties.message.value);ctx.markPublished(thrown[1]);
        return true;
      }
      ctx.refuse('Proxy source: abrupt Proxy operation needs its explicit error boundary');
    }
    if(row.child){
      const operation=has?'has':deletion?'delete':event.operation==='property.read'?'get':'set',id='proxy'+(++next),
        child=event.stateChanges.find(change=>change.table==='frames'&&change.id===row.child)?.after,
        parent=event.stateChanges.find(change=>change.table==='frames'&&change.id===event.invocationId)?.after,
        pending=parent?.pendingProperty;
      require(ctx,child&&pending?.proxy&&pending.waitingFrameId===child.id&&pending.kind===operation&&!active.has(parent.id),
        'callback lacks its owned Proxy continuation');
      const parentProgram=ctx.bundle.programs[parent.codeId],parentInstruction=parentProgram?.instructions[
        ctx.getOwnedFrame(parent.id)?.pc],
        sourceStrict=operation==='get'?pending.proxy.strict===!!parentProgram?.strict:
          operation==='set'?typeof pending.proxy.strict==='boolean'&&pending.proxy.strict===!!parentProgram?.strict&&
            parentInstruction?.op==='PUT_PROP':
          operation==='delete'?typeof pending.proxy.strict==='boolean'&&pending.proxy.strict===!!parentProgram?.strict&&
            parentInstruction?.op==='DELETE_PROP':pending.proxy.strict===false;
      require(ctx,sourceStrict,'Proxy source strict-delete context differs');
      const objectRef=pending.proxy.object??base,receiver=pending.proxy.receiver??objectRef,
        routed=routeFor(ctx,objectRef,operation,event),strict=['delete','set'].includes(operation)?pending.proxy.strict===true:false,
        entry={id,owner:parent.id,child:child.id,object:objectRef[1],trapOwner:routed.owner,receiver,
          route:routed.route,key,operation,strict,value:operation==='set'?ctx.tag(row.operands[2],event):null};
      require(ctx,ctx.eq(pending.proxy.route,routed.route)&&pending.proxy.owner===routed.owner&&
        ctx.eq(pending.proxy.target,routed.target)&&ctx.eq(pending.proxy.handler,routed.handler),
        'runtime retained route differs from source entry lookups');
      const sourceReceiver=ctx.tag(base,event);
      require(ctx,ctx.eq(receiver,sourceReceiver),'Proxy original receiver differs from source base');
      emit(ctx,{kind:'proxy.'+operation+'.call',id,object:entry.object,owner:entry.trapOwner,receiver,key,
        child:ctx.frame(child.id),route:entry.route,
        ...(operation==='set'?{value:entry.value}:{}),...(['delete','set'].includes(operation)?{strict}:{})},event);
      require(ctx,ctx.eq(ctx.controller.receiver,child.thisValue),'trap effective receiver differs');
      const selected=ctx.controller.protocol.proxyCalls.pending.at(-1),fn=ctx.state.heap[selected.callee[1]],
        program=ctx.bundle.programs[fn?.codeId],environment=event.stateChanges.find(change=>change.table==='envs'&&change.id===child.envId)?.after,
        args=[selected.target,key,...(operation==='set'?[entry.value]:[]),
          ...(['get','set'].includes(operation)?[receiver]:[])];
      require(ctx,fn?.kind==='function'&&!fn.async&&!program.generator&&child.codeId===fn.codeId&&environment?.parent===fn.closureEnvId,
        'trap must retain its selected synchronous source function and closure');
      require(ctx,program.params.every((name,index)=>environment.bindings[name]?.initialized&&
        ctx.eq(environment.bindings[name].token?.value,args[index]??['undefined'])),'trap parameter values differ from native call arguments');
      active.set(parent.id,entry);callbacks.set(child.id,entry);
      for(const [name,binding]of Object.entries(environment?.bindings??{}))if(binding.initialized)
        ctx.bind(ctx.cell(environment.id,name),binding.token.value,event);
      return true;
    }
    const operation=has?'has':deletion?'delete':event.operation==='property.read'?'get':'set',
      routed=routeFor(ctx,base,operation,event);
    require(ctx,['undefined','null'].includes(routed.selected[0]),'direct Proxy operation selected a trap without its call continuation');
    if(has)emit(ctx,{kind:'proxy.has',object:node.id,key,result:ctx.tag(row.result,event),route:routed.route},event);
    else if(deletion)emit(ctx,{kind:'proxy.delete',object:node.id,key,success:row.result?.[1]===true,route:routed.route},event);
    else if(event.operation==='property.read'){
      const value=row.result?.[0]==='method'?row.result[1]:row.result;
      emit(ctx,{kind:'proxy.get',object:node.id,key,result:ctx.tag(value,event),route:routed.route},event);
    }else emit(ctx,{kind:'proxy.set',object:node.id,key,value:ctx.tag(row.operands[2],event),success:true,route:routed.route},event);
    return true;
  },
  completeFrame(ctx,change,event){
    const getter=getMethodCallbacks.get(change.id);
    if(getter){
      const completion=change.after.completion,raw=completion?.value?.value,invocation=ctx.frame(change.id);
      require(ctx,['return','throw'].includes(completion?.type)&&raw&&ctx.publicInvocation===invocation,
        'GetMethod getter completion differs from its exact handler invocation');
      const value=ctx.tag(raw,event),kind=completion.type==='throw'?'throw':'return';
      emit(ctx,{kind,invocation,value},event);
      emit(ctx,{kind:'property.finish',id:getter.id,completion:{kind:kind==='throw'?'throw':'normal',value}},event,
        'owned-source-accessor-completion/1');
      emit(ctx,{kind:'proxy.getMethod.finish',id:getter.id,
        completion:{kind:kind==='throw'?'throw':'normal',value}},event);
      getMethodCallbacks.delete(change.id);getterCandidates.delete(change.id);
      if(kind==='throw')getMethods.delete(getter.parent);
      else{
        getter.phase='returned';getter.rawReturn=ctx.copy(raw);
        getter.method=['undefined','null'].includes(raw[0])?['undefined']:ctx.copy(value);
      }
      return true;
    }
    const entry=callbacks.get(change.id);if(!entry)return false;
    const completion=change.after.completion,value=completion?.value?.value,invocation=ctx.frame(change.id);
    require(ctx,['return','throw'].includes(completion?.type)&&value&&ctx.publicInvocation===invocation,
      'trap completion differs from its active invocation');
    const tag=ctx.tag(value,event);emit(ctx,{kind:completion.type,invocation,value:tag},event);
    const owner=event.stateChanges.find(item=>item.table==='frames'&&item.id===entry.owner)?.after;
    let boundaryError=owner?.completion?.type==='throw'?owner.completion.value?.value:null;
    if(!boundaryError)for(const handler of [...(owner?.handlers??[])].reverse()){
      if(handler.caught?.value?.[0]==='ref'){boundaryError=handler.caught.value;break;}
      if(handler.pending?.type==='throw'&&handler.pending.value?.value?.[0]==='ref'){
        boundaryError=handler.pending.value.value;break;
      }
    }
    const strictSetFault=entry.operation==='set'&&entry.strict&&!truthy(value),
      operationFault=completion.type==='return'&&(['has','delete'].includes(entry.operation)||strictSetFault)&&
        freshTypeError(event,boundaryError),evidence=faultEvidence.get(entry.id);
    if(operationFault){
      require(ctx,evidence?.error===boundaryError[1]&&evidence.origin===completion.value.origin&&
        ctx.eq(evidence.message,event.stateChanges.find(item=>item.table==='heap'&&item.id===boundaryError[1])?.after?.properties?.message?.value),
        'Proxy fault lacks its retained child error evidence');
      emit(ctx,{kind:'proxy.fault',id:entry.id,error:boundaryError[1]},event);
      publicFaultMessage(ctx,boundaryError[1],evidence.message);ctx.markPublished(boundaryError[1]);faultEvidence.delete(entry.id);
    }
    else{
      const normalValue=entry.operation==='has'||entry.operation==='delete'?['bool',truthy(value)]:tag;
      emit(ctx,{kind:'proxy.finish',id:entry.id,completion:{kind:completion.type==='throw'?'throw':'normal',
        value:completion.type==='throw'?tag:entry.operation==='get'?tag:entry.operation==='set'?entry.value:normalValue}},event);
    }
    active.delete(entry.owner);callbacks.delete(change.id);return true;
  },
  checkFrame(ctx,node){
    const entry=active.get(node.id),pending=node.pendingProperty;
    if(!entry){
      const getter=getMethods.get(node.id);
      if(getter){
        const selected=ctx.controller.protocol.proxyCalls.getMethods.find(row=>row.id===getter.id),
          retained=pending?.proxyGetMethod,waiting=pending?.phase==='getter-waiting';
        require(ctx,pending?.kind==='proxy-get-method'&&retained&&
          selected?.phase===(getter.phase==='returned'?'returned':'selected')&&
          selected.parent===ctx.frame(node.id)&&selected.child===getter.childToken&&
          selected.object===getter.object&&ctx.eq(selected.target,getter.target)&&
          ctx.eq(selected.handler,getter.handler)&&ctx.eq(selected.receiver,getter.receiver)&&
          ctx.eq(selected.key,getter.key)&&ctx.eq(selected.getter,getter.getter)&&
          ctx.eq(retained.object,['ref',getter.object])&&ctx.eq(retained.target,getter.target)&&
          ctx.eq(retained.handler,getter.handler)&&ctx.eq(retained.receiver,getter.receiver)&&
          ctx.eq(retained.keyValue,getter.key)&&ctx.eq(retained.getter,getter.getter)&&
          (waiting?pending.waitingFrameId===getter.child:pending.waitingFrameId===null&&getter.phase==='returned'),
          'retained GetMethod getter checkpoint differs');
        return true;
      }
      require(ctx,!pending?.proxy&&pending?.kind!=='proxy-get-method','unregistered Proxy continuation');return true;
    }
    require(ctx,(!node.handlers?.length||ctx.extensionState.has('ordinary-completions-source/1'))&&
      !node.awaiting&&!node.asyncPromiseId,'async or unowned cleanup Proxy caller needs its own profile');
    const current=ctx.controller.protocol.proxyCalls.pending.find(row=>row.id===entry.id),
      storage=entry.key[0]==='symbol'?symbolPropertyKey(entry.key[1]):stringPropertyKey(entry.key[1]);
    const actualStrict=entry.operation==='has'?false:!!ctx.bundle.programs[node.codeId]?.strict;
    require(ctx,current&&pending?.proxy&&pending.waitingFrameId===entry.child&&pending.kind===entry.operation&&
      ctx.eq(pending.proxy.target,current.target)&&ctx.eq(pending.proxy.handler,current.handler)&&
      pending.proxy.owner===current.owner&&ctx.eq(pending.proxy.receiver,current.receiver)&&
      ctx.eq(pending.proxy.route,current.route)&&pending.proxy.key===storage&&pending.proxy.strict===actualStrict&&
      current.parent===ctx.frame(node.id)&&current.child===ctx.frame(entry.child)&&current.object===entry.object&&
      current.owner===entry.trapOwner&&ctx.eq(current.receiver,entry.receiver)&&ctx.eq(current.route,entry.route)&&
      current.strict===entry.strict&&ctx.eq(current.key,entry.key)&&ctx.eq(current.value,entry.value),
      'retained target, key, operand or call identity differs');
    if(entry.operation==='get')require(ctx,ctx.eq(pending.receiver,entry.receiver)&&typeof pending.method==='boolean',
      'getter continuation receiver differs');
    else if(entry.operation==='set')require(ctx,ctx.eq(pending.value,entry.value),'setter continuation assignment value differs');
    else require(ctx,pending.value===undefined,'has/delete continuation has no assignment operand');
    return true;
  }
};}
