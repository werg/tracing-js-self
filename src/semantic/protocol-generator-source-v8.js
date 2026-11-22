// Teacher-only generator projection. No archived frame, operand stack or program
// counter becomes a public record; lifecycle transitions use the shared heap.
import {GENERATOR_INTRINSICS_V8} from './protocol-generator-v8.js';

export const GENERATOR_SOURCE_PROFILE_V8='synchronous-generator-source/1';
const U=['undefined'],ref=id=>['ref',id];
const scalar=value=>Array.isArray(value)&&['undefined','null','bool','str','num','bigint','ref','symbol'].includes(value[0]);
const instanceFields=['frameId','functionId','prototype','state','properties','propertyVersions','shapeVersion','propertyOrder','accessors','dataAttributes','extensible'];
const after=(ctx,event,table,id)=>event.stateChanges.find(change=>change.table===table&&change.id===id)?.after??ctx.state[table]?.[id];
const require=(ctx,condition,message)=>{if(!condition)ctx.refuse('generator: '+message);};

export function createGeneratorSourceAdapterV8({bundle}){
  if(!Object.values(bundle.programs).some(program=>program.generator))return null;
  let creations=new Map(),yields=new Map(),completed=new Set(),handlerDefinitions=new Map(),delegations=new Map(),delegateSites=new Set(),handlerCounter=0;
  const emit=(ctx,record,event)=>ctx.emit(record,event,'owned-generator-protocol/1');
  const instruction=(ctx,event)=>{const frame=ctx.getOwnedFrame(event.invocationId),candidate=bundle.programs[event.codeId]?.instructions[frame?.pc];
    return candidate?.siteId===event.siteId?candidate:null;};
  const delegateSite=inst=>inst&&delegateSites.has(inst.start+':'+inst.end);
  function delegatedCall(ctx,event,inst,current,record){
    const owner=current?.generatorId&&ctx.controller.heap.get(current.generatorId),delegate=owner?.delegation;
    if(delegate&&delegateSite(inst)){
      const raw=event.operands[0];require(ctx,raw?.[0]==='method'&&ctx.eq(raw[2],delegate.iterator)&&event.operands.length===2&&
        ctx.eq(event.operands[1],delegate.request.value),'delegated call changed its exact receiver or sent input');
      emit(ctx,{kind:'generator.delegate.call',object:current.generatorId,method:delegate.request.kind,call:record},event);
    }else emit(ctx,record,event);
  }
  function settleDelegatedThrow(ctx,event){
    const active=[...ctx.controller.heap].find(([,node])=>node.kind==='generator'&&node.invocation===ctx.publicInvocation&&node.delegation?.phase==='calling');
    if(active&&ctx.controller.lastReturn?.kind==='throw'){
      emit(ctx,{kind:'generator.delegate.abrupt',object:active[0],value:ctx.controller.lastReturn.value},event);delegations.delete(active[0]);
    }
  }
  function bindFrame(ctx,event,frame){
    const env=after(ctx,event,'envs',frame.envId);
    for(const [name,binding]of Object.entries(env?.bindings??{}))if(binding.initialized&&scalar(binding.token?.value))
      ctx.bind(ctx.cell(env.id,name),binding.token.value,event);
  }
  function resultObject(ctx,event,done){
    const nodes=event.stateChanges.filter(change=>change.table==='heap'&&change.before===null&&change.after?.kind==='object');
    const result=nodes.find(change=>change.after.properties?.done?.value?.[0]==='bool'&&change.after.properties.done.value[1]===done);
    require(ctx,result&&nodes.length===1&&ctx.eq(ctx.orderedKeys(result.after),['value','done']),'iterator result must be one exact fresh ordinary value/done object');
    return result.after;
  }
  function checkOrdinary(ctx,node){
    // Ordinary descriptor comparison for functions/prototypes stays in the
    // common source checker; the instance has its own ordinary property view.
    if(node.kind==='generator')ctx.baseCheckHeap(node);
  }
  function finish(ctx,change,event){
    if(completed.has(event.eventId+':'+change.id))return true;
    const frame=change.after;if(!frame.generatorId)return false;
    const object=ctx.controller.heap.get(frame.generatorId),value=frame.completion?.value?.value,
      kind=frame.completion?.type==='throw'?'throw':'return';
    require(ctx,object&&scalar(value)&&object.invocation===ctx.publicInvocation,'generator completion invocation/value');
    let result=null;if(kind==='return')result=resultObject(ctx,event,true);
    emit(ctx,{kind:'generator.finish',object:frame.generatorId,completion:{kind,value:ctx.tag(value,event)},name:result?.id??null},event);
    if(result)ctx.markPublished(result.id);completed.add(event.eventId+':'+change.id);settleDelegatedThrow(ctx,event);return true;
  }
  return {id:GENERATOR_SOURCE_PROFILE_V8,
    captureState:()=>({creations:[...creations],yields:[...yields],completed:[...completed],
      handlerDefinitions:[...handlerDefinitions],delegations:[...delegations],delegateSites:[...delegateSites],handlerCounter}),
    restoreState(state){creations=new Map(state.creations);yields=new Map(state.yields);completed=new Set(state.completed);
      handlerDefinitions=new Map(state.handlerDefinitions);delegations=new Map(state.delegations);
      delegateSites=new Set(state.delegateSites);handlerCounter=state.handlerCounter;},
    syntax(node){if(node.type!=='YieldExpression')return false;
      if(node.delegate)delegateSites.add(node.start+':'+node.end);return true;},
    program(program){return program.generator===true&&program.strict&&!program.async&&!program.parameterExpressions&&program.restIndex<0;},
    heapFields(node){return node.kind==='generator'?instanceFields:node.generatorFunction?['generatorFunction','prototypeInitialized']:
      GENERATOR_INTRINSICS_V8.includes(node.prototype)?[]:null;},
    frameFields(node){return node.generatorId?['generatorId','delegateYield','delegateResume']:null;},
    allocate(ctx,node,event){
      if(ctx.published.has(node.id))return true;
      if(node.kind==='generator')ctx.refuse('generator allocation must follow its exact called function');
      if(!node.generatorFunction)return false;
      const prototype=node.properties?.prototype?.value,name=node.properties?.name?.value,length=node.properties?.length?.value;
      require(ctx,prototype?.[0]==='ref'&&name?.[0]==='str'&&length?.[0]==='num','generator definition metadata');
      const bare=ctx.copy(node);bare.properties={};bare.propertyVersions={};bare.propertyOrder=[];bare.shapeVersion=0;
      delete bare.prototype;delete bare.dataAttributes;delete bare.generatorFunction;delete bare.nonConstructible;
      ctx.baseAllocate(bare,event);
      emit(ctx,{kind:'generator.function',object:node.id,prototype:prototype[1],name:name[1],length:length[1]},event);
      ctx.markPublished(prototype[1]);return true;
    },
    event(ctx,event,row){
      const inst=instruction(ctx,event),current=ctx.getOwnedFrame(event.invocationId);
      if(current?.generatorId&&delegateSite(inst)){
        const object=ctx.controller.heap.get(current.generatorId),delegate=object.delegation;
        if(inst.op==='LOGICAL_JUMP'){
          const raw=event.operands[0],selected=raw?.[0]==='method'?raw[1]:null,
            prior=ctx.claims.at(-1)?.record,present=selected&&!['undefined','null'].includes(selected[0]);
          require(ctx,inst.arg.operator==='??'&&delegate?.phase==='ready'&&['return','throw'].includes(delegate.request.kind)&&
            raw?.length===3&&ctx.eq(raw[2],delegate.iterator)&&event.operands.length===1&&
            ctx.eq(event.result,['bool',!!present]),'delegated method guard changed its receiver or nullish decision');
          require(ctx,ctx.eq(prior?.key,['str',delegate.request.kind])&&
            (present?prior.kind==='generator.lookup'&&ctx.eq(prior.receiver,delegate.iterator)&&
              prior.method==='Generator.'+delegate.request.kind&&ctx.eq(selected,['builtinfn',prior.method]):
              ['generator.read','iterator.read'].includes(prior.kind)&&prior.object===delegate.iterator[1]&&ctx.eq(prior.result,selected)),
            'delegated method guard lacks its checked current method selection');
          // This is the frontend's internal GetMethod nullish guard, not a
          // source logical expression. The preceding lookup and the following
          // delegated call/absent-return record check the same selected method.
          return true;
        }
        if(inst.op==='INIT'&&/^\[\[delegate next /.test(inst.arg)){
          const method=event.result;require(ctx,method?.[0]==='method'&&method[1]?.[0]==='builtinfn'&&
            ['Iterator.next','Generator.next'].includes(method[1][1]),'delegation requires a qualified builtin iterator or generator next method');
          const frame=after(ctx,event,'frames',current.id);
          delegations.set(current.generatorId,{env:frame.envId,next:inst.arg,iterator:inst.arg.replace('delegate next ','delegate ')});
          emit(ctx,{kind:'generator.delegate.enter',object:current.generatorId,iterator:ctx.tag(method[2],event),next:method[1][1]},event);return true;
        }
        if(inst.op==='GET'&&/^\[\[delegate next /.test(inst.arg)){
          require(ctx,delegate&&ctx.eq(event.result,['method',['builtinfn',delegate.next],delegate.iterator]),'cached delegate next changed');return true;
        }
        if(inst.op==='REQUIRE_OBJECT'){
          require(ctx,event.result?.[0]==='ref'&&ctx.eq(event.result,event.operands[0]),'delegate call returned no ordinary object');
          if(delegate){
            const result=ctx.state.heap[event.result[1]];require(ctx,result?.properties?.done?.value?.[0]==='bool','delegate result needs its checked done value');
            emit(ctx,{kind:'generator.delegate.result',object:current.generatorId,result:event.result,done:result.properties.done.value[1]},event);
          }else require(ctx,['iterator','generator'].includes(ctx.state.heap[event.result[1]]?.kind),'custom iterable delegation requires its callable continuation');
          return true;
        }
        if(inst.op==='BINARY'){
          require(ctx,inst.arg==='==='&&event.operands.every(scalar),'delegate dispatch comparison');
          ctx.emit({kind:'compute',fields:{expr:{op:'binary',operator:'===',left:{op:'literal',value:event.operands[0]},
            right:{op:'literal',value:event.operands[1]}},result:event.result}},event,'source-generator-delegate-selection/1',{detail:true});return true;
        }
        if(['DELEGATE_RESUME_KIND','DELEGATE_RESUME_VALUE'].includes(inst.op)){
          require(ctx,delegate&&ctx.eq(event.result,inst.op==='DELEGATE_RESUME_KIND'?['str',delegate.request.kind]:delegate.request.value),
            'delegation changed its resumed completion input');return true;
        }
        if(inst.op==='DELEGATE_YIELD'){
          emit(ctx,{kind:'generator.delegate.yield',object:current.generatorId,result:ctx.tag(event.result,event)},event);
          yields.set(current.generatorId,(yields.get(current.generatorId)??0)+1);return true;
        }
        if(inst.op==='LEAVE_SCOPE'){
          emit(ctx,{kind:'generator.delegate.end',object:current.generatorId},event);delegations.delete(current.generatorId);return true;
        }
        if(inst.op==='RETURN'){
          require(ctx,delegate?.request.kind==='return','delegate return has no abrupt input');
          emit(ctx,delegate.phase==='complete'?{kind:'generator.delegate.end',object:current.generatorId}:
            {kind:'generator.delegate.absent',object:current.generatorId,method:'return'},event);delegations.delete(current.generatorId);return true;
        }
        if(inst.op==='ITERATOR_THROW_MISSING')ctx.refuse('generator: absent delegate throw requires its checked TypeError continuation');
        if(event.operation==='call.enter'&&event.operands[0]?.[1]?.[1]==='Iterator.next'){
          const changes=event.stateChanges.filter(change=>change.table==='heap'),result=changes.find(change=>change.id===event.result?.[1])?.after,
            iterator=delegate&&ctx.state.heap[delegate.iterator[1]];
          require(ctx,iterator?.kind==='iterator'&&result?.kind==='object'&&result.properties.done?.value[0]==='bool','delegate builtin step result');
          const done=result.properties.done.value[1],value=result.properties.value.value,pair=!done&&iterator.iterationKind==='entries'?
            changes.find(change=>change.before===null&&change.id===value[1])?.after:null;
          require(ctx,(!pair||pair.kind==='array')&&changes.every(change=>[iterator.id,result.id,pair?.id].includes(change.id)),
            'delegate builtin step has an undeclared allocation/effect');
          delegatedCall(ctx,event,inst,current,{kind:'iterator.next',object:iterator.id,name:result.id,entry:pair?.id??null,result:value,done});
          if(pair)ctx.markPublished(pair.id);ctx.markPublished(result.id);return true;
        }
      }
      if(current?.generatorId&&inst?.op==='TRY_ENTER'){
        const next=after(ctx,event,'frames',current.id).handlers.at(-1),name='handler'+(++handlerCounter);
        require(ctx,next&&next.catchPc===inst.arg.catchPc&&next.finallyPc===inst.arg.finallyPc&&next.afterPc===inst.arg.afterPc,
          'handler targets differ from its exact source declaration');
        handlerDefinitions.set(name,{catchPc:next.catchPc,finallyPc:next.finallyPc,afterPc:next.afterPc,
          envId:next.envId,stackDepth:next.stackDepth,loopDepth:next.loopDepth});
        emit(ctx,{kind:'generator.handler.enter',object:current.generatorId,name,catch:next.catchPc!==null,finally:next.finallyPc!==null},event);return true;
      }
      if(current?.generatorId&&inst?.op==='TRY_NORMAL'){
        emit(ctx,{kind:'generator.handler.route',object:current.generatorId,completion:{kind:'normal',value:U}},event);return true;
      }
      if(current?.generatorId&&inst?.op==='BIND_CATCH'){
        const top=ctx.controller.heap.get(current.generatorId).handlers.at(-1),frame=after(ctx,event,'frames',current.id);
        require(ctx,top?.phase==='catch','source catch has no selected handler');
        emit(ctx,{kind:'generator.handler.catch',object:current.generatorId,name:top.name,
          bind:inst.arg===null?null:ctx.cell(frame.envId,inst.arg)},event);return true;
      }
      if(current?.generatorId&&inst?.op==='END_FINALLY'){
        const top=ctx.controller.heap.get(current.generatorId).handlers.at(-1);
        require(ctx,top?.phase==='finally','source cleanup has no selected obligation');
        emit(ctx,{kind:'generator.handler.leave',object:current.generatorId,name:top.name},event);return true;
      }
      if(inst?.op==='GENERATOR_START'){
        require(ctx,current.generatorId&&ctx.eq(event.result,ref(current.generatorId)),'generator initial suspension identity');
        emit(ctx,{kind:'generator.start',object:current.generatorId},event);return true;
      }
      if(inst?.op==='YIELD'){
        require(ctx,current.generatorId,'yield has no retained generator');
        const result=resultObject(ctx,event,false);
        emit(ctx,{kind:'generator.yield',object:current.generatorId,value:ctx.tag(event.operands[0],event),name:result.id},event);
        ctx.markPublished(result.id);yields.set(current.generatorId,(yields.get(current.generatorId)??0)+1);return true;
      }
      if(current?.generatorId&&(['RETURN','THROW'].includes(inst?.op))&&['call.return','completion.throw'].includes(event.operation)){
        if(current.handlers.length)emit(ctx,{kind:'generator.handler.route',object:current.generatorId,
          completion:{kind:inst.op==='THROW'?'throw':'return',value:ctx.tag(event.operands[0],event)}},event);
        return true;
      }
      if(event.operation==='property.read'&&!row?.child){
        const raw=row?.result,selected=raw?.[0]==='method'?raw[1]:raw,receiver=row?.operands?.[0];
        if(receiver?.[0]!=='ref'||ctx.state.heap[receiver[1]]?.kind!=='generator')return false;
        if(selected?.[0]==='builtinfn')emit(ctx,{kind:'generator.lookup',receiver,key:ctx.key(row.operands[1]),method:selected[1]},event);
        else emit(ctx,{kind:'generator.read',object:receiver[1],key:ctx.key(row.operands[1]),result:ctx.tag(selected,event)},event);
        return true;
      }
      if(event.operation!=='call.enter')return false;
      const raw=event.operands[0],callee=raw?.[0]==='method'?raw[1]:raw,
        fn=callee?.[0]==='ref'?ctx.state.heap[callee[1]]:null;
      if(fn?.generatorFunction){
        const created=event.stateChanges.find(change=>change.table==='heap'&&change.before===null&&change.after?.kind==='generator')?.after,
          child=created&&after(ctx,event,'frames',created.frameId);
        require(ctx,created&&child&&created.functionId===fn.id,'generator creation must retain the exact called identity');
        const receiver=ctx.tag(raw[0]==='method'?raw[2]:U,event),args=event.operands.slice(1).map(value=>ctx.tag(value,event));
        emit(ctx,{kind:'generator.create',name:created.id,child:ctx.frame(child.id),callee:ctx.tag(callee,event),receiver,arguments:args},event);
        ctx.markPublished(created.id);creations.set(created.id,{callee:ctx.copy(callee),receiver,args});yields.set(created.id,0);
        bindFrame(ctx,event,child);return true;
      }
      if(callee?.[0]!=='builtinfn'||!['Generator.next','Generator.return','Generator.throw','Iterator.identity'].includes(callee[1]))return false;
      const receiver=raw?.[0]==='method'?raw[2]:null,node=receiver?.[0]==='ref'?ctx.state.heap[receiver[1]]:null;
      if(node?.kind!=='generator')return false;
      if(callee[1]==='Iterator.identity'){
        emit(ctx,{kind:'generator.identity',object:node.id,result:ctx.tag(event.result,event)},event);return true;
      }
      const method=callee[1].slice('Generator.'.length),argument=ctx.tag(event.operands[1]??U,event);
      if(node.state==='completed'||node.state==='suspendedStart'&&method!=='next'){
        const result=method==='throw'?null:resultObject(ctx,event,true);
        delegatedCall(ctx,event,inst,current,{kind:'generator.completed',object:node.id,method,argument,name:result?.id??null});
        if(result)ctx.markPublished(result.id);completed.add(event.eventId+':'+node.frameId);
        settleDelegatedThrow(ctx,event);
      }else{
        delegatedCall(ctx,event,inst,current,{kind:'generator.resume',object:node.id,method,argument});
        if(ctx.controller.heap.get(node.id).delegation)emit(ctx,{kind:'generator.delegate.receive',object:node.id},event);
        else if(method==='next')emit(ctx,{kind:'generator.receive',object:node.id,bind:null},event);
        else if(ctx.getOwnedFrame(node.frameId).handlers.length)emit(ctx,{kind:'generator.handler.route',object:node.id,
          completion:{kind:method,value:argument}},event);
      }
      return true;
    },
    completeFrame(ctx,change,event){
      if(change.after.generatorId)return finish(ctx,change,event);
      if(change.after.completion?.type!=='throw'||event.operation!=='completion.throw')return false;
      const affected=event.stateChanges.filter(row=>row.table==='frames'&&row.after?.generatorId&&
        row.before?.generatorId===row.after.generatorId&&row.before.handlers?.length!==row.after.handlers?.length);
      require(ctx,affected.length===1,'abrupt iterator callback must change one retained generator completion');
      const generatorId=affected[0].after.generatorId,completion=change.after.completion,value=ctx.tag(completion.value.value,event),
        invocation=ctx.frame(change.id);
      require(ctx,invocation===ctx.controller.stack.at(-1)&&ctx.controller.heap.get(generatorId)?.kind==='generator',
        'abrupt iterator callback must unwind before its generator completion');
      emit(ctx,{kind:'throw',invocation,value},event,'owned-generator-callback-throw/1');
      const generator=ctx.controller.heap.get(generatorId);
      require(ctx,ctx.controller.stack.at(-1)===generator.invocation,'throwing callback did not restore the generator continuation');
      emit(ctx,{kind:'generator.handler.route',object:generatorId,completion:{kind:'throw',value}},event);
      return true;
    },
    checkHeap(ctx,node){
      const actual=ctx.controller.heap.get(node.id);require(ctx,actual,'generator-owned heap identity is absent');
      if(node.generatorFunction)require(ctx,actual.generatorFunction===true&&node.nonConstructible===true&&!node.async&&
        (node.prototypeInitialized===undefined||node.prototypeInitialized===true),
        'generator callable capability differs');
      if(node.kind==='generator'){
        const saved=creations.get(node.id);require(ctx,saved&&actual.kind==='generator'&&actual.invocation===ctx.frame(node.frameId)&&
          ctx.eq(actual.callee,ref(node.functionId))&&ctx.eq(actual.callee,saved.callee)&&ctx.eq(actual.receiver,saved.receiver)&&
          ctx.eq(actual.arguments,saved.args)&&actual.phase===node.state&&actual.yielded===yields.get(node.id)&&
          Boolean(actual.delegation)===delegations.has(node.id)&&actual.resume===null&&actual.pending===null,'retained generator identity, phase or arguments differ');
        checkOrdinary(ctx,node);
      }
      return true;
    },
    checkFrame(ctx,node,event){
      require(ctx,!node.awaiting&&!node.asyncPromiseId,'generator async continuation needs its own profile');
      const object=ctx.controller.heap.get(node.generatorId),saved=creations.get(node.generatorId);
      require(ctx,object&&saved&&ctx.controller.frameFunctions.get(ctx.frame(node.id))===ctx.functionCodes.get(node.codeId)&&
        object.invocation===ctx.frame(node.id)&&ctx.eq(node.thisValue,object.receiver),'retained generator invocation/receiver differs');
      const expected=node.status==='suspended-generator'?object.phase.startsWith('suspended'):
        ['completed','thrown'].includes(node.status)?object.phase==='completed':['initializing','executing'].includes(object.phase);
      require(ctx,expected,'retained generator status differs');
      const definition=delegations.get(node.generatorId),delegate=object.delegation;
      require(ctx,Boolean(definition)===Boolean(delegate),'retained generator delegation differs');
      if(delegate){
        const env=after(ctx,event,'envs',definition.env),next=env?.bindings?.[definition.next]?.token?.value,
          iterator=env?.bindings?.[definition.iterator]?.token?.value;
        require(ctx,ctx.eq(next,['method',['builtinfn',delegate.next],delegate.iterator])&&ctx.eq(iterator,delegate.iterator),
          'retained delegate iterator or cached method differs');
        if(node.delegateResume)require(ctx,ctx.eq({kind:node.delegateResume.kind,value:node.delegateResume.value.value},delegate.request),
          'retained delegate resume input differs');
      }
      require(ctx,!node.delegateYield||delegate?.phase==='yielded'&&node.status==='suspended-generator','retained delegated suspension differs');
      require(ctx,node.handlers.length===object.handlers.length,'generator handler depth differs');
      for(let i=0;i<node.handlers.length;i++){
        const owned=node.handlers[i],selected=object.handlers[i],definition=handlerDefinitions.get(selected.name);
        require(ctx,definition&&Object.entries(definition).every(([key,value])=>owned[key]===value)&&
          selected.phase===owned.phase&&selected.catch===(owned.catchPc!==null)&&selected.finally===(owned.finallyPc!==null)&&
          ctx.eq(selected.caught,owned.caught?.value??null),'generator handler identity, phase or caught value differs');
        if(owned.pending&&(!['normal','return','throw'].includes(owned.pending.type)))ctx.refuse('generator loop completion requires a checked handler target');
        const pending=owned.pending?{kind:owned.pending.type,value:owned.pending.type==='normal'?U:owned.pending.value.value}:null;
        require(ctx,ctx.eq(selected.pending,pending),'generator pending cleanup completion differs');
      }
      return true;
    }
  };
}
