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
    for(let index=0;index<length[1];index++)checked(ctx,ctx.descriptor(node,String(index))?.kind==='data','requires dense own data elements');
    return node;
  }
  function invoke(ctx,event,plan){
    const child=event.causes?.find(cause=>cause.kind==='invocation')?.frameId,
      frame=child?event.stateChanges.find(change=>change.table==='frames'&&change.id===child&&change.before===null)?.after:null,
      pending=patched(ctx,event,'frames',plan.parent)?.pendingArrayMethod,
      fn=ctx.state.heap[plan.callbackId],value=ctx.state.heap[plan.arrayId].properties[String(plan.index)]?.value;
    checked(ctx,frame&&fn?.kind==='function'&&!fn.async&&!ctx.bundle.programs[fn.codeId]?.generator&&
      frame.codeId===fn.codeId&&frame.callerFrameId===plan.parent&&pending?.waitingFrameId===child&&value,
      'callback lost its original closure, index or caller');
    const receiver=fn.arrow?fn.lexicalThis:plan.thisArg,arguments_=[value,num(plan.index),ref(plan.arrayId)],
      environment=event.stateChanges.find(change=>change.table==='envs'&&change.before===null&&change.id===frame.envId)?.after,
      parameters=ctx.bundle.programs[fn.codeId].params;
    checked(ctx,ctx.eq(frame.thisValue,receiver)&&environment?.parent===fn.closureEnvId&&
      parameters.every((name,index)=>ctx.eq(environment.bindings[name]?.token?.value,arguments_[index]??U)),
      'callback activation changed receiver or effective arguments');
    ctx.emit({kind:'property.get',object:plan.arrayId,key:['str',String(plan.index)],receiver:ref(plan.arrayId),result:ctx.tag(value,event)},event,'owned-source-map-element/1');
    ctx.emit({kind:'call',child:ctx.frame(child),callee:ctx.tag(ref(plan.callbackId),event),receiver:ctx.tag(plan.thisArg,event),
      arguments:arguments_.map(value=>ctx.tag(value,event))},event,'owned-source-map-callback/1');
    for(const [name,binding]of Object.entries(environment.bindings))if(binding.initialized)ctx.bind(ctx.cell(environment.id,name),binding.token.value,event);
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
    captureState:()=>({plans:[...plans],callbacks:[...callbacks]}),
    restoreState(state){plans=new Map(state.plans);callbacks=new Map(state.callbacks);},
    frameFields(node){return node.pendingArrayMethod?['pendingArrayMethod']:null;},checkFrame,
    beforeEvent(ctx,event){
      for(const plan of plans.values())for(const change of event.stateChanges)
        if(change.table==='heap'&&change.id===plan.arrayId&&!ctx.eq(change.before,change.after))
          ctx.refuse('array map: mutation of the source array during a callback needs its broader iteration profile');
    },
    event(ctx,event,row){
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
      checked(ctx,fn?.kind==='function'&&!fn.async&&!ctx.bundle.programs[fn.codeId]?.generator&&output&&
        Object.keys(output.properties).length===1&&ctx.eq(output.properties.length.value,num(length)),
        'callback or fresh result allocation is outside the bounded profile');
      checked(ctx,event.stateChanges.filter(change=>change.table==='heap').length===1,'undeclared allocation during map entry');
      ctx.emit({kind:'property.get',object:source.id,key:['str','length'],receiver:raw[2],result:num(length)},event,'owned-source-map-length/1');
      ctx.publish(output,event);
      if(!length){checked(ctx,!row.child&&ctx.eq(row.result,ref(output.id)),'empty map must return its fresh empty result');return true;}
      const pending=patched(ctx,event,'frames',event.invocationId)?.pendingArrayMethod;
      const next={parent:event.invocationId,arrayId:source.id,callbackId:callback[1],outputId:output.id,length,index:0,
        waitingFrameId:null,siteId:event.siteId,currentValue:U,thisArg:row.operands[2]??U};
      checked(ctx,pending?.method==='map'&&!plans.has(next.parent),'duplicate or changed map continuation');
      plans.set(next.parent,next);invoke(ctx,event,next);return true;
    },
    completeFrame(ctx,change,event){
      const plan=callbacks.get(change.id);if(!plan)return false;
      const completion=change.after.completion;
      checked(ctx,completion?.type==='return'&&completion.value?.value&&plan.waitingFrameId===change.id,
        'abrupt callback completion needs its explicit iteration completion profile');
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
