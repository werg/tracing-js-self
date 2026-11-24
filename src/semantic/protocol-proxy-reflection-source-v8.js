// Source authority for reflection calls and retained synchronous trap frames.
import {ordinaryGet} from '../spec-operations.js';
import {PROXY_REFLECTION_OPERATIONS_V8} from './protocol-proxy-reflection-v8.js';
export const PROXY_REFLECTION_SOURCE_V8='proxy-reflection-source/1';
const builtin=value=>{const v=value?.[0]==='method'?value[1]:value;return v?.[0]==='builtinfn'?v[1]:null;};
const truthy=v=>!['null','undefined'].includes(v?.[0])&&(v?.[0]==='bool'?v[1]:
  v?.[0]==='str'?v[1].length>0:v?.[0]==='num'?Number(v[1])!==0&&!Number.isNaN(Number(v[1])):
  v?.[0]==='bigint'?v[1]!=='0':true);
const thrown=frame=>frame?.completion?.type==='throw'?frame.completion.value:
  [...(frame?.handlers??[])].reverse().flatMap(h=>[h.caught,h.pending?.type==='throw'?h.pending.value:null]).find(v=>v?.value?.[0]==='ref')??null;
export function createProxyReflectionSourceAdapterV8(){
  let active=new Map(),callbacks=new Map(),next=0;
  const require=(ctx,test,message)=>{if(!test)ctx.refuse('Proxy reflection source: '+message);};
  const emit=(ctx,record,event)=>ctx.emit(record,event,'owned-proxy-reflection/1');
  function route(ctx,object,operation,event){
    const rows=[],seen=new Set();let id=object;
    for(;;){
      const node=ctx.state.heap[id];if(node?.kind!=='proxy')break;
      require(ctx,!seen.has(id)&&rows.length<64,'route cycle/bound');seen.add(id);
      const found=ordinaryGet(ctx.state.heap,['ref',node.handlerId],operation);
      require(ctx,found,'GetMethod getter requires explicit continuation');
      const method=ctx.tag(found.method.value,event);
      rows.push({object:id,target:['ref',node.targetId],handler:['ref',node.handlerId],method});
      if(!['undefined','null'].includes(method[0]))break;id=node.targetId;
    }
    require(ctx,rows.length,'missing proxy route');return rows;
  }
  return {id:PROXY_REFLECTION_SOURCE_V8,
    captureState:()=>({active:[...active],callbacks:[...callbacks],next}),
    restoreState(saved){active=new Map(saved.active);callbacks=new Map(saved.callbacks);next=saved.next;},
    frameFields:frame=>frame.pendingProxyReflection?['pendingProxyReflection']:null,
    event(ctx,event,row){
      if(event.operation==='call.return'&&callbacks.has(event.invocationId)){
        const entry=callbacks.get(event.invocationId),owner=event.stateChanges.find(c=>c.table==='frames'&&c.id===entry.parent)?.after,
          output=owner?.stack?.at(-1)?.value,child=event.stateChanges.find(c=>c.table==='frames'&&c.id===event.invocationId)?.after;
        for(const change of event.stateChanges.filter(c=>c.table==='heap'&&c.before===null&&c.after?.declaredError!=='TypeError')){
          if(['getOwnPropertyDescriptor','ownKeys'].includes(entry.operation)&&output?.[0]==='ref'&&change.id===output[1]&&
            !ctx.eq(output,child?.completion?.value?.value))continue;
          ctx.publish(change.after,event);
        }
        return true;
      }
      const caller=builtin(row?.operands?.[0]??event.operands?.[0]),operation=caller?.split('.')[1];
      if(event.operation!=='call.enter'||!PROXY_REFLECTION_OPERATIONS_V8.includes(operation))return false;
      const object=row?.operands?.[1]??event.operands?.[1],node=object?.[0]==='ref'?ctx.state.heap[object[1]]:null;
      if(node?.kind!=='proxy')return false;
      require(ctx,event.completion?.type!=='throw','direct reflection fault requires its explicit source boundary');
      ctx.tag(['intrinsic','Object.prototype'],event);
      const args=operation==='setPrototypeOf'?[ctx.tag(row.operands[2]??['undefined'],event)]:
        operation==='getOwnPropertyDescriptor'?[ctx.key(row.operands[2]??['undefined'])]:[],selectedRoute=route(ctx,node.id,operation,event);
      if(!row.child){
        const creates=['getOwnPropertyDescriptor','ownKeys'].includes(operation),value=creates?row.result:ctx.tag(row.result,event);
        emit(ctx,{kind:'proxy.reflect.direct',object:node.id,operation,caller,arguments:args,result:value,route:selectedRoute},event);
        if(creates&&value[0]==='ref')ctx.markPublished(value[1]);return true;
      }
      const parent=event.stateChanges.find(c=>c.table==='frames'&&c.id===event.invocationId)?.after,
        child=event.stateChanges.find(c=>c.table==='frames'&&c.id===row.child)?.after,pending=parent?.pendingProxyReflection,
        last=selectedRoute.at(-1),callee=last.method,fn=ctx.state.heap[callee?.[1]],program=ctx.bundle.programs[fn?.codeId],
        env=event.stateChanges.find(c=>c.table==='envs'&&c.id===child?.envId)?.after;
      require(ctx,pending&&child&&pending.waitingFrameId===child.id&&!active.has(parent.id)&&pending.operation===operation&&
        pending.caller===caller&&ctx.eq(pending.object,object)&&ctx.eq(pending.route,selectedRoute)&&
        ctx.eq(pending.target,last.target)&&ctx.eq(pending.handler,last.handler)&&ctx.eq(pending.callee,callee)&&
        pending.arguments.length===args.length&&pending.arguments.every((v,i)=>ctx.eq(ctx.tag(v,event),args[i])),
        'retained runtime arguments or route differs');
      require(ctx,fn?.kind==='function'&&!fn.async&&!program.generator&&child.codeId===fn.codeId&&env?.parent===fn.closureEnvId,
        'selected synchronous source callback/closure');
      const id='proxyreflection'+(++next),entry={id,parent:parent.id,child:child.id,object:node.id,operation,caller,
        arguments:args,route:selectedRoute,target:last.target,handler:last.handler,callee};
      emit(ctx,{kind:'proxy.reflect.call',id,object:node.id,operation,caller,arguments:args,child:ctx.frame(child.id),route:selectedRoute},event);
      require(ctx,ctx.eq(ctx.controller.receiver,ctx.tag(child.thisValue,event)),'effective callback receiver');
      const expected=[last.target,...args];
      require(ctx,program.params.every((name,i)=>env.bindings[name]?.initialized&&
        ctx.eq(ctx.tag(env.bindings[name].token.value,event),expected[i]??['undefined'])),'callback parameter values');
      active.set(parent.id,entry);callbacks.set(child.id,entry);
      for(const [name,binding]of Object.entries(env.bindings))if(binding.initialized)ctx.bind(ctx.cell(env.id,name),binding.token.value,event);
      return true;
    },
    completeFrame(ctx,change,event){
      const entry=callbacks.get(change.id);if(!entry)return false;
      const completion=change.after.completion,raw=completion?.value?.value;
      require(ctx,['return','throw'].includes(completion?.type)&&raw&&ctx.publicInvocation===ctx.frame(change.id),
        'completion belongs to selected callback');
      const value=ctx.tag(raw,event);emit(ctx,{kind:completion.type,invocation:ctx.frame(change.id),value},event);
      const owner=event.stateChanges.find(c=>c.table==='frames'&&c.id===entry.parent)?.after,error=thrown(owner),
        fresh=event.stateChanges.filter(c=>c.table==='heap'&&c.before===null&&c.id===error?.value?.[1]&&c.after?.declaredError==='TypeError');
      if(completion.type==='return'&&fresh.length){
        const node=fresh[0].after,properties=node.properties??{},origin=completion.value.origin;
        require(ctx,fresh.length===1&&error.origin===origin&&node.kind==='object'&&node.prototype==='TypeError.prototype'&&
          Object.keys(properties).length===1&&properties.message?.value?.[0]==='str'&&properties.message.origin===origin&&
          ctx.eq(node.dataAttributes?.message,{writable:true,enumerable:false,configurable:true}),
          'derived fault allocation/origin/descriptor differs');
        emit(ctx,{kind:'proxy.reflect.fault',id:entry.id,error:node.id},event);
        require(ctx,ctx.eq(ctx.controller.heap.get(node.id)?.properties.get('message'),properties.message.value),'derived native fault message differs');
        ctx.markPublished(node.id);
      }else{
        const creates=['getOwnPropertyDescriptor','ownKeys'].includes(entry.operation),
          normal=creates?owner?.stack?.at(-1)?.value:entry.operation==='getPrototypeOf'?value:
          entry.operation==='isExtensible'||entry.caller.startsWith('Reflect.')?['bool',truthy(raw)]:['ref',entry.object];
        require(ctx,normal,'normal reflection output');
        emit(ctx,{kind:'proxy.reflect.finish',id:entry.id,completion:{kind:completion.type==='throw'?'throw':'normal',
          value:completion.type==='throw'?value:normal}},event);
        if(creates&&completion.type==='return'&&normal[0]==='ref')ctx.markPublished(normal[1]);
      }
      active.delete(entry.parent);callbacks.delete(change.id);return true;
    },
    checkFrame(ctx,frame){
      const entry=active.get(frame.id),pending=frame.pendingProxyReflection;
      if(!entry){require(ctx,!pending,'unregistered continuation');return true;}
      const current=ctx.controller.protocol.proxyReflection?.pending.find(p=>p.id===entry.id);
      require(ctx,current&&pending&&pending.waitingFrameId===entry.child&&pending.operation===entry.operation&&
        pending.caller===entry.caller&&ctx.eq(pending.object,['ref',entry.object])&&ctx.eq(pending.route,entry.route)&&
        ctx.eq(pending.target,entry.target)&&ctx.eq(pending.handler,entry.handler)&&ctx.eq(pending.callee,entry.callee)&&
        pending.arguments.length===entry.arguments.length&&pending.arguments.every((v,i)=>ctx.eq(ctx.tag(v),entry.arguments[i]))&&
        current.parent===ctx.frame(frame.id)&&current.child===ctx.frame(entry.child),'retained continuation mismatch');
      return true;
    }
  };
}
