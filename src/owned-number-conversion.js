// Number(object) retains only JSON data. Property lookup and callback execution
// operate on owned identities; the host Number leaf receives primitives only.
import {encode,decode} from './values.js';
import {symbolPropertyKey} from './property-keys.js';
import {ordinaryGet,ordinaryBuiltin} from './spec-operations.js';

const primitive=value=>['undefined','null','bool','str','num','bigint','symbol'].includes(value?.[0]);
const fault=message=>({fault:{name:'TypeError',message}});
export function createNumberConversion(input,siteId){return {operation:'Number',input:structuredClone(input),siteId,
  index:-1,method:null,phase:'select',waitingFrameId:null,result:null};}
export function advanceNumberConversion(pending,{heap,invoke}){
  const reads=[];
  const finish=value=>{
    if(value[0]==='symbol')return {...fault('Cannot convert a Symbol value to a number'),reads};
    if(['str','bigint'].includes(value[0])&&value[1].length>10000)throw new RangeError('Number conversion scalar budget exceeded');
    return {done:true,value:encode(Number(decode(value))),reads};
  };
  const accept=value=>{
    if(primitive(value))return finish(value);
    if(pending.index===-1)return {...fault('Symbol.toPrimitive must return a primitive'),reads};
    if(pending.index===1)return {...fault('Cannot convert object to primitive value'),reads};
    pending.index=1;pending.method=null;pending.waitingFrameId=null;pending.result=null;pending.phase='select';return null;
  };
  if(pending.phase==='returned'){
    const outcome=accept(pending.result);if(outcome)return outcome;
  }else if(pending.phase!=='select')throw new Error('Number conversion is still waiting for its callback');
  for(;;){
    const key=pending.index===-1?symbolPropertyKey('well-known:toPrimitive'):pending.index===0?'valueOf':'toString',
      found=ordinaryGet(heap,pending.input,key);
    if(!found)throw new TypeError('Number conversion accessor or exotic property requires its owned protocol');
    reads.push(found.observation);const method=found.method.value;pending.method=structuredClone(method);
    if(pending.index===-1&&['undefined','null'].includes(method[0])){pending.index=0;pending.method=null;continue;}
    if(method[0]==='ref'&&heap[method[1]]?.kind==='function'){
      const child=invoke(method,pending.input,pending.index===-1?[['str','number']]:[]);
      pending.waitingFrameId=child;pending.result=null;pending.phase='waiting';return {child,reads};
    }
    if(method[0]==='builtinfn'&&['Object.valueOf','Object.toString','Array.toString'].includes(method[1])){
      const value=ordinaryBuiltin(heap,pending.input,method[1]);
      if(value===null)throw new TypeError('Number intrinsic stringification requires its owned data profile');
      const outcome=accept(value);if(outcome)return outcome;continue;
    }
    if(['builtinfn','intrinsic','hostfn'].includes(method[0])||method[0]==='ref'&&heap[method[1]]?.kind==='proxy')
      throw new TypeError('Number conversion callable requires its owned invocation profile');
    if(pending.index===-1)return {...fault('Symbol.toPrimitive is not callable'),reads};
    if(pending.index===1)return {...fault('Cannot convert object to primitive value'),reads};
    pending.index=1;pending.method=null;
  }
}
