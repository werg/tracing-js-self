// Teacher-only source correspondence for Number(value). Native observations
// independently check method order, identities, receivers and primitive results.
import {propertyKeyValue,symbolPropertyKey} from '../property-keys.js';

export const NUMBER_SOURCE_PROFILE_V8='number-conversion-source/1';
const scalar=value=>Array.isArray(value)&&['undefined','null','bool','str','num','bigint','symbol','ref'].includes(value[0]);
export function createNumberSourceAdapterV8(){
  let active=new Map(),callbacks=new Map(),next=0;
  const require=(ctx,condition,message)=>{if(!condition)ctx.refuse('Number conversion: '+message);};
  const operation=(ctx,id)=>ctx.controller.protocol.numberConversions.operations.find(row=>row.id===id);
  const emit=(ctx,record,event)=>ctx.emit(record,event,'owned-number-conversion/1');
  function ordinaryTag(ctx,input){
    const seen=new Set();let id=input[1];
    for(;;){
      require(ctx,!seen.has(id),'cyclic toStringTag prototype');seen.add(id);
      const node=ctx.state.heap[id],key=symbolPropertyKey('well-known:toStringTag');
      require(ctx,node&&['object','array','function'].includes(node.kind),'ordinary toStringTag lookup');
      require(ctx,!Object.hasOwn(node.accessors??{},key),'toStringTag accessor needs a getter protocol');
      if(Object.hasOwn(node.properties??{},key))return node.properties[key].value;
      if(node.prototype===null||node.prototype===undefined||['Object.prototype','Array.prototype','Function.prototype'].includes(node.prototype))return ['undefined'];
      require(ctx,typeof node.prototype==='string','ordinary toStringTag prototype identity');id=node.prototype;
    }
  }
  function advance(ctx,event,entry){
    require(ctx,event.completion?.type!=='throw','abrupt conversion needs its own completion record');
    const id=entry.id,reads=event.readObservations??[];
    for(const read of reads){
      require(ctx,read.kind==='property','conversion reads must be ordinary method selections');
      const key=propertyKeyValue(read.key),method=read.value,builtin=method?.[0]==='builtinfn'?method[1]:null;
      require(ctx,['Object.valueOf','Object.toString',null].includes(builtin),'array or exotic intrinsic conversion requires its own profile');
      emit(ctx,{kind:'number.select',id,key,method:builtin?['undefined']:ctx.tag(method,event),builtin},event);
      const current=operation(ctx,id);
      if(current.phase==='builtin'){
        const tag=builtin==='Object.toString'?ordinaryTag(ctx,entry.input):null;
        emit(ctx,{kind:'number.builtin',id,result:builtin==='Object.valueOf'?ctx.copy(entry.input):
          ['str','[object '+(tag[0]==='str'?tag[1]:'Object')+']']},event);
      }
    }
    const current=operation(ctx,id);
    if(current.phase==='call'){
      const child=event.stateChanges.find(change=>change.table==='frames'&&change.before===null)?.after,
        parent=event.stateChanges.find(change=>change.table==='frames'&&change.id===event.invocationId)?.after,
        retained=parent?.pendingNumberConversion;
      require(ctx,child&&retained&&retained.waitingFrameId===child.id&&retained.phase==='waiting'&&
        retained.index===current.index&&ctx.eq(retained.method,current.method)&&ctx.eq(retained.input,entry.input),
        'owned callback does not match its captured live method');
      emit(ctx,{kind:'number.call',id,child:ctx.frame(child.id)},event);
      require(ctx,ctx.eq(ctx.controller.receiver,child.thisValue),'callback receiver differs from its source function kind');
      const selected={...entry,child:child.id,index:current.index,method:ctx.copy(current.method)};
      active.set(event.invocationId,selected);callbacks.set(child.id,selected);
      const environment=event.stateChanges.find(change=>change.table==='envs'&&change.id===child.envId)?.after;
      for(const [name,binding]of Object.entries(environment?.bindings??{}))if(binding.initialized){
        require(ctx,scalar(binding.token?.value),'callback parameter needs a public value');
        ctx.bind(ctx.cell(environment.id,name),binding.token.value,event);
      }
    }else{
      require(ctx,current.phase==='convert'&&event.result?.[0]==='num','conversion has no checked scalar result');
      emit(ctx,{kind:'number.finish',id,result:ctx.tag(event.result,event)},event);active.delete(event.invocationId);
    }
  }
  return {id:NUMBER_SOURCE_PROFILE_V8,
    captureState:()=>({active:[...active],callbacks:[...callbacks],next}),
    restoreState(state){active=new Map(state.active);callbacks=new Map(state.callbacks);next=state.next;},
    frameFields(node){return Object.hasOwn(node,'pendingNumberConversion')?['pendingNumberConversion']:null;},
    event(ctx,event){
      const raw=event.operands[0],callee=raw?.[0]==='method'?raw[1]:raw;
      if(event.operation==='call.enter'&&ctx.eq(callee,['intrinsic','Number'])){
        const site=ctx.bundle.sites.find(row=>row.siteId===event.siteId),node=ctx.inventory.nodes.get(site?.start+':'+site?.end);
        require(ctx,node?.type==='CallExpression'&&node.callee.type==='Identifier'&&node.callee.name==='Number'&&!node.optional,
          'only direct source Number calls are qualified');
        require(ctx,event.operands.length<=2,'extra Number arguments require their own source profile');
        const value=event.operands[1]??['num',0],entry={id:'number'+(++next),input:ctx.tag(value,event),owner:event.invocationId};
        require(ctx,!active.has(event.invocationId),'caller already has a pending conversion');
        emit(ctx,{kind:'number.begin',id:entry.id,value:entry.input},event);active.set(event.invocationId,entry);
        advance(ctx,event,entry);return true;
      }
      if(event.operation==='intrinsic.number.resume'){
        const entry=active.get(event.invocationId);require(ctx,entry,'resume lacks its selected conversion');
        advance(ctx,event,entry);return true;
      }
      return false;
    },
    completeFrame(ctx,change,event){
      const entry=callbacks.get(change.id);if(!entry)return false;
      const value=change.after.completion?.value?.value,invocation=ctx.frame(change.id);
      const kind=change.after.completion?.type;
      require(ctx,['return','throw'].includes(kind)&&scalar(value)&&ctx.publicInvocation===invocation,
        'mismatched conversion callback completion');
      emit(ctx,{kind,invocation,value:ctx.tag(value,event)},event);
      emit(ctx,{kind:'number.'+kind,id:entry.id,value:ctx.tag(value,event)},event);
      if(kind==='throw')active.delete(entry.owner);
      callbacks.delete(change.id);return true;
    },
    checkFrame(ctx,node){
      const pending=node.pendingNumberConversion;if(pending===undefined)return true;
      require(ctx,!node.awaiting&&!node.asyncPromiseId,'async conversion needs its own profile');
      require(ctx,!node.handlers?.length||ctx.extensionState.has('ordinary-completions-source/1')||node.generatorId,
        'cleanup conversion needs its declared completion profile');
      const entry=active.get(node.id),current=entry&&operation(ctx,entry.id);
      require(ctx,current&&current.parent===ctx.frame(node.id)&&ctx.eq(current.input,pending.input)&&
        pending.operation==='Number'&&pending.index===entry.index&&pending.waitingFrameId===entry.child&&ctx.eq(pending.method,entry.method),
        'retained conversion identity, method or receiver differs');
      require(ctx,ctx.controller.frameFunctions.get(ctx.frame(entry.child))===ctx.codeFor(ctx.state.heap[pending.method[1]]),
        'retained callback source identity differs');
      if(pending.phase==='waiting')require(ctx,current.phase==='waiting'&&current.child===ctx.frame(entry.child)&&pending.result===null,
        'waiting conversion callback differs');
      else require(ctx,pending.phase==='returned'&&['select','convert'].includes(current.phase)&&
        ctx.eq(ctx.controller.lastReturn?.value,pending.result)&&!ctx.controller.stack.includes(ctx.frame(entry.child)),
        'returned conversion callback differs');
      return true;
    }
  };
}
