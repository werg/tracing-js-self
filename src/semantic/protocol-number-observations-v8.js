// Independent observations of native Number's actual ToPrimitive algorithm.
// A private observer proxy forwards data lookups to the original object and
// calls selected methods with that original receiver. Guest identities, private
// brands and mutations remain untouched. No owned evaluator is imported.
import {parse} from 'acorn';
import {types} from 'node:util';
import {encode} from '../values.js';
import {propertyKeyValue,symbolPropertyKey} from '../property-keys.js';

export const NUMBER_OBSERVATION_PROFILE_V8='number-conversion-observations/1';
const hook='__tracingProtocolNumberCallee',apply=Reflect.apply,getOwn=Object.getOwnPropertyDescriptor,getPrototype=Object.getPrototypeOf;
const reference=value=>value!==null&&['object','function'].includes(typeof value);
function numberCalls(source){const calls=[];
  function visit(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}
    if(node.type==='CallExpression'&&!node.optional&&node.callee.type==='Identifier'&&node.callee.name==='Number')calls.push(node);
    for(const [key,child]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))visit(child);
  }visit(parse(source,{ecmaVersion:'latest',sourceType:'script'}));return calls;
}
function ownedObservations(bundle,calls){
  const sites=new Set(calls.map(node=>node.start+':'+node.end)),siteById=new Map(bundle.sites.map(row=>[row.siteId,row.start+':'+row.end]));
  const rows=[],identities=new Map(),state=structuredClone(bundle.initialState),active=new Map(),children=new Map();let next=0;
  const fail=message=>{throw new TypeError('Independent owned Number observation: '+message);};
  function value(tag){
    if(!Array.isArray(tag))fail('missing value');
    if(['builtinfn','intrinsic'].includes(tag[0]))return ['builtin',tag[1]];
    if(!['ref','symbol'].includes(tag[0]))return structuredClone(tag);
    const key=JSON.stringify(tag);if(!identities.has(key))identities.set(key,++next);
    return ['identity',tag[0]==='symbol'?'symbol':bundle.finalState.heap[tag[1]]?.kind==='function'?'function':'object',identities.get(key)];
  }
  function seed(tag){if(tag?.[0]!=='ref'||identities.has(JSON.stringify(tag)))return;value(tag);
    const node=state.heap[tag[1]];if(!node||Object.keys(node.accessors??{}).length)fail('input graph is not data-only');
    for(const key of Object.keys(node.properties??{}).sort())seed(node.properties[key].value);
  }
  bundle.entrySpec.arguments.forEach(seed);
  const add=(site,kind,fields)=>{if(rows.length>=32768)throw new RangeError('Number observation bound');rows.push({site,kind,...fields});};
  function stringTag(input){
    const seen=new Set();let id=input[1];
    while(id){if(seen.has(id))fail('cyclic prototype');seen.add(id);const node=state.heap[id],key=symbolPropertyKey('well-known:toStringTag');
      if(!node)fail('missing prototype');if(Object.hasOwn(node.accessors??{},key))fail('toStringTag accessor');
      if(Object.hasOwn(node.properties??{},key))return node.properties[key].value;
      if(node.prototype===null||node.prototype===undefined||['Object.prototype','Array.prototype','Function.prototype'].includes(node.prototype))break;
      id=node.prototype;
    }
    return ['undefined'];
  }
  for(const event of bundle.events){
    const callee=event.operands[0]?.[0]==='method'?event.operands[0][1]:event.operands[0],site=siteById.get(event.siteId);
    const start=event.operation==='call.enter'&&callee?.[0]==='intrinsic'&&callee[1]==='Number';
    if(start){if(!sites.has(site))fail('indirect Number source call');
      const input=event.operands[1]??['num',0];active.set(event.invocationId,{site,input,owner:event.invocationId});add(site,'begin',{value:value(input)});
    }
    if(start||event.operation==='intrinsic.number.resume'){
      const entry=active.get(event.invocationId);if(!entry)fail('missing Number invocation');
      for(const read of event.readObservations??[]){
        if(read.kind!=='property')fail('non-property conversion read');
        const key=propertyKeyValue(read.key),method=read.value;add(entry.site,'select',{receiver:value(entry.input),key,method:value(method)});
        if(method[0]==='builtinfn'){
          let result;
          if(method[1]==='Object.valueOf')result=entry.input;
          else if(method[1]==='Object.toString'){
            const tag=stringTag(entry.input);result=['str','[object '+(tag[0]==='str'?tag[1]:'Object')+']'];
          }else fail('unsupported native conversion builtin');
          add(entry.site,'builtin',{method:method[1],receiver:value(entry.input),value:value(result)});
        }
      }
      const parent=event.stateChanges.find(change=>change.table==='frames'&&change.id===event.invocationId)?.after,
        pending=parent?.pendingNumberConversion;
      if(pending?.phase==='waiting'){
        const child=event.stateChanges.find(change=>change.table==='frames'&&change.id===pending.waitingFrameId)?.after;
        if(!child)fail('callback frame is absent');
        const args=pending.index===-1?[['str','number']]:[];
        add(entry.site,'call',{method:value(pending.method),receiver:value(entry.input),arguments:args.map(value)});
        children.set(child.id,{...entry,method:pending.method});
      }else{
        if(event.completion?.type==='throw'||event.result?.[0]!=='num')fail('abrupt Number conversion is outside this profile');
        add(entry.site,'finish',{value:value(event.result)});active.delete(event.invocationId);
      }
    }
    const finished=event.stateChanges.filter(change=>change.table==='frames'&&children.has(change.id)&&
      !['completed','thrown'].includes(change.before?.status)&&['completed','thrown'].includes(change.after?.status));
    const depth=id=>{let result=0;const seen=new Set();while(id){if(seen.has(id))fail('cyclic callback chain');seen.add(id);
      result++;id=state.frames[id]?.callerFrameId;}return result;};
    finished.sort((a,b)=>depth(b.id)-depth(a.id));
    for(const change of finished){
      const entry=children.get(change.id),kind=change.after.completion?.type,thrown=kind==='throw',result=change.after.completion?.value?.value;
      if(!['return','throw'].includes(kind)||!Array.isArray(result))fail('missing callback completion');
      add(entry.site,kind,{method:value(entry.method),value:value(result)});children.delete(change.id);
      if(thrown){add(entry.site,'abrupt',{value:value(result)});active.delete(entry.owner);}
    }
    for(const change of event.stateChanges)if(state[change.table]){
      if(change.after===null)delete state[change.table][change.id];else if(change.after!==undefined)state[change.table][change.id]=change.after;
    }
  }
  if(active.size||children.size)fail('unfinished conversion observations');return rows;
}
export function createNumberObservationAdapterV8({source,side='native',bundle=null,initialValues=[]}={}){
  const calls=numberCalls(source);if(!calls.length)return null;
  if(side==='owned')return {id:NUMBER_OBSERVATION_PROFILE_V8,observations:()=>ownedObservations(bundle,calls)};
  const rows=[],identities=new Map(),builtins=new Map(),failures=[];let next=0,nativeNumber=null;
  let invoke=call=>apply(call.callee,call.receiver,call.arguments);
  const fail=message=>{failures.push(message);throw new TypeError('Independent native Number observation: '+message);};
  function value(raw){
    if(builtins.has(raw))return ['builtin',builtins.get(raw)];
    if(!reference(raw)&&typeof raw!=='symbol')return encode(raw);
    if(reference(raw)&&types.isProxy(raw))fail('guest Proxy is outside the conversion profile');
    if(!identities.has(raw))identities.set(raw,++next);
    return ['identity',typeof raw,identities.get(raw)];
  }
  function seed(raw){if(!reference(raw)||identities.has(raw))return;value(raw);
    const descriptors=Object.getOwnPropertyDescriptors(raw);
    for(const key of Object.keys(descriptors).sort()){
      if(!Object.hasOwn(descriptors[key],'value'))fail('input graph is not data-only');seed(descriptors[key].value);
    }
  }
  initialValues.forEach(seed);
  const add=(site,kind,fields)=>{if(rows.length>=32768)fail('observation bound');rows.push({site,kind,...fields});};
  function lookup(object,key){
    const seen=new Set();let node=object;
    while(node!==null){if(types.isProxy(node)||seen.has(node))fail('exotic or cyclic conversion prototype');seen.add(node);
      const descriptor=getOwn(node,key);if(descriptor){if(!Object.hasOwn(descriptor,'value'))fail('conversion accessor needs its own observer');return descriptor.value;}
      node=getPrototype(node);
    }
    return undefined;
  }
  return {id:NUMBER_OBSERVATION_PROFILE_V8,
    setCallObserver(observer){invoke=observer;},
    globals:{[hook]:(site,callee)=>(...args)=>invoke({callee,receiver:undefined,arguments:args,site})},
    initializeRealm(evaluate){
      const intrinsics=evaluate('({Number, valueOf:Object.prototype.valueOf, toString:Object.prototype.toString})');
      nativeNumber=intrinsics.Number;builtins.set(intrinsics.valueOf,'Object.valueOf');builtins.set(intrinsics.toString,'Object.toString');
      builtins.set(Object.prototype.valueOf,'Object.valueOf');builtins.set(Object.prototype.toString,'Object.toString');
    },
    instrument(text){
      const current=numberCalls(text);if(current.length!==calls.length)fail('source Number call inventory changed');
      const edits=current.map((node,index)=>({start:node.callee.start,end:node.callee.end,
        text:hook+'('+JSON.stringify(calls[index].start+':'+calls[index].end)+',Number)'})).sort((a,b)=>b.start-a.start);
      for(const edit of edits)text=text.slice(0,edit.start)+edit.text+text.slice(edit.end);return text;
    },
    observeCall(call,nextCall){
      if(call.callee!==nativeNumber)return nextCall();
      const site=call.site;if(typeof site!=='string')fail('unanchored Number source call');
      const input=call.arguments.length?call.arguments[0]:0;add(site,'begin',{value:value(input)});
      let result;
      try{
      if(!reference(input))result=nextCall();
      else{
        if(types.isProxy(input))fail('guest Proxy is outside the conversion profile');
        // This empty target avoids changing invariants of frozen source data.
        // The observer proxy is never stored in or returned to guest code.
        const observed=new Proxy({}, {get(_target,key){
          if(key!==Symbol.toPrimitive&&key!=='valueOf'&&key!=='toString')fail('unexpected conversion lookup');
          const method=lookup(input,key),encoded=key===Symbol.toPrimitive?['symbol','well-known:toPrimitive']:['str',key];
          add(site,'select',{receiver:value(input),key:encoded,method:value(method)});
          if(typeof method!=='function')return method;
          return (...args)=>{
            const builtin=builtins.get(method);
            if(builtin){
              // Object.toString can read a live tag. Inspect its descriptor
              // without invoking a getter before calling the actual intrinsic.
              if(builtin==='Object.toString')lookup(input,Symbol.toStringTag);
              const returned=apply(method,input,args);add(site,'builtin',{method:builtin,receiver:value(input),value:value(returned)});return returned;
            }
            add(site,'call',{method:value(method),receiver:value(input),arguments:args.map(value)});
            try{const returned=apply(method,input,args);add(site,'return',{method:value(method),value:value(returned)});return returned;}
            catch(error){add(site,'throw',{method:value(method),value:value(error)});throw error;}
          };
        }});
        result=apply(call.callee,call.receiver,[observed,...call.arguments.slice(1)]);
      }
      }catch(error){add(site,'abrupt',{value:value(error)});throw error;}
      add(site,'finish',{value:value(result)});return result;
    },
    observations(){if(failures.length)fail(failures[0]);return rows;}
  };
}
