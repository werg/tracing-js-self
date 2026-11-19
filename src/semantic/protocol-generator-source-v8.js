// Teacher-only generator projection. No archived frame, operand stack or program
// counter becomes a public record; lifecycle transitions use the shared heap.
import {GENERATOR_INTRINSICS_V8} from './protocol-generator-v8.js';
import {describeProtocolObjectV8} from './protocol-state-v8.js';

export const GENERATOR_SOURCE_PROFILE_V8='synchronous-generator-source/1';
const U=['undefined'],ref=id=>['ref',id];
const scalar=value=>Array.isArray(value)&&['undefined','null','bool','str','num','bigint','ref','symbol'].includes(value[0]);
const instanceFields=['frameId','functionId','prototype','state','properties','propertyVersions','shapeVersion','propertyOrder','accessors','dataAttributes','extensible'];
const after=(ctx,event,table,id)=>event.stateChanges.find(change=>change.table===table&&change.id===id)?.after??ctx.state[table]?.[id];
const require=(ctx,condition,message)=>{if(!condition)ctx.refuse('generator: '+message);};

export function createGeneratorSourceAdapterV8({bundle}){
  if(!Object.values(bundle.programs).some(program=>program.generator))return null;
  const creations=new Map(),yields=new Map(),completed=new Set(),handlerDefinitions=new Map();let handlerCounter=0;
  const emit=(ctx,record,event)=>ctx.emit(record,event,'owned-generator-protocol/1');
  const instruction=(ctx,event)=>{const frame=ctx.getOwnedFrame(event.invocationId),candidate=bundle.programs[event.codeId]?.instructions[frame?.pc];
    return candidate?.siteId===event.siteId?candidate:null;};
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
    if(node.kind==='generator'){
      const actual=describeProtocolObjectV8(ctx.controller,node.id);
      require(ctx,actual.kind==='generator'&&ctx.eq(actual.prototype,ctx.prototype(node))&&actual.extensible===(node.extensible!==false),
        'generator ordinary prototype/extensibility changed');
      require(ctx,!Object.keys(node.accessors??{}).length&&!Object.keys(node.properties??{}).length,
        'generator own-property source extension requires its declared descriptor profile');
      require(ctx,actual.properties.length===0,'generator own properties differ');
    }
  }
  function finish(ctx,change,event){
    if(completed.has(event.eventId+':'+change.id))return true;
    const frame=change.after;if(!frame.generatorId)return false;
    const object=ctx.controller.heap.get(frame.generatorId),value=frame.completion?.value?.value,
      kind=frame.completion?.type==='throw'?'throw':'return';
    require(ctx,object&&scalar(value)&&object.invocation===ctx.publicInvocation,'generator completion invocation/value');
    let result=null;if(kind==='return')result=resultObject(ctx,event,true);
    emit(ctx,{kind:'generator.finish',object:frame.generatorId,completion:{kind,value:ctx.tag(value,event)},name:result?.id??null},event);
    if(result)ctx.markPublished(result.id);completed.add(event.eventId+':'+change.id);return true;
  }
  return {id:GENERATOR_SOURCE_PROFILE_V8,
    syntax(node){if(node.type!=='YieldExpression')return false;
      if(node.delegate)throw new TypeError('Generator delegation requires its checked continuation extension');return true;},
    program(program){return program.generator===true&&program.strict&&!program.async&&!program.parameterExpressions&&program.restIndex<0;},
    heapFields(node){return node.kind==='generator'?instanceFields:node.generatorFunction?['generatorFunction','prototypeInitialized']:
      GENERATOR_INTRINSICS_V8.includes(node.prototype)?[]:null;},
    frameFields(node){return node.generatorId?['generatorId']:null;},
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
        emit(ctx,{kind:'generator.completed',object:node.id,method,argument,name:result?.id??null},event);
        if(result)ctx.markPublished(result.id);completed.add(event.eventId+':'+node.frameId);
      }else{
        emit(ctx,{kind:'generator.resume',object:node.id,method,argument},event);
        if(method==='next')emit(ctx,{kind:'generator.receive',object:node.id,bind:null},event);
        else if(ctx.getOwnedFrame(node.frameId).handlers.length)emit(ctx,{kind:'generator.handler.route',object:node.id,
          completion:{kind:method,value:argument}},event);
      }
      return true;
    },
    completeFrame:finish,
    checkHeap(ctx,node){
      const actual=ctx.controller.heap.get(node.id);require(ctx,actual,'generator-owned heap identity is absent');
      if(node.generatorFunction)require(ctx,actual.generatorFunction===true&&node.nonConstructible===true&&!node.async&&
        (node.prototypeInitialized===undefined||node.prototypeInitialized===true),
        'generator callable capability differs');
      if(node.kind==='generator'){
        const saved=creations.get(node.id);require(ctx,saved&&actual.kind==='generator'&&actual.invocation===ctx.frame(node.frameId)&&
          ctx.eq(actual.callee,ref(node.functionId))&&ctx.eq(actual.callee,saved.callee)&&ctx.eq(actual.receiver,saved.receiver)&&
          ctx.eq(actual.arguments,saved.args)&&actual.phase===node.state&&actual.yielded===yields.get(node.id)&&
          actual.delegation===null&&actual.resume===null&&actual.pending===null,'retained generator identity, phase or arguments differ');
        checkOrdinary(ctx,node);
      }
      return true;
    },
    checkFrame(ctx,node){
      require(ctx,!node.awaiting&&!node.asyncPromiseId,'generator async continuation needs its own profile');
      const object=ctx.controller.heap.get(node.generatorId),saved=creations.get(node.generatorId);
      require(ctx,object&&saved&&ctx.controller.frameFunctions.get(ctx.frame(node.id))===ctx.functionCodes.get(node.codeId)&&
        object.invocation===ctx.frame(node.id)&&ctx.eq(node.thisValue,object.receiver),'retained generator invocation/receiver differs');
      const expected=node.status==='suspended-generator'?object.phase.startsWith('suspended'):
        ['completed','thrown'].includes(node.status)?object.phase==='completed':['initializing','executing'].includes(object.phase);
      require(ctx,expected,'retained generator status differs');
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
