// Shared Symbol ownership for effectful source composition. Public execution
// reuses the existing Symbol protocol; this component only proves source origin.
import {isDeepStrictEqual as eq} from 'node:util';
import {decode} from '../values.js';
import {guardHeap} from './protocol-source-shapes-v8.js';

export const SYMBOL_COMPOSITION_SOURCE_V8='symbol-composition-source/1';
const copy=structuredClone,methods=new Set(['Symbol','Symbol.for','Symbol.keyFor',
  'Symbol.prototype.toString','Symbol.prototype.valueOf']);
const selected=value=>value?.[0]==='method'?value[1]:value;
const method=event=>{const value=selected(event.operands?.[0]);return value?.[0]==='builtinfn'||value?.[0]==='intrinsic'?value[1]:null;};
export const symbolCompositionEventV8=(view,{event})=>Boolean(view.components[SYMBOL_COMPOSITION_SOURCE_V8]&&
  event.operation==='call.enter'&&methods.has(method(event)));
function checkSymbol(ctx,node,owner){
  guardHeap(node);
  const row=ctx.controller(owner).protocol.symbols.find(row=>row.id===node.id);
  if(node.kind!=='symbol'||Object.keys(node.properties??{}).length||Object.keys(node.propertyVersions??{}).length||
    !row||!eq(row.description,node.description)||
    (node.registeredKey===undefined?row.kind!=='unique':row.kind!=='registry'||row.key!==node.registeredKey))
    ctx.refuse('Symbol composition declaration differs from its owned identity');
}
export function createSymbolCompositionSourceV8(){return {
  id:SYMBOL_COMPOSITION_SOURCE_V8,
  claims:{
    value:(_view,value)=>Array.isArray(value)&&value[0]==='symbol',
    allocation:(_view,input)=>input.kind==='symbol',
    event:symbolCompositionEventV8
  },
  prepare:{value:(_view,value)=>({kind:'symbol-value',value}),
    allocation:(_view,input)=>({kind:'symbol-allocation',identity:input.identity}),
    event:(_view,{event})=>({kind:'symbol-operation',event:event.eventId})},
  tag(ctx,value){
    const owner=ctx.rootInvocation;
    if(!ctx.controller(owner).protocol.symbols.some(row=>row.id===value[1]))
      ctx.refuse('Symbol composition value has no prior public declaration');
    return copy(value);
  },
  allocation(ctx){ctx.refuse('Symbol composition allocation must be performed by its originating call');},
  event(ctx,event,row){
    const name=method(event),owner=ctx.rootFor(event.invocationId),raw=event.operands[0],args=event.operands.slice(1);
    if(row?.child||!methods.has(name))ctx.refuse('Symbol composition requires an intrinsic synchronous call');
    if(name==='Symbol'||name==='Symbol.for'){
      const argument=args[0]??['undefined'];
      if(!['undefined','null','str','num','bool','bigint'].includes(argument[0]))
        ctx.refuse('Symbol description or registry key requires an explicit conversion');
      if(row.result?.[0]!=='symbol')ctx.refuse('Symbol composition call lacks its result identity');
      const record=name==='Symbol'?{kind:'symbol.create',id:row.result[1],
        description:argument[0]==='undefined'?['undefined']:['str',String(decode(argument))]}:
        {kind:'symbol.for',id:row.result[1],key:String(decode(argument))};
      ctx.emitProtocol(owner,record,event,'source-symbol-composition/1');
    }else{
      const symbol=name==='Symbol.keyFor'?args[0]:raw?.[0]==='method'?raw[2]:null;
      if(symbol?.[0]!=='symbol')ctx.refuse('Symbol composition read requires its original symbol receiver');
      ctx.tag(symbol);
      if(name==='Symbol.prototype.valueOf'){
        if(!eq(symbol,row.result))ctx.refuse('Symbol valueOf changed identity');
      }else ctx.emitProtocol(owner,{kind:'symbol.read',symbol:copy(symbol),
        operation:name==='Symbol.keyFor'?'keyFor':'toString',result:ctx.tag(row.result),bind:null},event,'source-symbol-composition/1');
    }
    for(const change of event.stateChanges)if(change.table==='heap'){
      if(change.before!==null||change.after?.kind!=='symbol')ctx.refuse('Symbol call changed unrelated heap storage');
      checkSymbol(ctx,change.after,owner);
    }
    return true;
  },
  checkEvent(ctx,event){
    const owner=ctx.rootFor(event.invocationId);
    for(const change of event.stateChanges)if(change.table==='heap'&&change.after?.kind==='symbol')checkSymbol(ctx,change.after,owner);
    return true;
  }
};}
