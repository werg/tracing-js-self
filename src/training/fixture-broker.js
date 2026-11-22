// Deterministic external environment shared by teacher and independent native
// reference fixtures. It checks evaluated requests; it never computes guest
// answers or repairs a mismatched request with a different request's result.
import {isDeepStrictEqual} from 'node:util';
import {hostOperation} from '../host/operations.js';
import {encodeNativeGraph,decodeOwnedGraph,ownedCallbackId} from '../host/graph-codec.js';
import {inspectDataObject} from './data-graph-contract.js';

const copy=value=>structuredClone(value);
export function canonicalFixturePlan({calls=[],settlementOrder=null}={}){
  if(!Array.isArray(calls))throw new TypeError('Fixture calls must be an array');
  return {calls:calls.map(call=>({operation:call.operation,status:call.status??'fulfilled',
    argumentGraph:call.argumentGraph??encodeNativeGraph(call.arguments??[]),
    ...(call.resultFromCallback!==undefined?{resultFromCallback:call.resultFromCallback}:
      {resultGraph:call.resultGraph??encodeNativeGraph([call.result])}),
    ...(call.callbacks?{callbacks:call.callbacks.map(item=>({
      ...(item.path!==undefined?{path:copy(item.path),
        inputGraph:item.inputGraph??encodeNativeGraph([item.receiver,...(item.arguments??[])])}:
        {slot:item.slot,argumentGraph:item.argumentGraph??encodeNativeGraph(item.arguments??[])}),
      ...(item.call!==undefined?{call:item.call}:{})}))}:{})})),settlementOrder};
}
export function normalizeFixtureArguments(operation,args){
  const spec=hostOperation(operation);
  if(spec.callbackGraph){
    const seen=new WeakMap(),callbacks=new Map();
    function visit(value){
      const callback=ownedCallbackId(value);
      if(typeof value==='function'||callback){
        const key=callback??value;
        if(!callbacks.has(key))callbacks.set(key,{callback:true});
        return callbacks.get(key);
      }
      if(value===null||typeof value!=='object')return value;
      if(seen.has(value))return seen.get(value);
      const {kind,prototype,descriptors}=inspectDataObject(value);
      const result=kind==='array'?[]:prototype===null?Object.create(null):{};seen.set(value,result);
      for(const [key,descriptor] of descriptors){
        if(key==='length'&&kind==='array'){result.length=descriptor.value;continue;}
        Object.defineProperty(result,key,{value:visit(descriptor.value),writable:true,enumerable:true,configurable:true});
      }
      return result;
    }
    return encodeNativeGraph(args.map(visit));
  }
  return encodeNativeGraph(args.map((value,index)=>spec.callbackIndices.includes(index)?
    {callback:typeof value==='function'}:value));
}
export function createFixtureBroker({calls=[],settlementOrder=null}={}){
  if(!Array.isArray(calls)||calls.length>1024)throw new TypeError('Invalid bounded effect fixture');
  const expected=copy(calls),receipts=[],pending=new Map(),issued=new Map(),subscriptions=new Map(),active=new Set();
  const asyncIndices=expected.flatMap((call,index)=>hostOperation(call.operation).kind==='promise'?[index]:[]);
  const order=settlementOrder??asyncIndices;
  if(!Array.isArray(order)||new Set(order).size!==asyncIndices.length||
    order.length!==asyncIndices.length||order.some(index=>!asyncIndices.includes(index)))
    throw new TypeError('Settlement order must identify every asynchronous fixture call once');
  let called=0,settled=0,scheduled=false,aborted=null;
  function callbackTarget(index,callback){
    const target=callback.call??index,registration=issued.get(target),registeredCall=expected[target];
    if(!Number.isSafeInteger(target)||target<0||target>index||!registration||registration.closed||
      target!==index&&hostOperation(registeredCall.operation).callbackLifetime!=='subscription')
      throw new TypeError('Fixture callback lacks a live declared owned bridge');
    return {target,registration,spec:hostOperation(registeredCall.operation)};
  }
  function notification(index,callback){
    const {target,registration,spec}=callbackTarget(index,callback);
    if(!spec.callbackIndices.includes(callback.slot)||typeof registration.args[callback.slot]!=='function')
      throw new TypeError('Fixture callback slot lacks a live declared owned bridge');
    const graph=callback.argumentGraph??encodeNativeGraph(callback.arguments??[]);
    receipts.push({kind:'callback',call:target,slot:callback.slot,args:copy(graph)});
    registration.args[callback.slot](...decodeOwnedGraph(JSON.stringify(graph)));
  }
  async function callbackReturn(index,callback,ordinal){
    const {target,registration,spec}=callbackTarget(index,callback),path=callback.path;
    if(!spec.callbackGraph||spec.kind!=='promise'||!Array.isArray(path)||!path.length||path.length>64||
      !Number.isSafeInteger(path[0])||path[0]<0||path[0]>=registration.args.length)
      throw new TypeError('Fixture return callback requires a bounded declared argument path');
    let fn=registration.args;
    for(const key of path){
      if(!['string','number'].includes(typeof key)||key==='__proto__')
        throw new TypeError('Invalid fixture callback path');
      const descriptor=fn!=null&&Object.getOwnPropertyDescriptor(fn,key);
      if(!descriptor||!Object.hasOwn(descriptor,'value'))throw new TypeError('Fixture callback path is not own data');
      fn=descriptor.value;
    }
    if(typeof fn!=='function')throw new TypeError('Fixture callback path does not identify a callable bridge');
    const graph=callback.inputGraph;
    const [receiver,...args]=decodeOwnedGraph(JSON.stringify(graph));
    if(!graph.roots.length||args.length>32)throw new TypeError('Invalid fixture callback input graph');
    receipts.push({kind:'callback-return',call:target,callback:ordinal,path:copy(path),input:copy(graph)});
    let status='fulfilled',value;
    try{value=await Reflect.apply(fn,receiver,args);}catch(error){status='rejected';value=error;}
    receipts.push({kind:'callback-completion',call:target,callback:ordinal,status,result:encodeNativeGraph([value])});
    return {status,value};
  }
  function finishCall(index,entry,callbackResults=[]){
    const call=expected[index];
    try{
      const selected=call.resultFromCallback;
      if(selected!==undefined&&(!Number.isSafeInteger(selected)||selected<0||!callbackResults[selected]))
        throw new TypeError('Fixture result must name an actual return callback completion');
      const status=selected!==undefined?callbackResults[selected].status:call.status??'fulfilled';
      if(!['fulfilled','rejected'].includes(status))throw new TypeError('Invalid fixture outcome');
      const value=selected!==undefined?callbackResults[selected].value:
        call.resultGraph?decodeOwnedGraph(JSON.stringify(call.resultGraph))[0]:copy(call.result);
      receipts.push({kind:'settlement',call:index,status,result:encodeNativeGraph([value])});
      if(status==='fulfilled'&&hostOperation(call.operation).callbackLifetime==='subscription'){
        if(typeof value!=='string'||subscriptions.has(value))throw new TypeError('Fixture subscription needs unique string identity');
        subscriptions.set(value,index);
      }
      if(status==='fulfilled'&&['demo.unlisten','dom.off','dom.stopTimer'].includes(call.operation)){
        const token=entry.args[0],owner=subscriptions.get(token);
        if(owner===undefined)throw new TypeError('Fixture unsubscribe has no live registration');
        issued.get(owner).closed=true;subscriptions.delete(token);
        receipts.push({kind:'subscription-close',call:index,subscriptionCall:owner});
      }
      if(status==='rejected')entry.reject(value);else entry.resolve(value);
    }catch(error){entry.reject(error);}
  }
  function settle(index,entry){
    const callbacks=expected[index].callbacks??[];
    if(callbacks.some(callback=>callback.path!==undefined)){
      if(hostOperation(expected[index].operation).kind!=='promise'){
        entry.reject(new TypeError('Synchronous fixture cannot wait for return callbacks'));return;
      }
      active.add(index);
      void (async()=>{
        try{
          const results=[];
          for(const [ordinal,callback] of callbacks.entries()){
            if(callback.path!==undefined)results[ordinal]=await callbackReturn(index,callback,ordinal);
            else notification(index,callback);
          }
          finishCall(index,entry,results);
        }catch(error){entry.reject(error);}
        finally{active.delete(index);}
      })();
    }else{
      try{for(const callback of callbacks)notification(index,callback);finishCall(index,entry);}
      catch(error){entry.reject(error);}
    }
  }
  function flush(){
    if(scheduled||aborted)return;scheduled=true;
    queueMicrotask(()=>{
      scheduled=false;
      while(settled<order.length&&pending.has(order[settled])){
        const index=order[settled++],entry=pending.get(index);pending.delete(index);settle(index,entry);
      }
    });
  }
  const invoke=(operation,args)=>{
    if(aborted)throw aborted;
    const index=called++,call=expected[index],spec=hostOperation(operation);
    const observed=normalizeFixtureArguments(operation,args);
    if(!call||call.operation!==operation||!isDeepStrictEqual(observed,
      call.argumentGraph??encodeNativeGraph(call.arguments??[])))
      throw new Error('Fixture request mismatch at '+index+': '+operation);
    receipts.push({kind:'dispatch',call:index,operation,arguments:observed});
    issued.set(index,{args,closed:false});
    if(spec.kind==='synchronous'){
      let result,error,thrown=false;
      settle(index,{args,resolve:value=>{result=value;},reject:value=>{error=value;thrown=true;}});
      if(thrown)throw error;return result;
    }
    const completion=new Promise((resolve,reject)=>pending.set(index,{args,resolve,reject}));
    void completion.catch(()=>{});flush();return completion;
  };
  const services=Object.fromEntries([...new Set(expected.map(call=>call.operation))]
    .map(operation=>[operation,({args})=>invoke(operation,args)]));
  return {services,invoke,receipts,
    finish(){
      if(called!==expected.length||pending.size||active.size||settled!==order.length||subscriptions.size)
        throw new Error('Fixture has missing calls or unresolved outcomes');
      return copy(receipts);
    },
    abort(error=new Error('Fixture cancelled')){
      aborted=error;for(const entry of pending.values())entry.reject(error);pending.clear();
      for(const registration of issued.values())registration.closed=true;subscriptions.clear();
    }};
}
