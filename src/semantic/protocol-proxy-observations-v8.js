// Independent constructor and trap observations. Metadata never performs an
// internal method on a source Proxy. A private handler observer lets native
// Proxy run its actual algorithm, calling selected traps with their original
// handler receiver and native target/key/receiver arguments.
import {parse} from 'acorn';
import {types} from 'node:util';
import {encode,decode} from '../values.js';
import {ordinaryGet} from '../spec-operations.js';

export const PROXY_OBSERVATION_PROFILE_V8='ordinary-data-proxy-metadata/1';
const hook='__tracingProtocolProxyConstructor',construct=Reflect.construct,apply=Reflect.apply,own=Object.getOwnPropertyDescriptors;
const reference=value=>value!==null&&['object','function'].includes(typeof value);
const traps=['getPrototypeOf','setPrototypeOf','isExtensible','preventExtensions','getOwnPropertyDescriptor',
  'defineProperty','has','get','set','deleteProperty','ownKeys','apply','construct'];
function allocations(source){const nodes=[];
  function visit(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}
    if(node.type==='NewExpression'&&node.callee.type==='Identifier'&&node.callee.name==='Proxy'||
      node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&!node.callee.computed&&
      node.callee.object.type==='Identifier'&&node.callee.object.name==='Proxy'&&node.callee.property.name==='revocable')nodes.push(node);
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
    if(['proxy.allocate','proxy.revocable.allocate'].includes(event.operation)){
      const site=siteById.get(event.siteId);if(!sites.has(site))fail('unanchored Proxy allocation');
      const proxyId=event.operation==='proxy.allocate'?event.result?.[1]:
        event.stateChanges.find(change=>change.table==='heap'&&change.after?.kind==='proxy')?.id,
        object=event.operation==='proxy.allocate'?event.result:['ref',proxyId];
      add('create',{site,object:value(object),target:value(event.operands[0]),handler:value(event.operands[1])});
    }
    if(event.operation==='call.enter'){
      const raw=event.operands?.[0],callee=raw?.[0]==='method'?raw[1]:raw;
      if(callee?.[0]==='builtinfn'&&callee[1].startsWith('Proxy.revoke:'))
        add('revoke',{object:value(['ref',callee[1].slice('Proxy.revoke:'.length)])});
    }
    const frame=state.frames[event.invocationId],instruction=bundle.programs[frame?.codeId]?.instructions[frame?.pc],
      has=event.operation==='primitive.binary'&&instruction?.op==='BINARY'&&instruction.arg==='in',
      deletion=event.operation==='property.delete',
      property=event.operation==='property.read'||event.operation==='property.write',
      raw=event.operands[0]?.[0]==='method'?event.operands[0][1]:event.operands[0],
      reflection=event.operation==='call.enter'&&raw?.[0]==='builtinfn'&&
        ['getPrototypeOf','setPrototypeOf','isExtensible','preventExtensions','getOwnPropertyDescriptor','ownKeys','defineProperty'].includes(raw[1].split('.')[1]),
      base=has||reflection?event.operands[1]:event.operands[0],node=base?.[0]==='ref'?state.heap[base[1]]:null;
    if(node?.kind==='proxy'&&(property||has||deletion||reflection)&&node.targetId!==null&&node.handlerId!==null){
      const operation=reflection?raw[1].split('.')[1]:has?'has':deletion?'delete':event.operation==='property.read'?'get':'set',
        trapName=operation==='delete'?'deleteProperty':operation,
        key=reflection?(['getOwnPropertyDescriptor','defineProperty'].includes(operation)?event.operands[2]:['undefined']):(has?event.operands[0]:event.operands[1])?.[0]==='symbol'?(has?event.operands[0]:event.operands[1]):
          ['str',String(decode(has?event.operands[0]:event.operands[1]))],
        route=[],visited=new Set();let ownerId=base[1],owner=state.heap[ownerId],selected=['undefined'];
      while(owner?.kind==='proxy'){
        if(visited.has(ownerId)||route.length>=64)fail('cyclic or excessive proxy route');
        visited.add(ownerId);
        const handler=state.heap[owner.handlerId],found=ordinaryGet(state.heap,['ref',owner.handlerId],trapName);
        if(!handler||!found)fail('handler accessor lookup requires its call boundary');
        selected=found.method.value;
        route.push({object:ownerId,target:['ref',owner.targetId],handler:['ref',owner.handlerId],method:selected});
        if(!['undefined','null'].includes(selected[0]))break;
        ownerId=owner.targetId;owner=state.heap[ownerId];
      }
      if(!owner||!['object','array','proxy'].includes(owner.kind))fail('unmodeled nested target internal method');
      const trapOwner=route.at(-1)?.object;
      if(!trapOwner)fail('proxy route lacks an owner');
      const ownerNode=state.heap[trapOwner],handler=state.heap[ownerNode.handlerId],
        parent=event.stateChanges.find(change=>change.table==='frames'&&change.id===event.invocationId)?.after,
        pending=reflection?parent?.pendingProxyReflection:parent?.pendingProperty;
      if(!['undefined','null'].includes(selected[0]))
        add('select',{operation,object:value(['ref',trapOwner]),key:value(key),method:value(selected)});
      if(pending&&(reflection||pending.proxy)){
        const child=event.stateChanges.find(change=>change.table==='frames'&&change.id===pending.waitingFrameId)?.after;
        if(!child||selected[0]!=='ref'||JSON.stringify((reflection?pending:pending.proxy).route)!==JSON.stringify(route))
          fail('missing selected trap frame or retained route');
        const receiver=base,args=reflection?[['ref',ownerNode.targetId],...(operation==='defineProperty'?
            [event.operands[2],['ref',pending.descriptorObject]]:['setPrototypeOf','getOwnPropertyDescriptor'].includes(operation)?[event.operands[2]]:[])]:
          [['ref',ownerNode.targetId],key,...(operation==='set'?[event.operands[2]]:[]),
            ...(['get','set'].includes(operation)?[receiver]:[])],fn=state.heap[selected[1]],
          environment=event.stateChanges.find(change=>change.table==='envs'&&change.id===child.envId)?.after;
        if(fn?.kind!=='function'||child.codeId!==fn.codeId||environment?.parent!==fn.closureEnvId)
          fail('selected trap source function or closure differs');
        const effective=fn.arrow?(fn.lexicalThisFrameId?state.frames[fn.lexicalThisFrameId]?.thisValue:fn.lexicalThis):['ref',ownerNode.handlerId];
        if(JSON.stringify(child.thisValue)!==JSON.stringify(effective))fail('trap effective receiver differs');
        if(!bundle.programs[fn.codeId].params.every((name,index)=>environment.bindings[name]?.initialized&&
          JSON.stringify(environment.bindings[name].token?.value)===JSON.stringify(args[index]??['undefined'])))
          fail('trap parameter values differ from native call arguments');
        add('call',{operation,object:value(['ref',trapOwner]),method:value(selected),
          receiver:value(['ref',ownerNode.handlerId]),arguments:args.map(value)});
        children.set(child.id,{operation,object:['ref',trapOwner],method:selected});
      }else if(!['undefined','null'].includes(selected[0]))fail('selected trap has no invocation');
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
  const registered=new WeakMap(),rows=[],identities=new Map(),failures=[],ordinaryPrototypes=new Set([Object.prototype]),
    revokedProxyHistory=new Map();
  if(side==='owned'&&bundle)for(const event of bundle.events)for(const change of event.stateChanges??[])
    if(change.table==='heap'&&change.before?.kind==='proxy'&&change.after?.kind==='proxy'&&
      change.before.targetId!==null&&change.after.targetId===null&&change.after.handlerId===null)
      revokedProxyHistory.set(change.id,{targetId:change.before.targetId,handlerId:change.before.handlerId});
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
  function nativeTarget(value,ctx,label,{allowAccessors=false}={}){
    if(types.isProxy(value)){
      if(!registered.has(value))ctx.fail(label+' is an unregistered Proxy');
      return null;
    }
    if(value===null||typeof value!=='object'||Array.isArray(value))ctx.fail(label+' must be an ordinary object');
    const descriptors=own(value);
    if(!allowAccessors&&Reflect.ownKeys(descriptors).some(key=>!Object.hasOwn(descriptors[key],'value')))ctx.fail(label+' accessor');
    return descriptors;
  }
  function ownedTarget(tag,ctx,label,{allowAccessors=false}={}){
    const node=tag?.[0]==='ref'?ctx.state.heap[tag[1]]:null;
    if(node?.kind==='proxy')return node;
    if(node?.kind!=='object'||!allowAccessors&&Object.keys(node.accessors??{}).length)ctx.fail(label+' must be an ordinary object');
    return node;
  }
  function ownedOrdinary(tag,ctx,label,{allowAccessors=false}={}){
    const node=tag?.[0]==='ref'?ctx.state.heap[tag[1]]:null;
    if(node?.kind!=='object'||![undefined,null,'Object.prototype'].includes(node.prototype)||
      !allowAccessors&&Object.keys(node.accessors??{}).length)
      ctx.fail(label+' must be an ordinary data object');return node;
  }
  function nativeHandler(value,ctx){return nativeOrdinary(value,ctx,'Proxy handler');}
  function ownedHandler(value,ctx){return ownedOrdinary(value,ctx,'Proxy handler');}
  const metadataTraps=['getOwnPropertyDescriptor','ownKeys','getPrototypeOf','isExtensible'];
  function ownedMetadataTarget(tag,ctx){
    let current=tag,node=current?.[0]==='ref'?ctx.state.heap[current[1]]:null,seen=new Set();
    while(node?.kind==='proxy'){
      if(seen.has(current[1]))ctx.fail('cyclic target metadata route');seen.add(current[1]);
      const handler=ownedHandler(['ref',node.handlerId],ctx);
      for(const name of metadataTraps){
        const slot=handler.properties?.[name]?.value;
        if(slot&&!['undefined','null'].includes(slot[0]))ctx.fail('nested target metadata trap requires its internal-method boundary');
      }
      current=['ref',node.targetId];node=ctx.state.heap[current[1]];
    }
    if(!node||!['object','array'].includes(node.kind))ctx.fail('nested target metadata storage');
    return current;
  }
  function nativeMetadataTarget(raw,ctx){
    let current=raw,seen=new Set();
    while(types.isProxy(current)){
      if(seen.has(current))ctx.fail('cyclic target metadata route');seen.add(current);
      const captured=registered.get(current);if(!captured)ctx.fail('unregistered nested target Proxy');
      const descriptors=nativeHandler(captured.handler,ctx);
      for(const name of metadataTraps){
        const method=descriptors[name]?.value;
        if(method!=null)ctx.fail('nested target metadata trap requires its internal-method boundary');
      }
      current=captured.target;
    }
    return current;
  }
  const revoked=new WeakSet();
  function observedHandler(target,handler,ctx,readResult){
    return new Proxy({}, {get(_target,operation){
      const descriptors=nativeHandler(handler,ctx),descriptor=descriptors[operation];
      const method=descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:Reflect.get(handler,operation,handler);
      nativeTarget(target,ctx,'Proxy target',{allowAccessors:['has','deleteProperty'].includes(operation)});
      if(!['get','set','has','deleteProperty','getPrototypeOf','setPrototypeOf','isExtensible','preventExtensions','getOwnPropertyDescriptor','ownKeys','defineProperty'].includes(operation)||method==null||typeof method!=='function')return method;
      const semanticOperation=operation==='deleteProperty'?'delete':operation;
      return (...trapArgs)=>{
        const key=['getPrototypeOf','setPrototypeOf','isExtensible','preventExtensions','ownKeys'].includes(operation)?undefined:trapArgs[1],result=readResult();
        add('select',{operation:semanticOperation,object:value(result),key:value(key),method:value(method)});
        add('call',{operation:semanticOperation,object:value(result),method:value(method),receiver:value(handler),arguments:trapArgs.map(value)});
        try{const returned=invoke({callee:method,receiver:handler,arguments:trapArgs});
          add('return',{operation:semanticOperation,object:value(result),method:value(method),value:value(returned)});return returned;
        }catch(error){add('throw',{operation:semanticOperation,object:value(result),method:value(method),value:value(error)});throw error;}
      };
    }});
  }
  function observedProxy(site,target,handler,{revocable=false}={}){
    const ctx={fail,intrinsicPrototype:value=>ordinaryPrototypes.has(value)?'Object.prototype':value};
    nativeTarget(target,ctx,'Proxy target');nativeHandler(handler,ctx);
    let result=null;
    const wrapped=observedHandler(target,handler,ctx,()=>result);
    if(revocable){
      const pair=Reflect.apply(nativeProxy.revocable,nativeProxy,[target,wrapped]);result=pair.proxy;
      registered.set(result,{target,handler});
      const originalRevoke=pair.revoke,revoke=(...args)=>{
        add('revoke',{object:value(result)});revoked.add(result);return Reflect.apply(originalRevoke,undefined,args);
      };
      Object.defineProperty(revoke,'name',{value:'',configurable:true});
      Object.defineProperty(pair,'revoke',{value:revoke,writable:true,enumerable:true,configurable:true});
      add('create',{site,object:value(result),target:value(target),handler:value(handler)});return pair;
    }
    result=construct(nativeProxy,[target,wrapped]);registered.set(result,{target,handler});
    add('create',{site,object:value(result),target:value(target),handler:value(handler)});return result;
  }
  return {id:PROXY_OBSERVATION_PROFILE_V8,
    setCallObserver(observer){invoke=observer;},
    nativeEnumerationTarget(raw){
      if(!types.isProxy(raw))return undefined;
      const ctx={fail,intrinsicPrototype:value=>ordinaryPrototypes.has(value)?'Object.prototype':value};
      let current=raw;const seen=new Set();
      while(types.isProxy(current)){
        if(seen.has(current)||seen.size>=64)fail('enumeration Proxy route cycle/bound');seen.add(current);
        const entry=registered.get(current);if(!entry)fail('unregistered enumeration Proxy');
        const descriptors=nativeHandler(entry.handler,ctx);
        for(const name of ['ownKeys','getOwnPropertyDescriptor','getPrototypeOf']){
          const descriptor=descriptors[name];
          if(descriptor&&(!Object.hasOwn(descriptor,'value')||descriptor.value!=null))
            fail('enumeration Proxy trap requires its internal-method continuation');
        }
        current=entry.target;
      }
      return current;
    },

    ownedAssignmentValue({object,key,state}){
      if(object.kind!=='proxy')return undefined;
      const ctx={state,fail(message){throw new TypeError('Proxy assignment observation: '+message);}},
        target=ownedTarget(['ref',object.targetId],ctx,'Proxy target'),handler=ownedHandler(['ref',object.handlerId],ctx);
      if(handler.properties.set&&!['undefined','null'].includes(handler.properties.set.value[0]))ctx.fail('setter trap lacks its completion observer');
      return target.properties?.[key]?.value??['missing-storage'];
    },
    initializeRealm(evaluate){nativeProxy=evaluate('Proxy');ordinaryPrototypes.add(evaluate('Object.prototype'));},
    globals:{[hook]:(site,callee)=>{
      const constructor=(...args)=>callee===nativeProxy?observedProxy(site,args[0],args[1]):construct(callee,args);
      constructor.revocable=(target,handler)=>callee===nativeProxy?observedProxy(site,target,handler,{revocable:true}):
        Reflect.apply(callee.revocable,callee,[target,handler]);
      return constructor;
    }},
    instrument(text){
      const nodes=allocations(text);if(nodes.length!==original.length)throw new TypeError('Proxy source constructor inventory changed');
      const edits=nodes.map((node,index)=>node.type==='NewExpression'?
        {start:node.start,end:node.callee.end,text:hook+'('+JSON.stringify(original[index].start+':'+original[index].end)+',Proxy)'}:
        {start:node.callee.start,end:node.callee.end,text:hook+'('+JSON.stringify(original[index].start+':'+original[index].end)+',Proxy).revocable'}
      ).sort((a,b)=>b.start-a.start);
      for(const edit of edits)text=text.slice(0,edit.start)+edit.text+text.slice(edit.end);return text;
    },
    metadataAdapter:side==='owned'?{ownedNode(value,ctx){
      const node=value[0]==='ref'?ctx.state.heap[value[1]]:null;if(node?.kind!=='proxy')return null;
      const revoked=node.targetId===null&&node.handlerId===null,history=revokedProxyHistory.get(node.id);
      if(revoked&&!history)ctx.fail('revoked Proxy lacks its retained metadata identities');
      const target=['ref',revoked?history.targetId:node.targetId],handler=revoked?null:['ref',node.handlerId];
      ownedTarget(target,ctx,'Proxy target',{allowAccessors:true});
      if(handler)ownedHandler(handler,ctx);const metadataTarget=ownedMetadataTarget(target,ctx);
      if(Object.keys(node.properties??{}).length||Object.keys(node.propertyVersions??{}).length||node.shapeVersion!==0)
        ctx.fail('Proxy has invented own state');
      return {...ctx.defaultNode(metadataTarget),kind:'proxy',annotations:[{name:'proxy-target-handler/1',
        values:revoked?[['null'],['null']]:[target,handler],data:{}}]};
    }}:{nativeProxyNode(value,ctx){
      const captured=registered.get(value);if(!captured)return null;
      if(revoked.has(value))return {...ctx.defaultNode(captured.target),kind:'proxy',annotations:[{
        name:'proxy-target-handler/1',values:[null,null],data:{}}]};
      nativeTarget(captured.target,ctx,'Proxy target',{allowAccessors:true});nativeHandler(captured.handler,ctx);
      const metadataTarget=nativeMetadataTarget(captured.target,ctx);
      return {...ctx.defaultNode(metadataTarget),kind:'proxy',annotations:[{
        name:'proxy-target-handler/1',values:[captured.target,captured.handler],data:{}}]};
    }},
    observations(){if(side==='owned')return ownedObservations(bundle,original);if(failures.length)fail(failures[0]);return rows;}
  };
}
