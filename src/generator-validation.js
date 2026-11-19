// Read-only linkage checks for retained owned generator continuations. This
// validator does not call the generator initializer or property resolver.
const intrinsicPrototypes=new Set(['Object.prototype','Array.prototype','Function.prototype',
  'GeneratorFunction.prototype','Generator.prototype','Iterator.prototype']);
const validPrototype=(heap,value)=>value===null||intrinsicPrototypes.has(value)||
  typeof value==='string'&&['object','array','function','generator'].includes(heap[value]?.kind);
export function validateGeneratorState(state,programs,fail,ids=null){
  for(const generator of ids?[...ids].map(id=>state.heap[id]):Object.values(state.heap)){
    if(generator.kind==='function'&&programs[generator.codeId]?.generator){
      if(generator.generatorFunction!==true||generator.nonConstructible!==true||
         !Object.hasOwn(generator,'prototype')||!validPrototype(state.heap,generator.prototype)||
         !generator.properties?.prototype||!same(generator.dataAttributes?.prototype,{writable:true,enumerable:false,configurable:false}))
        fail('Generator function lost its real prototype descriptor');
      continue;
    }
    if(generator.kind!=='generator')continue;
    const frame=state.frames[generator.frameId],program=programs[frame?.codeId];
    const fn=state.heap[generator.functionId];
    if(!frame||!program?.generator||frame.generatorId!==generator.id||frame.asyncPromiseId!==null||
       fn?.kind!=='function'||fn.generatorFunction!==true||fn.codeId!==frame.codeId||
       !Object.hasOwn(generator,'prototype')||!validPrototype(state.heap,generator.prototype)||
       !['initializing','executing','suspendedStart','suspendedYield','completed'].includes(generator.state))
      fail('Invalid owned generator continuation identity');
    if(['suspendedStart','suspendedYield'].includes(generator.state)){
      if(frame.status!=='suspended-generator'||frame.callerFrameId!==null||frame.completion?.type!=='return')
        fail('Generator suspension lost its retained frame');
      const previous=program.instructions[frame.pc-1]?.op;
      if(previous!==(generator.state==='suspendedStart'?'GENERATOR_START':frame.delegateYield?'DELEGATE_YIELD':'YIELD'))
        fail('Generator suspension has the wrong source cursor');
    }else if(generator.state==='completed'){
      if(!['completed','thrown'].includes(frame.status))fail('Completed generator has an active continuation');
    }else if(frame.status!=='running')fail('Running generator has no active frame state');
    if(frame.delegateResume&&(!['next','return','throw'].includes(frame.delegateResume.kind)||
       !Array.isArray(frame.delegateResume.value?.value)||generator.state!=='executing'))
      fail('Invalid delegated generator resume completion');
  }
}

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
/** Resume and suspension evidence is checked before applying archive patches. */
export function validateGeneratorEvent(state,event,programs,fail){
  const frame=state.frames[event.invocationId],instruction=programs[frame?.codeId]?.instructions[frame?.pc];
  const after=id=>event.stateChanges.find(p=>p.table==='frames'&&p.id===id)?.after;
  for(const patch of event.stateChanges){
    if(patch.table!=='heap'||patch.before!==null)continue;
    const node=patch.after;
    if(node?.kind==='function'&&programs[node.codeId]?.generator){
      if(!['MAKE_FUNCTION','DEF_FN'].includes(instruction?.op)||instruction.arg.codeId!==node.codeId)
        fail('Generator function allocation has no source definition');
      const arg=instruction.arg,raw=arg.name?['str',arg.name]:arg.inferredName?.stack?frame.stack.at(-1)?.value:['str',arg.inferredName??''];
      let name;
      if(raw?.[0]==='symbol'){
        const description=raw[1].startsWith('well-known:')?['str','Symbol.'+raw[1].slice(11)]:state.heap[raw[1]]?.description;
        if(!description)fail('Generator inferred Symbol name lost its description');
        name=description[0]==='undefined'?'':'['+description[1]+']';
      }else if(raw?.[0]==='num')name=raw[1]==='-0'?'0':String(raw[1]);
      else if(raw?.[0]==='null'||raw?.[0]==='undefined')name=raw[0];
      else name=String(raw?.[1]);
      const protoId=node.properties?.prototype?.value?.[1],prototype=event.stateChanges.find(p=>p.table==='heap'&&p.id===protoId);
      if(node.generatorFunction!==true||node.nonConstructible!==true||node.prototype!=='GeneratorFunction.prototype'||
         !same(node.properties?.name?.value,['str',name])||
         !same(node.properties?.length?.value,['num',programs[node.codeId].functionLength??programs[node.codeId].params.length])||
         !same(node.propertyOrder,['length','name','prototype'])||
         !same(node.dataAttributes,{length:{writable:false,enumerable:false,configurable:true},name:{writable:false,enumerable:false,configurable:true},prototype:{writable:true,enumerable:false,configurable:false}})||
         node.properties?.prototype?.value?.[0]!=='ref'||prototype?.before!==null||
         prototype.after?.kind!=='object'||prototype.after.prototype!=='Generator.prototype'||
         Object.keys(prototype.after.properties??{}).length!==0||Object.keys(prototype.after.accessors??{}).length!==0)
        fail('Generator function allocation lost name length or per-function prototype state');
    }
    if(node?.kind==='generator'){
      const fn=state.heap[node.functionId],created=after(node.frameId),env=event.stateChanges.find(p=>p.table==='envs'&&p.id===created?.envId)?.after;
      const supplied=fn?.properties?.prototype?.value??['undefined'];
      const prototype=supplied[0]==='ref'||supplied[0]==='intrinsic'?supplied[1]:'Generator.prototype';
      if(fn?.generatorFunction!==true||created?.codeId!==fn.codeId||env?.parent!==fn.closureEnvId||
         Object.hasOwn(fn.accessors??{},'prototype')||node.prototype!==prototype||node.state!=='initializing')
        fail('Generator allocation lost its exact callee and current prototype');
      if(instruction?.op==='CALL'){
        const callable=event.operands[0]?.[0]==='method'?event.operands[0][1]:event.operands[0];
        if(callable?.[0]==='ref'&&callable[1]!==node.functionId)fail('Generator allocation changed the actual called identity');
      }
    }
  }
  if(instruction?.op==='DELEGATE_YIELD'){
    const value=frame.stack.at(-1)?.value,next=after(frame.id);
    if(!next?.delegateYield||next.status!=='suspended-generator'||next.callerFrameId!==null||
       !same(event.result,value)||!same(next.completion?.value,{value,origin:event.eventId}))
      fail('Delegated yield lost its exact iterator result identity');
  }
  if(instruction?.op==='DELEGATE_RESUME_KIND'){
    if(!frame.delegateResume||!same(event.result,['str',frame.delegateResume.kind])||
       !same(after(frame.id)?.delegateResume,frame.delegateResume))
      fail('Delegated resume kind disagrees with retained completion');
  }
  if(instruction?.op==='DELEGATE_RESUME_VALUE'){
    if(!frame.delegateResume||!same(event.result,frame.delegateResume.value.value)||after(frame.id)?.delegateResume!==undefined)
      fail('Delegated resume value was not consumed exactly once');
  }
  const method=event.operands[0];
  if(instruction?.op==='CALL'&&method?.[0]==='method'&&method[1]?.[0]==='builtinfn'&&
     ['Generator.next','Generator.return','Generator.throw'].includes(method[1][1])){
    const generator=method[2]?.[0]==='ref'?state.heap[method[2][1]]:null,target=state.frames[generator?.frameId];
    if(generator?.state!=='suspendedYield'||!target?.delegateYield)return;
    const next=after(target.id),sent={value:event.operands[1]??['undefined'],origin:event.operandOrigins[1]??event.eventId};
    if(!next||next.delegateYield!==undefined||next.pc!==target.pc||!same(next.stack,target.stack)||
       !same(next.delegateResume,{kind:method[1][1].slice('Generator.'.length),value:sent})||event.completion)
      fail('Delegated generator completion was not forwarded intact');
  }
}
