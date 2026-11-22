// Teacher-only projection of the shared retained ToPrimitive operation. Every
// lookup, getter, callback and scalar result is checked by the public machine;
// the separate native observer establishes correspondence with original source.
import {decode} from '../values.js';
import {propertyKeyValue,symbolPropertyKey} from '../property-keys.js';

export const PRIMITIVE_CONVERSION_SOURCE_PROFILE_V8='primitive-conversion-source/1';
const scalar=value=>Array.isArray(value)&&['undefined','null','bool','str','num','bigint','symbol','ref'].includes(value[0]);
const pendingFor=(frame,goal)=>goal==='Number'?frame?.pendingNumberConversion:frame?.pendingPropertyKeyConversion?.conversion;
export function createPrimitiveConversionSourceAdapterV8(){
  let active=new Map(),callbacks=new Map(),next=0;
  const require=(ctx,condition,message)=>{if(!condition)ctx.refuse('Primitive conversion: '+message);};
  const operation=(ctx,id)=>ctx.controller.protocol.primitiveConversions.operations.find(row=>row.id===id);
  const emit=(ctx,record,event)=>ctx.emit(record,event,'owned-primitive-conversion/1');
  function lookup(ctx,input,key){
    const seen=new Set();let node=ctx.state.heap[input[1]];
    for(;;){
      require(ctx,node&&['object','array','function'].includes(node.kind)&&!seen.has(node.id),'ordinary acyclic conversion prototype');
      seen.add(node.id);
      if(Object.hasOwn(node.accessors??{},key))return {descriptor:'accessor',method:node.accessors[key].get.value};
      if(Object.hasOwn(node.properties??{},key))return {descriptor:'data',method:node.properties[key].value};
      const prototype=Object.hasOwn(node,'prototype')?node.prototype:node.kind==='array'?'Array.prototype':'Object.prototype';
      if(prototype===null)return {descriptor:'missing',method:['undefined']};
      if(['Object.prototype','Array.prototype','Function.prototype'].includes(prototype)){
        require(ctx,prototype!=='Function.prototype'||!['toString',symbolPropertyKey('well-known:toStringTag')].includes(key),
          'function intrinsic prototype requires its own conversion profile');
        const builtin=key==='valueOf'?'Object.valueOf':key==='toString'?
          prototype==='Array.prototype'?'Array.toString':'Object.toString':
          key==='join'&&prototype==='Array.prototype'?'Array.prototype.join':null;
        return builtin?{descriptor:'builtin',method:['builtinfn',builtin]}:{descriptor:'missing',method:['undefined']};
      }
      node=ctx.state.heap[prototype];
    }
  }
  function builtinResult(ctx,entry,name){
    if(name==='Object.valueOf')return ctx.copy(entry.input);
    if(name==='Object.toString'){
      const tag=lookup(ctx,entry.ownedInput,symbolPropertyKey('well-known:toStringTag')),
        node=ctx.state.heap[entry.ownedInput[1]];
      require(ctx,tag.descriptor!=='accessor','toStringTag accessor requires its own continuation');
      return ['str','[object '+(tag.method[0]==='str'?tag.method[1]:node.kind==='array'?'Array':'Object')+']'];
    }
    require(ctx,name==='Array.toString','unsupported conversion intrinsic');
    const node=ctx.state.heap[entry.ownedInput[1]],join=lookup(ctx,entry.ownedInput,'join'),
      length=node?.properties.length?.value;
    require(ctx,node?.kind==='array'&&ctx.eq(join,{descriptor:'builtin',method:['builtinfn','Array.prototype.join']})&&
      length?.[0]==='num'&&Number.isSafeInteger(length[1])&&length[1]>=0&&length[1]<=10000,'ordinary bounded Array.toString');
    const parts=[];
    for(let index=0;index<length[1];index++){
      const value=node.properties[String(index)]?.value;
      require(ctx,!Object.hasOwn(node.accessors??{},String(index))&&
        ['undefined','null','bool','str','num','bigint'].includes(value?.[0]),'Array.toString requires dense own scalar elements');
      parts.push(['undefined','null'].includes(value[0])?'':String(decode(value)));
    }
    return ['str',parts.join(',')];
  }
  function advance(ctx,event,entry){
    require(ctx,event.completion?.type!=='throw','intrinsic conversion fault has no complete source observation profile');
    const id=entry.id;
    for(const read of event.readObservations??[]){
      require(ctx,read.kind==='property'&&read.objectId===entry.ownedInput[1],'conversion lookup receiver differs');
      const found=lookup(ctx,entry.ownedInput,read.key),builtin=found.descriptor==='builtin'?found.method[1]:null;
      require(ctx,ctx.eq(read.value,found.method),'conversion read differs from its live descriptor');
      emit(ctx,{kind:'conversion.lookup',id,key:propertyKeyValue(read.key),descriptor:found.descriptor,
        value:builtin?['undefined']:ctx.tag(found.method,event),builtin},event);
      if(operation(ctx,id).phase==='builtin')emit(ctx,{kind:'conversion.builtin',id,result:builtinResult(ctx,entry,builtin)},event);
    }
    const current=operation(ctx,id);
    require(ctx,current.phase!=='fault','intrinsic conversion fault has no complete source observation profile');
    if(['call','getter-call'].includes(current.phase)){
      const parent=event.stateChanges.find(change=>change.table==='frames'&&change.id===event.invocationId)?.after,
        retained=pendingFor(parent,entry.goal),getter=current.phase==='getter-call',
        child=event.stateChanges.find(change=>change.table==='frames'&&change.id===retained?.waitingFrameId)?.after;
      require(ctx,child&&retained&&retained.phase===(getter?'getter-waiting':'waiting')&&retained.index===current.index&&
        ctx.eq(ctx.tag(retained.method,event),current.method)&&ctx.eq(retained.input,entry.ownedInput)&&
        retained.operation===entry.goal,'owned callback differs from its selected live method');
      emit(ctx,{kind:getter?'conversion.getter.call':'conversion.call',id,child:ctx.frame(child.id)},event);
      require(ctx,ctx.eq(ctx.controller.receiver,ctx.tag(child.thisValue,event)),'callback receiver differs from source function kind');
      const selected={...entry,child:child.id,index:current.index,method:ctx.copy(retained.method),getter};
      active.set(event.invocationId,selected);callbacks.set(child.id,selected);
      const environment=event.stateChanges.find(change=>change.table==='envs'&&change.id===child.envId)?.after;
      for(const [name,binding]of Object.entries(environment?.bindings??{}))if(binding.initialized){
        require(ctx,scalar(binding.token?.value),'callback parameter requires a public value');
        ctx.bind(ctx.cell(environment.id,name),binding.token.value,event);
      }
    }else{
      require(ctx,current.phase==='finish'&&(entry.goal==='Number'?event.result?.[0]==='num':
        ['str','symbol'].includes(event.result?.[0])),'conversion lacks its checked scalar result');
      emit(ctx,{kind:'conversion.finish',id,result:ctx.tag(event.result,event)},event);active.delete(event.invocationId);
    }
  }
  return {id:PRIMITIVE_CONVERSION_SOURCE_PROFILE_V8,
    captureState:()=>({active:[...active],callbacks:[...callbacks],next}),
    restoreState(state){active=new Map(state.active);callbacks=new Map(state.callbacks);next=state.next;},
    frameFields(node){const fields=['pendingNumberConversion','pendingPropertyKeyConversion'].filter(key=>Object.hasOwn(node,key));
      return fields.length?fields:null;},
    beforeEvent(ctx,event){
      if(event?.completion?.type!=='throw')return;
      const site=ctx.bundle.sites.find(row=>row.siteId===event.siteId),node=ctx.inventory.nodes.get(site?.start+':'+site?.end);
      if(['property.key.convert','property.key.resume','intrinsic.number.resume'].includes(event.operation)||
        event.operation==='call.enter'&&node?.type==='CallExpression'&&node.callee.type==='Identifier'&&node.callee.name==='Number')
        ctx.refuse('Primitive conversion: intrinsic conversion fault has no complete source observation profile');
    },
    event(ctx,event){
      const raw=event.operands[0],callee=raw?.[0]==='method'?raw[1]:raw,
        number=event.operation==='call.enter'&&ctx.eq(callee,['intrinsic','Number']),
        key=event.operation==='property.key.convert';
      if(number||key){
        if(number){
          const site=ctx.bundle.sites.find(row=>row.siteId===event.siteId),node=ctx.inventory.nodes.get(site?.start+':'+site?.end);
          require(ctx,node?.type==='CallExpression'&&node.callee.type==='Identifier'&&node.callee.name==='Number'&&!node.optional,
            'only direct source Number calls are qualified');
          require(ctx,event.operands.length<=2,'extra Number arguments require their own source profile');
        }else{
          const frame=ctx.state.frames[event.invocationId],instruction=ctx.bundle.programs[event.codeId]?.instructions[frame?.pc];
          require(ctx,!['DUP2','UPDATE_PROP'].includes(instruction?.op)&&
            !(instruction?.op==='GET_PROP'&&instruction.arg?.cachePropertyKey),
            'compound/logical/update object keys differ from the pinned reference edition');
        }
        const value=number?event.operands[1]??['num',0]:event.operands[0],
          entry={id:'conversion'+(++next),goal:number?'Number':'PropertyKey',input:ctx.tag(value,event),
            ownedInput:ctx.copy(value),owner:event.invocationId};
        require(ctx,!active.has(entry.owner),'caller already has a pending conversion');
        emit(ctx,{kind:'conversion.begin',id:entry.id,goal:entry.goal,value:entry.input},event);active.set(entry.owner,entry);
        advance(ctx,event,entry);return true;
      }
      if(['intrinsic.number.resume','property.key.resume'].includes(event.operation)){
        const entry=active.get(event.invocationId);require(ctx,entry,'resume lacks its selected conversion');
        advance(ctx,event,entry);return true;
      }
      return false;
    },
    completeFrame(ctx,change,event){
      const entry=callbacks.get(change.id);if(!entry)return false;
      const value=change.after.completion?.value?.value,kind=change.after.completion?.type,invocation=ctx.frame(change.id);
      require(ctx,['return','throw'].includes(kind)&&scalar(value)&&ctx.publicInvocation===invocation,'mismatched conversion callback completion');
      const result=ctx.tag(value,event);
      emit(ctx,{kind,invocation,value:result},event);
      emit(ctx,{kind:kind==='throw'?'conversion.throw':entry.getter?'conversion.getter.return':'conversion.return',id:entry.id,value:result},event);
      if(kind==='throw')active.delete(entry.owner);callbacks.delete(change.id);return true;
    },
    checkFrame(ctx,node){
      const pending=node.pendingNumberConversion??node.pendingPropertyKeyConversion?.conversion;
      if(pending===undefined)return true;
      require(ctx,!node.awaiting&&!node.asyncPromiseId,'async conversion requires its own profile');
      require(ctx,!node.handlers?.length||ctx.extensionState.has('ordinary-completions-source/1')||node.generatorId,
        'cleanup conversion requires its declared completion profile');
      const entry=active.get(node.id),current=entry&&operation(ctx,entry.id);
      require(ctx,current&&current.parent===ctx.frame(node.id)&&ctx.eq(current.input,entry.input)&&
        ctx.eq(entry.ownedInput,pending.input)&&pending.operation===entry.goal&&pending.index===entry.index&&
        pending.waitingFrameId===entry.child&&ctx.eq(pending.method,entry.method),'retained conversion identity or method differs');
      require(ctx,ctx.controller.frameFunctions.get(ctx.frame(entry.child))===ctx.codeFor(ctx.state.heap[pending.method[1]]),
        'retained callback source identity differs');
      if(['waiting','getter-waiting'].includes(pending.phase))require(ctx,current.phase===pending.phase&&
        current.child===ctx.frame(entry.child)&&pending.result===null,'waiting conversion callback differs');
      else require(ctx,['returned','getter-returned'].includes(pending.phase)&&
        ['lookup','call','finish','fault'].includes(current.phase)&&ctx.eq(ctx.controller.lastReturn?.value,ctx.tag(pending.result))&&
        !ctx.controller.stack.includes(ctx.frame(entry.child)),'returned conversion callback differs');
      return true;
    }
  };
}
