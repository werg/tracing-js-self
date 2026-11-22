// Teacher-only allocation/access adapter. Traps enter the existing shared
// invocation stack; no adapter executes a callback or supplies its result.
import {stringPropertyKey,symbolPropertyKey} from '../property-keys.js';
export const PROXY_SOURCE_PROFILE_V8='ordinary-data-proxy-source/1';
const fields=['targetId','handlerId','properties','propertyVersions','shapeVersion'];
export function createProxySourceAdapterV8(){
  let active=new Map(),callbacks=new Map(),next=0;
  const require=(ctx,condition,message)=>{if(!condition)ctx.refuse('Proxy source: '+message);};
  const emit=(ctx,record,event)=>ctx.emit(record,event,'owned-proxy-operation/1');
  return {id:PROXY_SOURCE_PROFILE_V8,
  captureState:()=>({active:[...active],callbacks:[...callbacks],next}),
  restoreState(state){active=new Map(state.active);callbacks=new Map(state.callbacks);next=state.next;},
  syntax(node){return node.type==='NewExpression'&&node.callee.type==='Identifier'&&node.callee.name==='Proxy';},
  heapFields(node){return node.kind==='proxy'?fields:null;},
  frameFields(node){return node.pendingProperty?.proxy?['pendingProperty']:null;},
  checkHeap(ctx,node){
    if(Object.keys(node.properties??{}).length||Object.keys(node.propertyVersions??{}).length||node.shapeVersion!==0)
      ctx.refuse('Proxy has undeclared own storage');
    return ctx.eq(ctx.controller.heap.get(node.id),{kind:'proxy',target:['ref',node.targetId],handler:['ref',node.handlerId],properties:new Map()});
  },
  allocate(ctx,node){if(node.kind==='proxy')ctx.refuse('Proxy allocation must follow its source constructor');return false;},
  event(ctx,event,row){
    if(event.operation==='proxy.allocate'){
      const node=event.stateChanges.find(change=>change.table==='heap'&&change.before===null&&change.id===event.result?.[1])?.after;
      if(node?.kind!=='proxy'||event.operands.length!==2||event.completion?.type==='throw')
        ctx.refuse('Proxy source allocation lacks its target and handler');
      emit(ctx,{kind:'proxy.create',name:node.id,target:ctx.tag(event.operands[0],event),handler:ctx.tag(event.operands[1],event)},event);
      ctx.markPublished(node.id);return true;
    }
    const base=row?.operands?.[0],node=base?.[0]==='ref'?ctx.state.heap[base[1]]:null;
    if(node?.kind!=='proxy'||!['property.read','property.write'].includes(event.operation))return false;
    require(ctx,event.completion?.type!=='throw','abrupt property access needs its explicit completion boundary');
    const key=ctx.key(row.operands[1]);
    if(row.child){
      const operation=event.operation==='property.read'?'get':'set',id='proxy'+(++next),
        child=event.stateChanges.find(change=>change.table==='frames'&&change.id===row.child)?.after,
        parent=event.stateChanges.find(change=>change.table==='frames'&&change.id===event.invocationId)?.after,
        pending=parent?.pendingProperty;
      require(ctx,child&&pending?.proxy&&pending.waitingFrameId===child.id&&pending.kind===operation&&!active.has(parent.id),
        'callback lacks its owned Proxy continuation');
      const entry={id,owner:parent.id,child:child.id,object:node.id,key,operation,value:operation==='set'?ctx.tag(row.operands[2],event):null};
      emit(ctx,{kind:'proxy.'+operation+'.call',id,object:node.id,key,child:ctx.frame(child.id),
        ...(operation==='set'?{value:entry.value}:{})},event);
      require(ctx,ctx.eq(ctx.controller.receiver,child.thisValue),'trap effective receiver differs');
      const selected=ctx.controller.protocol.proxyCalls.pending.at(-1),fn=ctx.state.heap[selected.callee[1]],
        program=ctx.bundle.programs[fn?.codeId],environment=event.stateChanges.find(change=>change.table==='envs'&&change.id===child.envId)?.after,
        args=[selected.target,key,...(operation==='set'?[entry.value]:[]),['ref',node.id]];
      require(ctx,fn?.kind==='function'&&!fn.async&&!program.generator&&child.codeId===fn.codeId&&environment?.parent===fn.closureEnvId,
        'trap must retain its selected synchronous source function and closure');
      require(ctx,program.params.every((name,index)=>environment.bindings[name]?.initialized&&
        ctx.eq(environment.bindings[name].token?.value,args[index]??['undefined'])),'trap parameter values differ from native call arguments');
      active.set(parent.id,entry);callbacks.set(child.id,entry);
      for(const [name,binding]of Object.entries(environment?.bindings??{}))if(binding.initialized)
        ctx.bind(ctx.cell(environment.id,name),binding.token.value,event);
      return true;
    }
    if(event.operation==='property.read'){
      const value=row.result?.[0]==='method'?row.result[1]:row.result;
      emit(ctx,{kind:'proxy.get',object:node.id,key,result:ctx.tag(value,event)},event);
    }else emit(ctx,{kind:'proxy.set',object:node.id,key,value:ctx.tag(row.operands[2],event),success:true},event);
    return true;
  },
  completeFrame(ctx,change,event){
    const entry=callbacks.get(change.id);if(!entry)return false;
    const completion=change.after.completion,value=completion?.value?.value,invocation=ctx.frame(change.id);
    require(ctx,['return','throw'].includes(completion?.type)&&value&&ctx.publicInvocation===invocation,
      'trap completion differs from its active invocation');
    const tag=ctx.tag(value,event);emit(ctx,{kind:completion.type,invocation,value:tag},event);
    emit(ctx,{kind:'proxy.finish',id:entry.id,completion:{kind:completion.type==='throw'?'throw':'normal',
      value:completion.type==='throw'||entry.operation==='get'?tag:entry.value}},event);
    active.delete(entry.owner);callbacks.delete(change.id);return true;
  },
  checkFrame(ctx,node){
    const entry=active.get(node.id),pending=node.pendingProperty;
    if(!entry){require(ctx,!pending?.proxy,'unregistered Proxy continuation');return true;}
    require(ctx,!node.handlers?.length&&!node.awaiting&&!node.asyncPromiseId,'cleanup or async Proxy caller needs its own profile');
    const current=ctx.controller.protocol.proxyCalls.pending.find(row=>row.id===entry.id),
      storage=entry.key[0]==='symbol'?symbolPropertyKey(entry.key[1]):stringPropertyKey(entry.key[1]);
    require(ctx,current&&pending?.proxy&&pending.waitingFrameId===entry.child&&pending.kind===entry.operation&&
      ctx.eq(pending.proxy.target,current.target)&&pending.proxy.key===storage&&pending.proxy.strict===true&&
      current.parent===ctx.frame(node.id)&&current.child===ctx.frame(entry.child)&&current.object===entry.object&&
      ctx.eq(current.key,entry.key)&&ctx.eq(current.value,entry.value),'retained target, key, operand or call identity differs');
    if(entry.operation==='get')require(ctx,ctx.eq(pending.receiver,['ref',entry.object])&&typeof pending.method==='boolean',
      'getter continuation receiver differs');
    else require(ctx,ctx.eq(pending.value,entry.value),'setter continuation assignment value differs');
    return true;
  }
};}
