// Independent observations of the native calls actually made by the source.
// Inspecting a generator never advances it or evaluates its body a second time.
// This module deliberately imports no owned interpreter or public evaluator.
import {parse} from 'acorn';
import {types} from 'node:util';
import {propertyKeyValue} from '../property-keys.js';
import {encode} from '../values.js';

export const GENERATOR_OBSERVATION_PROFILE_V8='synchronous-generator-metadata/1';
const directHook='__tracingProtocolGeneratorCallee',memberHook='__tracingProtocolGeneratorMember';
const intrinsicNames=['GeneratorFunction.prototype','Generator.prototype','Iterator.prototype'];
const apply=Reflect.apply,getPrototype=Object.getPrototypeOf;
const fail=message=>{throw new TypeError('Independent generator observation: '+message);};
function instrument(source){
  const edits=[];
  function visit(node,inChain=false){
    if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(child=>visit(child,inChain));return;}
    inChain||=node.type==='ChainExpression';
    if(!inChain&&node.type==='CallExpression'&&!node.optional){
      const callee=node.callee,generated=callee.type==='Identifier'&&(/^__tracing/.test(callee.name)||callee.name==='Number')||
        callee.type==='CallExpression'&&callee.callee.type==='Identifier'&&/^__tracing/.test(callee.callee.name);
      if(!generated&&callee.type==='MemberExpression'&&!callee.optional&&callee.object.type!=='Super'&&callee.property.type!=='PrivateIdentifier'){
        edits.push({start:callee.start,end:callee.object.start,text:memberHook+'(('});
        edits.push({start:callee.object.end,end:callee.property.start,text:'),'+(callee.computed?'(':JSON.stringify(callee.property.name))});
        if(callee.computed)edits.push({start:callee.property.end,end:callee.end,text:'))'});
        else edits.push({start:callee.property.start,end:callee.end,text:')'});
      }else if(!generated&&callee.type!=='MemberExpression'&&callee.type!=='Super'){
        edits.push({start:callee.start,end:callee.start,text:directHook+'(('});
        edits.push({start:callee.end,end:callee.end,text:'))'});
      }
    }
    for(const [key,value]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))visit(value,inChain);
  }
  visit(parse(source,{ecmaVersion:'latest',sourceType:'script'}));edits.sort((a,b)=>b.start-a.start||b.end-a.end);
  let end=source.length;
  for(const edit of edits){if(edit.end>end)fail('overlapping call observation edits');
    source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);end=edit.start;}
  return source;
}
function ownedProperties(node){
  const keys=[...new Set([...(node.propertyOrder??[]),...Object.keys(node.properties??{}),...Object.keys(node.accessors??{})])]
    .filter(key=>Object.hasOwn(node.properties??{},key)||Object.hasOwn(node.accessors??{},key));
  const numeric=key=>/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)<4294967295;
  const ordered=[...keys.filter(numeric).sort((a,b)=>Number(a)-Number(b)),
    ...keys.filter(key=>!numeric(key)&&propertyKeyValue(key)[0]==='str'),...keys.filter(key=>propertyKeyValue(key)[0]==='symbol')];
  return ordered.map(key=>{const accessor=node.accessors?.[key];return {key:propertyKeyValue(key),descriptor:accessor?
    {kind:'accessor',get:accessor.get.value,set:accessor.set.value,enumerable:accessor.enumerable,configurable:accessor.configurable}:
    {kind:'data',value:node.properties[key].value,writable:true,enumerable:true,configurable:true,...node.dataAttributes?.[key]}};});
}
export function createGeneratorObservationAdapterV8({source,side='native',bundle=null,initialValues=[]}={}){
  if(typeof source!=='string')return null;
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'script'});let hasGenerator=false;
  function scan(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(scan);return;}
    if(node.generator&&!node.async)hasGenerator=true;for(const [key,value]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))scan(value);}
  scan(ast);if(!hasGenerator)return null;
  const cursors=new WeakMap(),intrinsics=new Map(),resumers=new Map(),ownedCreations=new Map(),ownedYields=new Map(),rows=[],identities=new Map();let lookup=null;
  function observedValue(value){
    if(side==='owned'){
      if(!Array.isArray(value))fail('missing owned lifecycle value');
      if(!['ref','symbol'].includes(value[0]))return structuredClone(value);
      const key=JSON.stringify(value);if(!identities.has(key))identities.set(key,identities.size+1);
      return ['identity',value[0]==='symbol'?'symbol':bundle.finalState.heap[value[1]]?.kind==='function'?'function':'object',identities.get(key)];
    }
    if(value===null||!['object','function','symbol'].includes(typeof value))return encode(value);
    if(!identities.has(value))identities.set(value,identities.size+1);
    return ['identity',typeof value==='symbol'?'symbol':typeof value==='function'?'function':'object',identities.get(value)];
  }
  function seed(value){
    if(side==='owned'){
      if(value?.[0]!=='ref'||identities.has(JSON.stringify(value)))return;observedValue(value);
      for(const key of Object.keys(bundle.initialState.heap[value[1]]?.properties??{}).sort())seed(bundle.initialState.heap[value[1]].properties[key].value);
    }else{
      if(value===null||!['object','function'].includes(typeof value)||identities.has(value))return;
      if(types.isProxy(value))fail('unobserved Proxy input');observedValue(value);
      const descriptors=Object.getOwnPropertyDescriptors(value);
      for(const key of Object.keys(descriptors).sort()){if(!Object.hasOwn(descriptors[key],'value'))fail('accessor input');seed(descriptors[key].value);}
    }
  }
  for(const value of side==='owned'?bundle.entrySpec.arguments:initialValues)seed(value);
  function append(row){if(rows.length>=32768)throw new RangeError('Generator lifecycle observation bound');rows.push(row);}
  const created=(instance,callee,receiver,args)=>append({kind:'create',instance:observedValue(instance),callee:observedValue(callee),
    receiver:observedValue(receiver),arguments:args.map(observedValue)});
  const resumed=(instance,method,args,phase)=>append({kind:'resume',instance:observedValue(instance),method,phase,arguments:args.map(observedValue)});
  if(side==='owned'){
    const counts=new Map(),live=new Map();
    for(const event of bundle.events){
      const raw=event.operands[0],callee=raw?.[0]==='method'?raw[1]:raw,receiver=raw?.[0]==='method'?raw[2]:null;
      if(event.operation==='call.enter'&&callee?.[0]==='builtinfn'&&['Generator.next','Generator.return','Generator.throw'].includes(callee[1])){
        const node=receiver?.[0]==='ref'?live.get(receiver[1]):null;
        if(node)resumed(receiver,callee[1].slice('Generator.'.length),event.operands.slice(1),node.state);
      }
      for(const change of event.stateChanges)if(change.table==='heap'&&change.after?.kind==='generator'){
      const node=change.after;
      if(change.before===null){
        const raw=event.operands[0],callee=raw?.[0]==='method'?raw[1]:raw,
          frame=event.stateChanges.find(row=>row.table==='frames'&&row.id===node.frameId)?.after;
        if(callee?.[0]!=='ref'||callee[1]!==node.functionId||!frame)fail('owned creation has no exact callable/receiver');
        ownedCreations.set(node.id,{callee,receiver:frame.thisValue,arguments:event.operands.slice(1)});counts.set(node.id,0);
        created(['ref',node.id],callee,frame.thisValue,event.operands.slice(1));
      }
      if(change.before?.state==='executing'&&node.state==='suspendedYield')counts.set(node.id,(counts.get(node.id)??0)+1);
      ownedYields.set(node.id+':'+node.version,counts.get(node.id));
      live.set(node.id,node);
      }
    }
  }
  function observeCall(call,next){
    const {callee,receiver,arguments:args}=call;
    if(types.isGeneratorFunction(callee)){
      const result=next();if(!types.isGeneratorObject(result))fail('generator function returned no native generator');
      cursors.set(result,{callee,receiver,arguments:[...args],phase:'suspendedStart',yielded:0});created(result,callee,receiver,args);return result;
    }
    const method=resumers.get(callee);if(!method)return next();
    const cursor=cursors.get(receiver);if(!cursor)fail('resume has no independently observed generator allocation');
    resumed(receiver,method,args,cursor.phase);
    if(cursor.phase==='executing')return next();
    cursor.phase='executing';
    try{
      const result=next(),d=Object.getOwnPropertyDescriptors(result);
      if(!d.done||!Object.hasOwn(d.done,'value')||typeof d.done.value!=='boolean'||!d.value||!Object.hasOwn(d.value,'value'))fail('native generator result shape');
      cursor.phase=d.done.value?'completed':'suspendedYield';if(!d.done.value)cursor.yielded++;
      return result;
    }catch(error){cursor.phase='completed';throw error;}
  }
  let invoke=call=>observeCall(call,()=>apply(call.callee,call.receiver,call.arguments));
  function selected(callee,receiver){return (...args)=>invoke({callee,receiver,arguments:args});}
  const adapter={id:GENERATOR_OBSERVATION_PROFILE_V8,instrument,observeCall,observations:()=>structuredClone(rows),setCallObserver(value){invoke=value;},
    globals:{[directHook]:callee=>selected(callee,undefined),[memberHook]:(receiver,key)=>{
      if(!lookup)fail('guest-realm lookup is unavailable');return selected(apply(lookup,undefined,[receiver,key]),receiver);
    }},initializeRealm(evaluate){
      const captured=evaluate('(()=>{const g=function*(){},p=Object.getPrototypeOf(g.prototype);return '+
        '{functionPrototype:Object.getPrototypeOf(g),generatorPrototype:p,iteratorPrototype:Object.getPrototypeOf(p),next:p.next,throw:p.throw,return:p.return,lookup:(receiver,key)=>receiver[key]};})()');
      [captured.functionPrototype,captured.generatorPrototype,captured.iteratorPrototype].forEach((value,index)=>intrinsics.set(value,intrinsicNames[index]));
      for(const name of ['next','return','throw'])resumers.set(captured[name],name);lookup=captured.lookup;
    },metadataAdapter:{
      nativeNode(value,ctx){
        const prototype=getPrototype(value),intrinsic=intrinsics.get(prototype);
        if(types.isGeneratorObject(value)){
          const cursor=cursors.get(value);if(!cursor)fail('generator state lacks its independently observed creation');
          return {...ctx.defaultNode(value),kind:'generator',prototype:intrinsic??ctx.intrinsicPrototype(prototype),annotations:[{
            name:GENERATOR_OBSERVATION_PROFILE_V8,values:[cursor.callee,cursor.receiver,...cursor.arguments],
            data:{phase:cursor.phase,yielded:cursor.yielded}}]};
        }
        if(types.isGeneratorFunction(value)||intrinsic)return {...ctx.defaultNode(value,{includeFunctions:true}),prototype:intrinsic??ctx.intrinsicPrototype(prototype)};
        return null;
      },
      ownedNode(value,ctx){
        const node=value[0]==='ref'?ctx.state.heap[value[1]]:null;if(!node)return null;
        if(node.kind==='generator'){
          const point=ctx.observation,event=point?.event;
          // Return/throw hooks run after their value expression and before
          // GeneratorComplete changes the hidden lifecycle state. Ordinary
          // metadata still reads the committed result of that expression.
          const lifecycle=['return','throw'].includes(point?.row.kind)&&event?.invocationId===node.frameId?
            event.stateChanges.find(change=>change.table==='heap'&&change.id===node.id)?.before??node:node;
          const saved=ownedCreations.get(node.id),yielded=ownedYields.get(node.id+':'+lifecycle.version);
          if(!saved||!Number.isSafeInteger(yielded))ctx.fail('generator state has no creation/lifecycle evidence');
          const frame=ctx.state.frames[node.frameId];if(!frame||node.functionId!==saved.callee[1]||JSON.stringify(frame.thisValue)!==JSON.stringify(saved.receiver))
            ctx.fail('generator retained callable/receiver changed');
          return {kind:'generator',prototype:intrinsicNames.includes(node.prototype)?node.prototype:['ref',node.prototype],
            extensible:node.extensible!==false,properties:ownedProperties(node),annotations:[{
              name:GENERATOR_OBSERVATION_PROFILE_V8,values:[['ref',node.functionId],frame.thisValue,...saved.arguments],data:{phase:lifecycle.state,yielded}}]};
        }
        if(node.generatorFunction||intrinsicNames.includes(node.prototype))
          return {...ctx.defaultNode(value,{includeFunctions:true}),prototype:intrinsicNames.includes(node.prototype)?node.prototype:ctx.defaultNode(value,{includeFunctions:true}).prototype};
        return null;
      }
    }};
  return adapter;
}
