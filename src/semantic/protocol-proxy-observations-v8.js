// Independent constructor and trap observations. Metadata never performs an
// internal method on a source Proxy. A private handler observer lets native
// Proxy run its actual algorithm, calling selected traps with their original
// handler receiver and native target/key/receiver arguments.
import {parse} from 'acorn';
import {types} from 'node:util';
import {encode,decode} from '../values.js';

export const PROXY_OBSERVATION_PROFILE_V8='ordinary-data-proxy-metadata/1';
const hook='__tracingProtocolProxyConstructor',construct=Reflect.construct,apply=Reflect.apply,own=Object.getOwnPropertyDescriptors;
const reference=value=>value!==null&&['object','function'].includes(typeof value);
const traps=['getPrototypeOf','setPrototypeOf','isExtensible','preventExtensions','getOwnPropertyDescriptor',
  'defineProperty','has','get','set','deleteProperty','ownKeys','apply','construct'];
function allocations(source){const nodes=[];
  function visit(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}
    if(node.type==='NewExpression'&&node.callee.type==='Identifier'&&node.callee.name==='Proxy')nodes.push(node);
    for(const [key,child]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))visit(child);
  }visit(parse(source,{ecmaVersion:'latest',sourceType:'script'}));return nodes;
}
function ownedObservations(bundle,allocations){
  const sites=new Set(allocations.map(node=>node.start+':'+node.end)),siteById=new Map(bundle.sites.map(row=>[row.siteId,row.start+':'+row.end])),
    rows=[],identities=new Map(),state=structuredClone(bundle.initialState),children=new Map();let next=0;
  const fail=message=>{throw new TypeError('Independent owned Proxy observation: '+message);};
  function value(tag){
    if(!Array.isArray(tag))fail('missing observation value');
    if(!['ref','symbol'].includes(tag[0]))return structuredClone(tag);
    const key=JSON.stringify(tag);if(!identities.has(key))identities.set(key,++next);
    return ['identity',tag[0]==='symbol'?'symbol':bundle.finalState.heap[tag[1]]?.kind==='function'?'function':'object',identities.get(key)];
  }
  function seed(tag){if(tag?.[0]!=='ref'||identities.has(JSON.stringify(tag)))return;value(tag);
    const node=state.heap[tag[1]];if(!node||Object.keys(node.accessors??{}).length)fail('input graph is not data-only');
    for(const key of Object.keys(node.properties??{}).sort())seed(node.properties[key].value);
  }
  bundle.entrySpec.arguments.forEach(seed);
  const add=(kind,fields)=>{if(rows.length>=32768)fail('observation bound');rows.push({kind,...fields});};
  for(const event of bundle.events){
    if(event.operation==='proxy.allocate'){
      const site=siteById.get(event.siteId);if(!sites.has(site))fail('unanchored Proxy allocation');
      add('create',{site,object:value(event.result),target:value(event.operands[0]),handler:value(event.operands[1])});
    }
    const frame=state.frames[event.invocationId],instruction=bundle.programs[frame?.codeId]?.instructions[frame?.pc],
      has=event.operation==='primitive.binary'&&instruction?.op==='BINARY'&&instruction.arg==='in',
      deletion=event.operation==='property.delete',
      property=event.operation==='property.read'||event.operation==='property.write',
      base=has?event.operands[1]:event.operands[0],node=base?.[0]==='ref'?state.heap[base[1]]:null;
    if(node?.kind==='proxy'&&(property||has||deletion)){
      const operation=has?'has':deletion?'delete':event.operation==='property.read'?'get':'set',
        trapName=operation==='delete'?'deleteProperty':operation,handler=state.heap[node.handlerId],
        key=(has?event.operands[0]:event.operands[1])?.[0]==='symbol'?(has?event.operands[0]:event.operands[1]):
          ['str',String(decode(has?event.operands[0]:event.operands[1]))],
        method=handler?.properties?.[trapName]?.value??['undefined'];
      const parent=event.stateChanges.find(change=>change.table==='frames'&&change.id===event.invocationId)?.after,
        pending=parent?.pendingProperty;
      if(!['undefined','null'].includes(method[0]))add('select',{operation,object:value(base),key:value(key),method:value(method)});
      if(pending?.proxy){
        const child=event.stateChanges.find(change=>change.table==='frames'&&change.id===pending.waitingFrameId)?.after;
        if(!child||method[0]!=='ref')fail('missing selected trap frame');
        const args=[['ref',node.targetId],key,...(operation==='set'?[event.operands[2]]:[]),
            ...(['get','set'].includes(operation)?[base]:[])],fn=state.heap[method[1]],
          environment=event.stateChanges.find(change=>change.table==='envs'&&change.id===child.envId)?.after;
        if(fn?.kind!=='function'||child.codeId!==fn.codeId||environment?.parent!==fn.closureEnvId)
          fail('selected trap source function or closure differs');
        const receiver=fn.arrow?(fn.lexicalThisFrameId?state.frames[fn.lexicalThisFrameId]?.thisValue:fn.lexicalThis):['ref',node.handlerId];
        if(JSON.stringify(child.thisValue)!==JSON.stringify(receiver))fail('trap effective receiver differs');
        if(!bundle.programs[fn.codeId].params.every((name,index)=>environment.bindings[name]?.initialized&&
          JSON.stringify(environment.bindings[name].token?.value)===JSON.stringify(args[index]??['undefined'])))
          fail('trap parameter values differ from native call arguments');
        add('call',{operation,object:value(base),method:value(method),receiver:value(['ref',node.handlerId]),arguments:args.map(value)});
        children.set(child.id,{operation,object:base,method});
      }else if(!['undefined','null'].includes(method[0]))fail('selected trap has no invocation');
    }
    for(const change of event.stateChanges)if(change.table==='frames'&&children.has(change.id)&&
      !['completed','thrown'].includes(change.before?.status)&&['completed','thrown'].includes(change.after?.status)){
      const entry=children.get(change.id),completion=change.after.completion;
      if(!['return','throw'].includes(completion?.type)||!completion.value?.value)fail('missing trap completion');
      add(completion.type,{operation:entry.operation,object:value(entry.object),method:value(entry.method),value:value(completion.value.value)});
      children.delete(change.id);
    }
    for(const change of event.stateChanges)if(state[change.table]){
      if(change.after===null)delete state[change.table][change.id];else if(change.after!==undefined)state[change.table][change.id]=change.after;
    }
  }
  if(children.size)fail('unfinished trap observations');return rows;
}
export function createProxyObservationAdapterV8({source,side='native',bundle=null,initialValues=[]}={}){
  const original=allocations(source);if(!original.length)return null;
  const registered=new WeakMap(),rows=[],identities=new Map(),failures=[],ordinaryPrototypes=new Set([Object.prototype]);
  let nativeProxy=null,next=0,invoke=call=>apply(call.callee,call.receiver,call.arguments);
  const fail=message=>{failures.push(message);throw new TypeError('Independent native Proxy observation: '+message);};
  function value(raw){
    if(!reference(raw)&&typeof raw!=='symbol')return encode(raw);
    if(reference(raw)&&types.isProxy(raw)&&!registered.has(raw))fail('unregistered guest Proxy');
    if(!identities.has(raw))identities.set(raw,++next);return ['identity',typeof raw,identities.get(raw)];
  }
  function seed(raw){if(!reference(raw)||identities.has(raw))return;value(raw);
    const descriptors=own(raw);for(const key of Object.keys(descriptors).sort()){
      if(!Object.hasOwn(descriptors[key],'value'))fail('input graph is not data-only');seed(descriptors[key].value);}
  }
  initialValues.forEach(seed);
  const add=(kind,fields)=>{if(rows.length>=32768)fail('observation bound');rows.push({kind,...fields});};
  function nativeOrdinary(value,ctx,label,{allowAccessors=false}={}){
    if(value===null||typeof value!=='object'||Array.isArray(value)||types.isProxy(value))ctx.fail(label+' must be an ordinary object');
    const prototype=ctx.intrinsicPrototype(Object.getPrototypeOf(value));
    if(prototype!==null&&prototype!=='Object.prototype')ctx.fail(label+' custom prototype');
    const descriptors=own(value);
    if(!allowAccessors&&Reflect.ownKeys(descriptors).some(key=>!Object.hasOwn(descriptors[key],'value')))ctx.fail(label+' accessor');
    return descriptors;
  }
  function ownedOrdinary(tag,ctx,label,{allowAccessors=false}={}){
    const node=tag?.[0]==='ref'?ctx.state.heap[tag[1]]:null;
    if(node?.kind!=='object'||![undefined,null,'Object.prototype'].includes(node.prototype)||
      !allowAccessors&&Object.keys(node.accessors??{}).length)
      ctx.fail(label+' must be an ordinary data object');return node;
  }
  function nativeHandler(value,ctx){return nativeOrdinary(value,ctx,'Proxy handler');}
  function ownedHandler(value,ctx){return ownedOrdinary(value,ctx,'Proxy handler');}
  return {id:PROXY_OBSERVATION_PROFILE_V8,
    setCallObserver(observer){invoke=observer;},
    ownedAssignmentValue({object,key,state}){
      if(object.kind!=='proxy')return undefined;
      const ctx={state,fail(message){throw new TypeError('Proxy assignment observation: '+message);}},
        target=ownedOrdinary(['ref',object.targetId],ctx,'Proxy target'),handler=ownedHandler(['ref',object.handlerId],ctx);
      if(handler.properties.set&&!['undefined','null'].includes(handler.properties.set.value[0]))ctx.fail('setter trap lacks its completion observer');
      return target.properties?.[key]?.value??['missing-storage'];
    },
    initializeRealm(evaluate){nativeProxy=evaluate('Proxy');ordinaryPrototypes.add(evaluate('Object.prototype'));},
    globals:{[hook]:(site,callee)=>(...args)=>{
      if(callee!==nativeProxy)return construct(callee,args);
      const ctx={fail,intrinsicPrototype:value=>ordinaryPrototypes.has(value)?'Object.prototype':value},target=args[0],handler=args[1];
      nativeOrdinary(target,ctx,'Proxy target');nativeHandler(handler,ctx);
      let result;
      const observedHandler=new Proxy({}, {get(_target,operation){
        const descriptors=nativeHandler(handler,ctx),method=descriptors[operation]?.value;
        nativeOrdinary(target,ctx,'Proxy target',{allowAccessors:['has','deleteProperty'].includes(operation)});
        if(!['get','set','has','deleteProperty'].includes(operation)||method==null||typeof method!=='function')return method;
        const semanticOperation=operation==='deleteProperty'?'delete':operation;
        return (...trapArgs)=>{
          const key=trapArgs[1];add('select',{operation:semanticOperation,object:value(result),key:value(key),method:value(method)});
          if(method==null){
            if(operation==='get')return Reflect.get(target,key,trapArgs[2]);
            if(operation==='set')return Reflect.set(target,key,trapArgs[2],trapArgs[3]);
            if(operation==='has')return Reflect.has(target,key);
            return Reflect.deleteProperty(target,key);
          }
          add('call',{operation:semanticOperation,object:value(result),method:value(method),receiver:value(handler),arguments:trapArgs.map(value)});
          try{const returned=invoke({callee:method,receiver:handler,arguments:trapArgs});
            add('return',{operation:semanticOperation,object:value(result),method:value(method),value:value(returned)});return returned;
          }catch(error){add('throw',{operation:semanticOperation,object:value(result),method:value(method),value:value(error)});throw error;}
        };
      }});
      result=construct(callee,[target,observedHandler,...args.slice(2)]);registered.set(result,{target,handler});
      add('create',{site,object:value(result),target:value(target),handler:value(handler)});return result;
    }},
    instrument(text){
      const nodes=allocations(text);if(nodes.length!==original.length)throw new TypeError('Proxy source constructor inventory changed');
      const edits=nodes.map((node,index)=>({start:node.start,end:node.callee.end,
        text:hook+'('+JSON.stringify(original[index].start+':'+original[index].end)+',Proxy)'})).sort((a,b)=>b.start-a.start);
      for(const edit of edits)text=text.slice(0,edit.start)+edit.text+text.slice(edit.end);return text;
    },
    metadataAdapter:side==='owned'?{ownedNode(value,ctx){
      const node=value[0]==='ref'?ctx.state.heap[value[1]]:null;if(node?.kind!=='proxy')return null;
      const target=['ref',node.targetId],handler=['ref',node.handlerId];ownedOrdinary(target,ctx,'Proxy target',{allowAccessors:true});
      ownedHandler(handler,ctx);
      if(Object.keys(node.properties??{}).length||Object.keys(node.propertyVersions??{}).length||node.shapeVersion!==0)
        ctx.fail('Proxy has invented own state');
      return {...ctx.defaultNode(target),kind:'proxy',annotations:[{name:'proxy-target-handler/1',values:[target,handler],data:{}}]};
    }}:{nativeProxyNode(value,ctx){
      const captured=registered.get(value);if(!captured)return null;
      nativeOrdinary(captured.target,ctx,'Proxy target',{allowAccessors:true});nativeHandler(captured.handler,ctx);
      return {...ctx.defaultNode(captured.target),kind:'proxy',annotations:[{
        name:'proxy-target-handler/1',values:[captured.target,captured.handler],data:{}}]};
    }},
    observations(){if(side==='owned')return ownedObservations(bundle,original);if(failures.length)fail(failures[0]);return rows;}
  };
}
