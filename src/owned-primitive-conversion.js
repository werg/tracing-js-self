// Retained ToPrimitive work shared by Number(object) and ToPropertyKey(object).
// The record is plain JSON. A callback is an owned frame, never a native getter,
// closure, Promise, or continuation. Scalar formatting is the only host leaf.
import {encode,decode} from './values.js';
import {symbolPropertyKey} from './property-keys.js';
import {ordinaryGet,ordinaryBuiltin} from './spec-operations.js';

const primitive=value=>['undefined','null','bool','str','num','bigint','symbol'].includes(value?.[0]);
const fault=message=>({fault:{name:'TypeError',message}});
export function createPrimitiveConversion(operation,input,siteId){
  if(!['Number','PropertyKey'].includes(operation))throw new Error('Unknown owned conversion goal');
  return {operation,input:structuredClone(input),siteId,index:-1,method:null,
    phase:'select',waitingFrameId:null,result:null};
}
export function advancePrimitiveConversion(pending,{heap,invoke}){
  if(!['Number','PropertyKey'].includes(pending.operation))throw new Error('Unknown owned conversion goal');
  const hint=pending.operation==='PropertyKey'?'string':'number',reads=[];
  const finish=value=>{
    if(['str','bigint'].includes(value[0])&&value[1].length>10000)
      throw new RangeError(pending.operation+' conversion scalar budget exceeded');
    if(pending.operation==='PropertyKey')
      return {done:true,value:value[0]==='symbol'?structuredClone(value):['str',String(decode(value))],reads};
    if(value[0]==='symbol')return {...fault('Cannot convert a Symbol value to a number'),reads};
    return {done:true,value:encode(Number(decode(value))),reads};
  };
  const accept=value=>{
    if(primitive(value))return finish(value);
    if(pending.index===-1)return {...fault('Symbol.toPrimitive must return a primitive'),reads};
    if(pending.index===1)return {...fault('Cannot convert object to primitive value'),reads};
    pending.index=1;pending.method=null;pending.waitingFrameId=null;pending.result=null;pending.phase='select';
    return null;
  };
  // A getter's returned method is retained. Looking up the property again here
  // would repeat its effects and could select an entirely different function.
  let selected=null;
  if(pending.phase==='getter-returned'){
    selected=pending.result;pending.result=null;pending.waitingFrameId=null;pending.phase='select';
  }else if(pending.phase==='returned'){
    const outcome=accept(pending.result);if(outcome)return outcome;
  }else if(pending.phase!=='select')throw new Error(pending.operation+' conversion is still waiting for its callback');
  const call=(method,args,phase)=>{
    pending.method=structuredClone(method);pending.waitingFrameId=invoke(method,pending.input,args);
    pending.result=null;pending.phase=phase;
    return {child:pending.waitingFrameId,reads};
  };
  for(;;){
    let method=selected;selected=null;
    if(method===null){
      const key=pending.index===-1?symbolPropertyKey('well-known:toPrimitive'):
        (hint==='string'?['toString','valueOf']:['valueOf','toString'])[pending.index],
        found=ordinaryGet(heap,pending.input,key,{accessors:true});
      if(!found)throw new TypeError(pending.operation+' conversion exotic property requires its owned protocol');
      reads.push(found.observation);
      if(found.accessor){
        const getter=found.accessor.get.value;
        if(getter[0]!=='undefined')return call(getter,[],'getter-waiting');
        method=['undefined'];
      }else method=found.method.value;
    }
    pending.method=structuredClone(method);
    if(pending.index===-1&&['undefined','null'].includes(method[0])){
      pending.index=0;pending.method=null;continue;
    }
    if(method[0]==='ref'&&heap[method[1]]?.kind==='function')
      return call(method,pending.index===-1?[['str',hint]]:[],'waiting');
    if(method[0]==='builtinfn'&&['Object.valueOf','Object.toString','Array.toString'].includes(method[1])){
      const value=ordinaryBuiltin(heap,pending.input,method[1]);
      if(value===null)throw new TypeError(pending.operation+' intrinsic stringification requires its owned data profile');
      const outcome=accept(value);if(outcome)return outcome;continue;
    }
    if(['builtinfn','intrinsic','hostfn'].includes(method[0])||method[0]==='ref'&&heap[method[1]]?.kind==='proxy')
      throw new TypeError(pending.operation+' conversion callable requires its owned invocation profile');
    if(pending.index===-1)return {...fault('Symbol.toPrimitive is not callable'),reads};
    if(pending.index===1)return {...fault('Cannot convert object to primitive value'),reads};
    pending.index=1;pending.method=null;
  }
}
