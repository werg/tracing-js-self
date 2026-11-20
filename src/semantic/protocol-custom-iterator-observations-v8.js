// Observe the native engine's implicit for-of method selections and calls.
// The private iterable/result wrappers are never exposed to guest code. Every
// selected guest method and accessor retains its original receiver and value.
import {parse} from 'acorn';
import {types} from 'node:util';
import {encode} from '../values.js';

export const CUSTOM_ITERATOR_OBSERVATION_PROFILE_V8='custom-iterator-observations/1';
const hook='__tracingProtocolCustomIterable',apply=Reflect.apply;
const reference=value=>value!==null&&['object','function'].includes(typeof value);
function loops(source){const rows=[];
  function visit(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}
    if(node.type==='ForOfStatement'&&!node.await)rows.push(node);
    for(const [key,value]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))visit(value);
  }visit(parse(source,{ecmaVersion:'latest',sourceType:'script'}));return rows;
}
function ownedObservations(bundle,nodes){
  const sites=new Set(nodes.map(node=>node.start+':'+node.end)),siteById=new Map(bundle.sites.map(row=>[row.siteId,row.start+':'+row.end])),
    rows=[],identities=new Map(),state=structuredClone(bundle.initialState),active=new Map(),children=new Map();let next=0;
  const fail=message=>{throw new TypeError('Owned custom iterator observation: '+message);};
  function value(tag){
    if(!Array.isArray(tag))fail('missing value');
    if(!['ref','symbol'].includes(tag[0]))return structuredClone(tag);
    const key=JSON.stringify(tag);if(!identities.has(key))identities.set(key,++next);
    return ['identity',tag[0]==='symbol'?'symbol':bundle.finalState.heap[tag[1]]?.kind==='function'?'function':'object',identities.get(key)];
  }
  function seed(tag){if(tag?.[0]!=='ref'||identities.has(JSON.stringify(tag)))return;value(tag);
    const node=state.heap[tag[1]];if(!node||Object.keys(node.accessors??{}).length)fail('input graph is not data-only');
    for(const key of Object.keys(node.properties??{}).sort())seed(node.properties[key].value);
  }bundle.entrySpec.arguments.forEach(seed);
  const add=(site,kind,fields)=>{if(rows.length>=32768)throw new RangeError('Custom iterator observation bound');rows.push({site,kind,...fields});};
  function finishRead(entry,result,thrown){
    add(entry.site,thrown?'read.throw':'read.return',{operation:entry.operation,value:value(result)});
    if(!thrown&&['iterator','next','return'].includes(entry.operation))entry.owner.selected=entry.operation;
  }
  for(const event of bundle.events){
    const frame=state.frames[event.invocationId],inst=bundle.programs[frame?.codeId]?.instructions[frame?.pc],site=siteById.get(event.siteId),
      key=event.invocationId+':'+site;
    if(sites.has(site)&&inst?.op==='ITERATOR_ARRAY_GUARD'){
      if(event.result?.[1]===false){const entry={site,selected:null};active.set(key,entry);add(site,'begin',{receiver:value(event.operands[0])});}
      else active.delete(key);
    }
    const owner=active.get(key);
    if(owner&&['GET_PROP','GET_METHOD'].includes(inst?.op)&&event.operation==='property.read'){
      const property=event.operands[1],operation=property?.[0]==='symbol'&&property[1]==='well-known:iterator'?'iterator':
        property?.[0]==='str'&&['next','return','done','value'].includes(property[1])?property[1]:null;
      if(operation){
        add(site,'read',{operation,receiver:value(event.operands[0])});
        const entry={site,operation,owner},child=event.causes.find(row=>row.kind==='invocation')?.frameId;
        if(child)children.set(child,{...entry,kind:'read'});
        else finishRead(entry,event.result?.[0]==='method'?event.result[1]:event.result,false);
      }
    }
    if(owner&&inst?.op==='GET'&&/^\[\[iterator next /.test(inst.arg))owner.selected='next';
    if(owner&&inst?.op==='CALL'&&event.operation==='call.enter'){
      const raw=event.operands[0],operation=owner.selected,child=event.causes.find(row=>row.kind==='invocation')?.frameId;
      if(raw?.[0]!=='method'||!['iterator','next','return'].includes(operation)||!child)fail('implicit call lacks its selected guest method');
      add(site,'call',{operation,method:value(raw[1]),receiver:value(raw[2]),arguments:event.operands.slice(1).map(value)});
      children.set(child,{kind:'call',site,operation});owner.selected=null;
    }
    const finished=event.stateChanges.filter(change=>change.table==='frames'&&children.has(change.id)&&
      !['completed','thrown'].includes(change.before?.status)&&['completed','thrown'].includes(change.after?.status));
    const depth=id=>{let count=0;const seen=new Set();while(id){if(seen.has(id))fail('cyclic callback chain');seen.add(id);count++;id=state.frames[id]?.callerFrameId;}return count;};
    finished.sort((a,b)=>depth(b.id)-depth(a.id));
    for(const change of finished){
      const entry=children.get(change.id),completion=change.after.completion,result=completion?.value?.value,thrown=completion?.type==='throw';
      if(!['return','throw'].includes(completion?.type)||!result)fail('missing callback completion');
      if(entry.kind==='read')finishRead(entry,result,thrown);
      else add(entry.site,thrown?'call.throw':'call.return',{operation:entry.operation,value:value(result)});
      children.delete(change.id);
    }
    for(const change of event.stateChanges)if(state[change.table]){
      if(change.after===null)delete state[change.table][change.id];else if(change.after!==undefined)state[change.table][change.id]=change.after;
    }
  }
  if(children.size)fail('unfinished implicit callbacks');return rows;
}
export function createCustomIteratorObservationAdapterV8({source,side='native',bundle=null,initialValues=[]}={}){
  const nodes=loops(source);if(!nodes.length)return null;
  if(side==='owned')return {id:CUSTOM_ITERATOR_OBSERVATION_PROFILE_V8,observations:()=>ownedObservations(bundle,nodes)};
  const rows=[],identities=new Map(),failures=[];let next=0,lookup=null,arrayPrototype=null;
  let invoke=call=>apply(call.callee,call.receiver,call.arguments);
  const fail=message=>{failures.push(message);throw new TypeError('Native custom iterator observation: '+message);};
  function value(raw){
    if(!reference(raw)&&typeof raw!=='symbol')return encode(raw);
    if(reference(raw)&&types.isProxy(raw))fail('guest Proxy requires its own profile');
    if(!identities.has(raw))identities.set(raw,++next);return ['identity',typeof raw,identities.get(raw)];
  }
  function seed(raw){if(!reference(raw)||identities.has(raw))return;value(raw);
    const descriptors=Object.getOwnPropertyDescriptors(raw);
    for(const key of Object.keys(descriptors).sort()){
      if(!Object.hasOwn(descriptors[key],'value'))fail('input graph is not data-only');seed(descriptors[key].value);
    }
  }initialValues.forEach(seed);
  const add=(site,kind,fields)=>{if(rows.length>=32768)fail('observation bound');rows.push({site,kind,...fields});};
  function read(site,operation,receiver,key){
    add(site,'read',{operation,receiver:value(receiver)});
    try{const result=apply(lookup,undefined,[receiver,key]);add(site,'read.return',{operation,value:value(result)});return result;}
    catch(error){add(site,'read.throw',{operation,value:value(error)});throw error;}
  }
  function call(site,operation,callee,receiver,args){
    add(site,'call',{operation,method:value(callee),receiver:value(receiver),arguments:args.map(value)});
    try{const result=invoke({callee,receiver,arguments:args});add(site,'call.return',{operation,value:value(result)});return result;}
    catch(error){add(site,'call.throw',{operation,value:value(error)});throw error;}
  }
  function iterable(site,source){
    if(Array.isArray(source)&&[arrayPrototype,Array.prototype].includes(Object.getPrototypeOf(source))&&
      !Object.hasOwn(source,Symbol.iterator))return source;
    add(site,'begin',{receiver:value(source)});
    return {[Symbol.iterator](){
      const method=read(site,'iterator',source,Symbol.iterator),iterator=call(site,'iterator',method,source,[]);
      if(!reference(iterator))return iterator;
      const next=read(site,'next',iterator,'next');
      return {next(...args){
        const result=call(site,'next',next,iterator,args);if(!reference(result))return result;
        return {get done(){return read(site,'done',result,'done');},get value(){return read(site,'value',result,'value');}};
      },get return(){
        const method=read(site,'return',iterator,'return');if(typeof method!=='function')return method;
        return (...args)=>call(site,'return',method,iterator,args);
      }};
    }};
  }
  return {id:CUSTOM_ITERATOR_OBSERVATION_PROFILE_V8,globals:{[hook]:iterable},setCallObserver(observer){invoke=observer;},
    initializeRealm(evaluate){const captured=evaluate('({arrayPrototype:Array.prototype,lookup:(receiver,key)=>receiver[key]})');
      lookup=captured.lookup;arrayPrototype=captured.arrayPrototype;},
    instrument(text){
      const current=loops(text);if(current.length!==nodes.length)fail('source loop inventory changed');
      const edits=current.flatMap((node,index)=>[{start:node.right.start,text:hook+'('+JSON.stringify(nodes[index].start+':'+nodes[index].end)+',('},
        {start:node.right.end,text:'))'}]).sort((a,b)=>b.start-a.start);
      for(const edit of edits)text=text.slice(0,edit.start)+edit.text+text.slice(edit.start);return text;
    },observations(){if(failures.length)fail(failures[0]);return rows;}
  };
}
