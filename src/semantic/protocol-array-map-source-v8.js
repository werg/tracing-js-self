// A producer-only expansion of bounded map into existing property and call
// records. Every callback and output write remains a public state transition;
// serving needs no private array-method cursor or callback evaluator.
export const ARRAY_MAP_SOURCE_PROFILE_V8='ordinary-array-map-source/1';
const U=['undefined'],ref=id=>['ref',id],num=value=>['num',value];
const pendingFields=['method','arrayId','callbackId','outputId','length','index','accumulator','waitingFrameId','siteId','currentValue','thisArg'];
const checked=(ctx,condition,message)=>{if(!condition)ctx.refuse('array map: '+message);};
const patched=(ctx,event,table,id)=>event.stateChanges.find(change=>change.table===table&&change.id===id)?.after??ctx.state[table][id];

export function createArrayMapSourceAdapterV8(){
  let plans=new Map(),callbacks=new Map();
  function input(ctx,value){
    const node=value?.[0]==='ref'?ctx.state.heap[value[1]]:null;
    checked(ctx,node?.kind==='array'&&[undefined,'Array.prototype'].includes(node.prototype)&&
      ctx.descriptor(node,'map')===null&&ctx.descriptor(node,'constructor')===null&&Object.keys(node.accessors??{}).length===0,
      'requires an ordinary array with unchanged map and species selection');
    const length=node.properties.length?.value;
    checked(ctx,length?.[0]==='num'&&Number.isSafeInteger(length[1])&&length[1]>=0&&length[1]<=4096,'bounded own array length');
    return node;
  }
  function invoke(ctx,event,plan){
    // Array#map snapshots length, then tests each index against the live heap.
    // The declared ordinary prototype has no indexed inherited properties, so
    // an absent own slot is a checked hole. Never turn it into undefined or
    // evaluate the callback for it. Existing dense projections stay identical.
    const array=ctx.state.heap[plan.arrayId];
    checked(ctx,array?.kind==='array'&&[undefined,'Array.prototype'].includes(array.prototype),
      'inherited indexed properties need their own iteration profile');
    for(;plan.index<plan.length;plan.index++){
      const descriptor=ctx.descriptor(array,String(plan.index));
      checked(ctx,descriptor===null||descriptor.kind==='data','index accessor requires a getter continuation');
      if(descriptor!==null)break;
      ctx.emit({kind:'property.hasOwn',object:plan.arrayId,key:['str',String(plan.index)],result:['bool',false]},
        event,'owned-source-map-hole/1');
    }
    if(plan.index===plan.length){
      const parent=patched(ctx,event,'frames',plan.parent);
      checked(ctx,!event.causes?.some(cause=>cause.kind==='invocation')&&!parent.pendingArrayMethod&&
        ctx.eq(event.result,ref(plan.outputId))&&ctx.eq(parent.stack.at(-1)?.value,ref(plan.outputId)),
        'exhausted sparse map must return its original result without another callback');
      plans.delete(plan.parent);return;
    }
    const child=event.causes?.find(cause=>cause.kind==='invocation')?.frameId,
      frame=child?event.stateChanges.find(change=>change.table==='frames'&&change.id===child&&change.before===null)?.after:null,
      pending=patched(ctx,event,'frames',plan.parent)?.pendingArrayMethod,
      fn=ctx.state.heap[plan.callbackId],value=ctx.state.heap[plan.arrayId].properties[String(plan.index)]?.value;
    checked(ctx,frame&&fn?.kind==='function'&&!fn.async&&
      frame.codeId===fn.codeId&&frame.callerFrameId===plan.parent&&pending?.waitingFrameId===child&&value,
      'callback lost its original closure, index or caller');
    const receiver=fn.arrow?fn.lexicalThis:plan.thisArg,arguments_=[value,num(plan.index),ref(plan.arrayId)],
      environment=event.stateChanges.find(change=>change.table==='envs'&&change.before===null&&change.id===frame.envId)?.after,
      parameters=ctx.bundle.programs[fn.codeId].params;
    checked(ctx,ctx.eq(frame.thisValue,receiver)&&environment?.parent===fn.closureEnvId&&
      parameters.every((name,index)=>ctx.eq(environment.bindings[name]?.token?.value,arguments_[index]??U)),
      'callback activation changed receiver or effective arguments');
    ctx.emit({kind:'property.get',object:plan.arrayId,key:['str',String(plan.index)],receiver:ref(plan.arrayId),result:ctx.tag(value,event)},event,'owned-source-map-element/1');
    if(fn.generatorFunction){
      const created=event.stateChanges.find(change=>change.table==='heap'&&change.id===frame.generatorId)?.after;
      checked(ctx,frame.generatorId&&created?.kind==='generator'&&created.functionId===plan.callbackId,
        'generator callback must retain its exact created instance');
      const synthetic={...event,invocationId:child,operands:[['method',ref(plan.callbackId),ctx.tag(receiver,event)],
        ...arguments_.map((value,index)=>index===1?ctx.copy(value):ctx.tag(value,event))]};
      ctx.delegateEvent('synchronous-generator-source/1',synthetic,null);
      plan.waitingFrameId=child;plan.currentValue=ctx.copy(value);
      plan.generatorCallback=true;plan.currentGenerator=frame.generatorId;callbacks.set(child,plan);return;
    }
    checked(ctx,!ctx.bundle.programs[fn.codeId]?.generator,'non-generator map callback has generator metadata');
    ctx.emit({kind:'call',child:ctx.frame(child),callee:ctx.tag(ref(plan.callbackId),event),receiver:ctx.tag(plan.thisArg,event),
      arguments:arguments_.map((value,index)=>index===1?ctx.copy(value):ctx.tag(value,event))},event,'owned-source-map-callback/1');
    for(const [name,binding]of Object.entries(environment.bindings))if(binding.initialized){
      if(parameters.indexOf(name)===1&&typeof ctx.bindDerived==='function')
        ctx.bindDerived(ctx.cell(environment.id,name),binding.token.value,event);
      else ctx.bind(ctx.cell(environment.id,name),binding.token.value,event);
    }
    plan.waitingFrameId=child;plan.currentValue=ctx.copy(value);callbacks.set(child,plan);
  }
  function checkFrame(ctx,node){
    const pending=node.pendingArrayMethod,plan=plans.get(node.id);
    if(!pending)return !plan;
    checked(ctx,plan&&Object.keys(pending).length===pendingFields.length&&pendingFields.every(key=>Object.hasOwn(pending,key)),
      'undeclared retained continuation fields');
    const expected={method:'map',arrayId:plan.arrayId,callbackId:plan.callbackId,outputId:plan.outputId,length:plan.length,
      index:plan.index,accumulator:U,waitingFrameId:plan.waitingFrameId,siteId:plan.siteId,currentValue:plan.currentValue,thisArg:plan.thisArg};
    checked(ctx,ctx.eq(pending,expected),'retained continuation differs from its expanded calls');
    return true;
  }
  return {id:ARRAY_MAP_SOURCE_PROFILE_V8,
    completionWritesHandled:true,
    captureState:()=>({plans:[...plans],callbacks:[...callbacks]}),
    restoreState(state){plans=new Map(state.plans);callbacks=new Map(state.callbacks);},
    frameFields(node){return node.pendingArrayMethod?['pendingArrayMethod']:null;},checkFrame,
    beforeEvent(ctx,event){
      for(const plan of plans.values())for(const change of event.stateChanges)
        if(change.table==='heap'&&change.id===plan.arrayId&&!ctx.eq(change.before,change.after))
          checked(ctx,change.after?.kind==='array'&&[undefined,'Array.prototype'].includes(change.after.prototype)&&
            Object.keys(change.after.accessors??{}).length===0,
            'prototype/accessor mutation during a callback requires its broader iteration profile');
    },
    event(ctx,event,row){
      const generatorCallback=callbacks.get(event.invocationId);
      if(generatorCallback?.generatorCallback&&event.operation==='call.return'){
        const object=generatorCallback.currentGenerator??ctx.state.frames[event.invocationId]?.generatorId,
          generator=(object&&event.stateChanges.find(change=>change.table==='heap'&&change.id===object)?.after)??
            (object&&ctx.state.heap[object]),value=event.result;
        checked(ctx,generator?.kind==='generator'&&generator.functionId===generatorCallback.callbackId&&
          value?.[0]==='ref'&&value[1]===object&&generator.state==='suspendedStart',
          'generator callback did not return its exact initial generator');
        const frame=ctx.state.frames[event.invocationId],start=frame&&ctx.bundle.programs[frame.codeId]?.instructions[frame.pc];
        checked(ctx,frame?.generatorId===object&&start?.op==='GENERATOR_START','generator callback start must match its retained initial frame');
        ctx.delegateEvent('synchronous-generator-source/1',{...event,operation:'generator.start',codeId:frame.codeId,
          siteId:start.siteId,result:ref(object)},null);
        ctx.emit({kind:'property.set',object:generatorCallback.outputId,key:['str',String(generatorCallback.index)],
          receiver:ref(generatorCallback.outputId),value:ctx.tag(value,event),success:true},event,'owned-source-map-generator-result/1');
        callbacks.delete(event.invocationId);generatorCallback.index++;generatorCallback.waitingFrameId=null;
        delete generatorCallback.generatorCallback;delete generatorCallback.currentGenerator;
        if(generatorCallback.index===generatorCallback.length)plans.delete(generatorCallback.parent);
        return true;
      }
      if(callbacks.has(event.invocationId)&&event.stateChanges.some(change=>change.table==='frames'&&change.id===event.invocationId&&
        ['completed','thrown'].includes(change.after?.status)))return true;
      const plan=plans.get(event.invocationId);
      if(plan&&plan.waitingFrameId===null&&event.operation==='call.enter'){
        checked(ctx,(event.operands??[]).length===0&&plan.index<plan.length,'continuation has no next callback');invoke(ctx,event,plan);return true;
      }
      if(!row)return false;
      const selected=row.result?.[0]==='method'?row.result[1]:row.result;
      if(event.operation==='property.read'&&!row.child&&ctx.eq(selected,['builtinfn','Array.prototype.map'])){
        input(ctx,row.operands[0]);return true;
      }
      const raw=row.operands[0],callee=raw?.[0]==='method'?raw[1]:raw;
      if(event.operation!=='call.enter'||!ctx.eq(callee,['builtinfn','Array.prototype.map']))return false;
      checked(ctx,raw[0]==='method'&&row.operands.length>=2&&row.operands.length<=3,'requires its original receiver and one owned callback');
      const source=input(ctx,raw[2]),callback=row.operands[1],fn=callback?.[0]==='ref'?ctx.state.heap[callback[1]]:null,
        output=event.stateChanges.find(change=>change.table==='heap'&&change.before===null&&change.after?.kind==='array')?.after,
        length=source.properties.length.value[1];
      checked(ctx,fn?.kind==='function'&&!fn.async&&output&&
        Object.keys(output.properties).length===1&&ctx.eq(output.properties.length.value,num(length)),
        'callback or fresh result allocation is outside the bounded profile');
      const generatorAllocations=event.stateChanges.filter(change=>change.table==='heap'&&change.before===null&&change.after?.kind==='generator');
      const callbackStarted=event.causes?.some(cause=>cause.kind==='invocation')??false;
      checked(ctx,(fn.generatorFunction&&callbackStarted?generatorAllocations.length===1:generatorAllocations.length===0)&&
        event.stateChanges.filter(change=>change.table==='heap').length===1+generatorAllocations.length,
        'undeclared allocation during map entry');
      ctx.emit({kind:'property.get',object:source.id,key:['str','length'],receiver:raw[2],result:num(length)},event,'owned-source-map-length/1');
      ctx.publish(output,event);
      if(!length){checked(ctx,!row.child&&ctx.eq(row.result,ref(output.id)),'empty map must return its fresh empty result');return true;}
      const pending=patched(ctx,event,'frames',event.invocationId)?.pendingArrayMethod;
      const next={parent:event.invocationId,arrayId:source.id,callbackId:callback[1],outputId:output.id,length,index:0,
        waitingFrameId:null,siteId:event.siteId,currentValue:U,thisArg:row.operands[2]??U};
      checked(ctx,(!callbackStarted||pending?.method==='map')&&!plans.has(next.parent),'duplicate or changed map continuation');
      plans.set(next.parent,next);invoke(ctx,event,next);return true;
    },
    completeFrame(ctx,change,event){
      const plan=callbacks.get(change.id);if(!plan)return false;
      const completion=change.after.completion;
      checked(ctx,['return','throw'].includes(completion?.type)&&completion.value?.value&&plan.waitingFrameId===change.id,
        'callback completion must match its retained map invocation');
      if(completion.type==='throw'){
        const value=ctx.tag(completion.value.value,event),invocation=ctx.frame(change.id);
        checked(ctx,invocation===ctx.controller.stack.at(-1),'thrown map callback is not the active public call');
        ctx.emit({kind:'throw',invocation,value},event,'owned-source-map-throw/1');
        callbacks.delete(change.id);plans.delete(plan.parent);
        return true;
      }
      const value=ctx.tag(completion.value.value,event),output=patched(ctx,event,'heap',plan.outputId);
      checked(ctx,ctx.eq(output.properties[String(plan.index)]?.value,value),'callback result was not written to the matching map index');
      ctx.emit({kind:'return',invocation:ctx.frame(change.id),value},event,'owned-source-map-return/1');
      ctx.emit({kind:'property.set',object:plan.outputId,key:['str',String(plan.index)],receiver:ref(plan.outputId),value,success:true},event,'owned-source-map-result/1');
      callbacks.delete(change.id);plan.index++;plan.waitingFrameId=null;
      if(plan.index===plan.length){
        const parent=patched(ctx,event,'frames',plan.parent);
        checked(ctx,!parent.pendingArrayMethod&&ctx.eq(parent.stack.at(-1)?.value,ref(plan.outputId)),'completed map did not return its original result');
        plans.delete(plan.parent);
      }
      return true;
    }
  };
}
