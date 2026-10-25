// Deterministic external environment shared by teacher and independent native
// reference fixtures. It checks evaluated requests; it never computes guest
// answers or repairs a mismatched request with a different request's result.
import {isDeepStrictEqual} from 'node:util';
import {hostOperation} from '../host/operations.js';
import {encodeNativeGraph,decodeOwnedGraph} from '../host/graph-codec.js';

const copy=value=>structuredClone(value);
export function canonicalFixturePlan({calls=[],settlementOrder=null}={}){
  if(!Array.isArray(calls))throw new TypeError('Fixture calls must be an array');
  return {calls:calls.map(call=>({operation:call.operation,status:call.status??'fulfilled',
    argumentGraph:call.argumentGraph??encodeNativeGraph(call.arguments??[]),
    resultGraph:call.resultGraph??encodeNativeGraph([call.result]),
    ...(call.callbacks?{callbacks:call.callbacks.map(item=>({slot:item.slot,...(item.call!==undefined?{call:item.call}:{}),
      argumentGraph:item.argumentGraph??encodeNativeGraph(item.arguments??[])}))}:{})})),settlementOrder};
}
function normalizeArguments(operation,args){
  const spec=hostOperation(operation);
  return encodeNativeGraph(args.map((value,index)=>spec.callbackIndices.includes(index)?
    {callback:typeof value==='function'}:value));
}
export function createFixtureBroker({calls=[],settlementOrder=null}={}){
  if(!Array.isArray(calls)||calls.length>1024)throw new TypeError('Invalid bounded effect fixture');
  const expected=copy(calls),receipts=[],pending=new Map(),issued=new Map(),subscriptions=new Map();
  const asyncIndices=expected.flatMap((call,index)=>hostOperation(call.operation).kind==='promise'?[index]:[]);
  const order=settlementOrder??asyncIndices;
  if(!Array.isArray(order)||new Set(order).size!==asyncIndices.length||
    order.length!==asyncIndices.length||order.some(index=>!asyncIndices.includes(index)))
    throw new TypeError('Settlement order must identify every asynchronous fixture call once');
  let called=0,settled=0,scheduled=false,aborted=null;
  function settle(index,entry){
    const call=expected[index];
    try{
      for(const callback of call.callbacks??[]){
        const target=callback.call??index,registration=issued.get(target),registeredCall=expected[target];
        if(!Number.isSafeInteger(target)||target<0||target>index||!registration||registration.closed||
          !hostOperation(registeredCall.operation).callbackIndices.includes(callback.slot)||
          target!==index&&hostOperation(registeredCall.operation).callbackLifetime!=='subscription'||
          typeof registration.args[callback.slot]!=='function')
          throw new TypeError('Fixture callback slot lacks a live declared owned bridge');
        const graph=callback.argumentGraph??encodeNativeGraph(callback.arguments??[]);
        receipts.push({kind:'callback',call:target,slot:callback.slot,args:copy(graph)});
        registration.args[callback.slot](...decodeOwnedGraph(JSON.stringify(graph)));
      }
      const status=call.status??'fulfilled';
      if(!['fulfilled','rejected'].includes(status))throw new TypeError('Invalid fixture outcome');
      const value=call.resultGraph?decodeOwnedGraph(JSON.stringify(call.resultGraph))[0]:copy(call.result);
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
    const observed=normalizeArguments(operation,args);
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
      if(called!==expected.length||pending.size||settled!==order.length||subscriptions.size)
        throw new Error('Fixture has missing calls or unresolved outcomes');
      return copy(receipts);
    },
    abort(error=new Error('Fixture cancelled')){
      aborted=error;for(const entry of pending.values())entry.reject(error);pending.clear();
      for(const registration of issued.values())registration.closed=true;subscriptions.clear();
    }};
}
