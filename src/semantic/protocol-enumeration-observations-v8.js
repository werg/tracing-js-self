// Independent native for-in evidence. Descriptor inspection never invokes a
// getter; the step hook records keys yielded by the real source loop itself.
// This module imports neither the runtime nor the public enumeration evaluator.
import {parse} from 'acorn';
import {types} from 'node:util';
import {encode} from '../values.js';
import {propertyKeyValue} from '../property-keys.js';

export const ENUMERATION_OBSERVATION_PROFILE_V8='ordinary-for-in-observations/1';
const beginHook='__tracingProtocolEnumerationBegin',stepHook='__tracingProtocolEnumerationStep';
const ordinary=new Set(['Object.prototype','Array.prototype','Function.prototype']);
function loops(source){const found=[];
  function visit(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}
    if(node.type==='ForInStatement'){
      const target=node.left.type==='VariableDeclaration'&&node.left.declarations.length===1?node.left.declarations[0].id:node.left;
      if(target.type!=='Identifier')throw new TypeError('For-in observation requires a simple loop binding');
      found.push({node,name:target.name});
    }
    for(const [key,child]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))visit(child);
  }visit(parse(source,{ecmaVersion:'latest',sourceType:'script'}));return found;
}
function ownedObservations(bundle,sites){
  const rows=[],identities=new Map(),state=structuredClone(bundle.initialState),bySite=new Map(bundle.sites.map(row=>[row.siteId,row.start+':'+row.end]));let serial=0;
  const fail=message=>{throw new TypeError('Owned for-in observation: '+message);};
  function value(tag){
    if(!['ref','symbol'].includes(tag[0]))return structuredClone(tag);
    const key=JSON.stringify(tag);if(!identities.has(key))identities.set(key,++serial);
    return ['identity',tag[0]==='symbol'?'symbol':bundle.finalState.heap[tag[1]]?.kind==='function'?'function':'object',identities.get(key)];
  }
  function seed(tag){if(!['ref','symbol'].includes(tag?.[0])||identities.has(JSON.stringify(tag)))return;value(tag);
    if(tag[0]==='symbol')return;const node=state.heap[tag[1]];
    if(!node||Object.keys(node.accessors??{}).length)fail('initial graph must have ordinary data');
    for(const key of Object.keys(node.properties??{}).sort())seed(node.properties[key].value);
  }
  bundle.entrySpec.arguments.forEach(seed);
  const add=row=>{if(rows.length>=32768)fail('observation bound');rows.push(row);};
  for(const event of bundle.events){
    const frame=state.frames[event.invocationId],instruction=bundle.programs[frame?.codeId]?.instructions[frame.pc],site=bySite.get(event.siteId);
    if(instruction?.op==='FOR_IN_CREATE'){
      if(!sites.has(site))fail('unanchored enumeration creation');
      const cursor=event.stateChanges.find(change=>change.table==='heap'&&change.before===null&&change.id===event.result?.[1])?.after;
      if(cursor?.kind!=='enumerator')fail('missing cursor creation');
      add({site,kind:'begin',source:value(cursor.source),chain:cursor.chain.map(row=>({id:value(['ref',row.id]),
        prototype:row.prototype===null?null:ordinary.has(row.prototype)?'ordinary':value(['ref',row.prototype]),
        keys:row.keys.map(([key,enumerable])=>[propertyKeyValue(key)[1],enumerable])})),keys:structuredClone(cursor.keys)});
    }else if(instruction?.op==='FOR_IN_NEXT'){
      if(!sites.has(site))fail('unanchored enumeration step');
      const result=event.stateChanges.find(change=>change.table==='heap'&&change.before===null&&change.id===event.result?.[1])?.after;
      if(result?.properties.done?.value[0]!=='bool')fail('missing enumeration result');
      if(!result.properties.done.value[1]){
        const key=result.properties.value?.value;if(key?.[0]!=='str')fail('non-string enumeration key');
        add({site,kind:'key',key:key[1]});
      }
    }
    for(const change of event.stateChanges)if(state[change.table]){
      if(change.after===null)delete state[change.table][change.id];else if(change.after!==undefined)state[change.table][change.id]=change.after;
    }
  }
  return rows;
}
export function createEnumerationObservationAdapterV8({source,side='native',bundle=null,initialValues=[]}={}){
  const inventory=loops(source);if(!inventory.length)return null;
  const sites=new Set(inventory.map(({node})=>node.start+':'+node.end));
  if(side==='owned')return {id:ENUMERATION_OBSERVATION_PROFILE_V8,observations:()=>ownedObservations(bundle,sites)};
  const rows=[],identities=new Map(),intrinsics=new Set([Object.prototype,Array.prototype,Function.prototype]),failures=[];let serial=0,proxyTarget=null;
  const fail=message=>{failures.push(message);throw new TypeError('Native for-in observation: '+message);};
  function value(raw){
    const kind=typeof raw;if(raw===null||!['object','function','symbol'].includes(kind))return encode(raw);
    if(!identities.has(raw))identities.set(raw,++serial);return ['identity',kind,identities.get(raw)];
  }
  function seed(raw){if(raw===null||!['object','function','symbol'].includes(typeof raw)||identities.has(raw))return;
    if(types.isProxy(raw))fail('initial Proxy');value(raw);if(typeof raw==='symbol')return;
    const descriptors=Object.getOwnPropertyDescriptors(raw);
    for(const key of Object.keys(descriptors).sort()){
      if(!Object.hasOwn(descriptors[key],'value'))fail('initial graph must have ordinary data');seed(descriptors[key].value);
    }
  }
  initialValues.forEach(seed);
  function snapshot(source){
    const chain=[],keys=[],seen=new Set(),objects=new Set();
    if(typeof source==='string'){
      if(source.length>4096)fail('string bound');return {chain,keys:Array.from({length:source.length},(_,index)=>String(index))};
    }
    if(source===null||!['object','function'].includes(typeof source))return {chain,keys};
    for(let object=source;;){
      const identity=object;
      if(types.isProxy(object)){
        if(!proxyTarget)fail('Proxy enumeration requires its constructor registry');
        object=proxyTarget(object);if(!object)fail('unregistered enumeration Proxy');
      }
      if(typeof object==='function'||types.isProxy(object)||objects.has(identity)||chain.length>=128)fail('exotic, callable or cyclic prototype');objects.add(identity);
      const descriptors=Object.getOwnPropertyDescriptors(object),own=Reflect.ownKeys(descriptors).filter(key=>typeof key==='string').map(key=>[key,descriptors[key].enumerable]);
      const parent=Object.getPrototypeOf(object),prototype=parent===null?null:intrinsics.has(parent)?'ordinary':value(parent);
      chain.push({id:value(identity),prototype,keys:own});
      for(const [key,enumerable]of own)if(!seen.has(key)){
        seen.add(key);if(seen.size>4096)fail('key bound');if(enumerable)keys.push(key);
      }
      if(prototype===null||prototype==='ordinary')break;object=parent;
    }
    return {chain,keys};
  }
  const add=row=>{if(rows.length>=32768)fail('observation bound');rows.push(row);};
  return {id:ENUMERATION_OBSERVATION_PROFILE_V8,
    setProxyEnumerationTarget(resolve){proxyTarget=resolve;},
    initializeRealm(evaluate){for(const prototype of evaluate('[Object.prototype,Array.prototype,Function.prototype]'))intrinsics.add(prototype);},
    globals:{[beginHook]:(site,source)=>{if(!sites.has(site))fail('unknown source loop');const reference=value(source),selected=snapshot(source);
      add({site,kind:'begin',source:reference,...selected});return source;},
      [stepHook]:(site,key)=>{if(!sites.has(site)||typeof key!=='string')fail('invalid actual source key');add({site,kind:'key',key});}},
    instrument(text){
      const current=loops(text);if(current.length!==inventory.length)fail('loop inventory changed');const insertions=new Map();
      const insert=(at,fragment)=>insertions.set(at,(insertions.get(at)??'')+fragment);
      current.forEach(({node,name},index)=>{
        const site=JSON.stringify(inventory[index].node.start+':'+inventory[index].node.end);
        insert(node.right.start,beginHook+'('+site+',(');insert(node.right.end,'))');
        const hook=stepHook+'('+site+','+name+');';
        // Read the loop binding outside the original body's lexical scope.
        // A body-local `let key` may legitimately shadow the selected key.
        insert(node.body.start,'{'+hook);insert(node.body.end,'}');
      });
      for(const [at,fragment]of [...insertions].sort(([a],[b])=>b-a))text=text.slice(0,at)+fragment+text.slice(at);return text;
    },
    observations(){if(failures.length)fail(failures[0]);return rows;}
  };
}
