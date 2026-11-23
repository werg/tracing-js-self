// Independent native observation only. V8's inspector exposes actual Promise
// internal slots without invoking guest `then`, `constructor` or @@species.
// Runtime.awaitPromise is deliberately not used: it performs a constructor
// lookup on the inspected Promise in Node/V8. A caller first drains jobs under
// its existing deadline, then reads the resulting state through this session.
// https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-getProperties
import {Session} from 'node:inspector';
import {types} from 'node:util';

let sequence=0;
export async function inspectNativePromiseSettlementV8(promise){
  if(!types.isPromise(promise))throw new TypeError('Native settlement inspection requires a branded Promise');
  const key='__tracingProtocolPromiseSettlement'+(++sequence),box={promise},session=new Session();
  Object.defineProperty(globalThis,key,{value:box,configurable:true});
  const post=(method,params)=>new Promise((resolve,reject)=>session.post(method,params,
    (error,result)=>error?reject(error):resolve(result)));
  session.connect();
  try{
    const options={objectGroup:key,returnByValue:false,generatePreview:false},
      holder=await post('Runtime.evaluate',{...options,expression:'globalThis.'+key}),
      value=await post('Runtime.evaluate',{...options,expression:'globalThis.'+key+'.promise'});
    if(holder.exceptionDetails||value.exceptionDetails||!holder.result?.objectId||
      value.result?.subtype!=='promise'||!value.result.objectId)
      throw new TypeError('Native Promise inspector did not preserve its target identity');
    const properties=await post('Runtime.getProperties',{objectId:value.result.objectId,
      ownProperties:true,generatePreview:false});
    if(properties.exceptionDetails)throw new TypeError('Native Promise slot inspection failed');
    const internal=properties.internalProperties??[],state=internal.find(row=>row.name==='[[PromiseState]]')?.value,
      result=internal.find(row=>row.name==='[[PromiseResult]]')?.value;
    if(state?.type!=='string'||!['pending','fulfilled','rejected'].includes(state.value)||!result)
      throw new TypeError('Native Promise inspector did not expose its settlement slots');
    if(state.value==='pending')return {status:'pending'};
    const argument=result.objectId?{objectId:result.objectId}:
      Object.hasOwn(result,'unserializableValue')?{unserializableValue:result.unserializableValue}:
      Object.hasOwn(result,'value')?{value:result.value}:result.type==='undefined'?{}:null;
    if(argument===null)throw new TypeError('Native Promise inspector cannot preserve its result');
    // Transfer the real reference to a private host-owned data property. Do not
    // serialize/rebuild guest objects, call them, or put a hook in their realm.
    const captured=await post('Runtime.callFunctionOn',{objectId:holder.result.objectId,
      functionDeclaration:'function(value){this.result=value;}',arguments:[argument],
      returnByValue:true,generatePreview:false});
    if(captured.exceptionDetails||!Object.hasOwn(box,'result'))
      throw new TypeError('Native Promise inspector could not retain its result identity');
    return {status:state.value,kind:state.value==='fulfilled'?'return':'throw',value:box.result};
  }finally{
    session.disconnect();delete globalThis[key];
  }
}
