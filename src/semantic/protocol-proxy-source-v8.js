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
  let active=new Map(),callbacks=new Map(),faultEvidence=new Map(),revokers=new Map(),next=0;
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
  return {id:PROXY_SOURCE_PROFILE_V8,
  captureState:()=>({active:[...active],callbacks:[...callbacks],faultEvidence:[...faultEvidence],revokers:[...revokers],next}),
  restoreState(state){active=new Map(state.active);callbacks=new Map(state.callbacks);faultEvidence=new Map(state.faultEvidence??[]);revokers=new Map(state.revokers??[]);next=state.next;},
  syntax(node){return node.type==='NewExpression'&&node.callee.type==='Identifier'&&node.callee.name==='Proxy'||
    node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&!node.callee.computed&&
    node.callee.object.type==='Identifier'&&node.callee.object.name==='Proxy'&&node.callee.property.name==='revocable';},
  normalizeTag(_ctx,value){
    const prior=value?.[0]==='builtinfn'?revokers.get(value[1]):null;
    return prior?['ref',prior.revoke]:undefined;
  },
  heapFields(node){return node.kind==='proxy'?fields:null;},
  frameFields(node){return node.pendingProperty?.proxy?['pendingProperty']:null;},
  checkHeap(ctx,node){
    if(Object.keys(node.properties??{}).length||Object.keys(node.propertyVersions??{}).length||node.shapeVersion!==0)
      ctx.refuse('Proxy has undeclared own storage');
    return ctx.eq(ctx.controller.heap.get(node.id),{kind:'proxy',target:node.targetId===null?['null']:['ref',node.targetId],
      handler:node.handlerId===null?['null']:['ref',node.handlerId],properties:new Map()});
  },
  allocate(ctx,node){if(node.kind==='proxy')ctx.refuse('Proxy allocation must follow its source constructor');return false;},
  event(ctx,event,row){
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
      base=has?row?.operands?.[1]:row?.operands?.[0]??directStack.at(-2)?.value??failedRead.at(-2)?.value,
      node=base?.[0]==='ref'?ctx.state.heap[base[1]]:null;
    if(node?.kind!=='proxy'||!property&&!has&&!deletion)return false;
    const key=ctx.key(has?row.operands[0]:row?.operands?.[1]??directStack.at(-1)?.value??failedRead.at(-1)?.value);
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
    if(!entry){require(ctx,!pending?.proxy,'unregistered Proxy continuation');return true;}
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
