// Replay-backed, data-only retained module session. Each committed call
// reconstructs a deterministic owned episode from its full call history.
// No external service is permitted: replaying one cannot duplicate an effect.
// The public object graph retains stable owned identities across invocations.
// This is observational retention, not a durable suspended VM continuation.
import {types} from 'node:util';
import {decode} from './values.js';
import {executeEvaluatedModules} from './evaluated-modules.js';

const scalar=value=>value===null||
  ['undefined','string','boolean','number','bigint'].includes(typeof value);
function checkArgs(args){
  if(!Array.isArray(args)||types.isProxy(args)||args.length>64||
     Object.getPrototypeOf(args)!==Array.prototype)
    throw new TypeError('Retained module calls accept at most 64 primitive arguments');
  const snapshot=[];
  for(let i=0;i<args.length;i++){
    const descriptor=Object.getOwnPropertyDescriptor(args,String(i));
    if(!descriptor||!Object.hasOwn(descriptor,'value')||!scalar(descriptor.value))
      throw new TypeError('Retained module arguments must be dense own primitive data');
    snapshot.push(descriptor.value);
  }
  if(Reflect.ownKeys(args).length!==args.length+1)
    throw new TypeError('Unexpected retained argument array property');
  return snapshot;
}
function snapshotResults(heap,results,existing,initialHeap){
  if(results?.[0]!=='ref')throw new TypeError('Retained result must be an owned array');
  const outer=heap[results[1]];
  if(outer?.kind!=='array')throw new TypeError('Malformed retained result array');
  const length=decode(outer.properties.length.value);
  if(!Number.isSafeInteger(length)||length<1||length>32)
    throw new RangeError('Invalid retained result history');
  // The entry input data graph grows with each call, so the raw oN IDs
  // of module-created objects shift. Normalize to the allocation ordinal
  // *after* entry initialization; deterministic bytecode execution gives
  // the same module object the same ordinal on every prefix replay.
  const initialObjects=Object.keys(initialHeap).length;
  const keyFor=id=>{
    if(!/^o[1-9][0-9]*$/.test(id))throw new TypeError('Invalid owned object identity');
    const ordinal=Number(id.slice(1))-initialObjects;
    if(ordinal<=0)throw new TypeError('Retained result references entry call arguments');
    return 'module-object:'+ordinal;
  };
  const objects=new Map(existing),pending=new Map();
  function visit(value){
    if(value[0]!=='ref')return decode(value);
    const id=value[1],identity=keyFor(id),entity=heap[id];
    if(!entity||!['array','object'].includes(entity.kind)||
       Object.keys(entity.accessors??{}).length||
       entity.prototype!==undefined&&entity.prototype!==null&&
         !['Object.prototype','Array.prototype'].includes(entity.prototype))
      throw new TypeError('Retained result includes an unowned exotic identity');
    const array=entity.kind==='array';
    let target=objects.get(identity);
    if(target!==undefined && Array.isArray(target)!==array)
      throw new TypeError('Retained identity changed kind');
    if(target===undefined){
      target=array?[]:entity.prototype===null?Object.create(null):{};
      objects.set(identity,target);
    }
    if(!pending.has(identity)){
      const values=new Map();
      const length=array?decode(entity.properties.length?.value):null;
      if(array&&(!Number.isSafeInteger(length)||length<0||length>4096))
        throw new RangeError('Retained result array limit');
      pending.set(identity,{target,array,length,values});
      for(const [name,record] of Object.entries(entity.properties)){
        if(array&&name==='length')continue;
        if(name==='__proto__'||!record||!Array.isArray(record.value))
          throw new TypeError('Unmodeled retained result property');
        values.set(name,visit(record.value));
      }
    }
    return target;
  }
  const out=[];
  for(let i=0;i<length;i++){
    const field=outer.properties[String(i)];
    if(!field)throw new TypeError('Sparse retained results not supported');
    out.push(visit(field.value));
  }
  // Stage first, and validate the entire retained output graph. No host
  // mutation may happen while a later traversal can still fail closed.
  for(const {target,array} of pending.values()){
    if(types.isProxy(target)||!Object.isExtensible(target)||
       Object.getPrototypeOf(target)!==(array?Array.prototype:
         Object.getPrototypeOf(target)===null?null:Object.prototype))
      throw new TypeError('Retained host output was modified incompatibly');
    for(const key of Reflect.ownKeys(target)){
      const desc=Object.getOwnPropertyDescriptor(target,key);
      if(typeof key!=='string'||!desc||!Object.hasOwn(desc,'value')||
         key!=='length'&&(!desc.configurable||!desc.writable))
        throw new TypeError('Retained host output has unowned descriptors');
    }
  }
  const commit=()=>{
    for(const {target,array,length,values} of pending.values()){
      for(const key of Reflect.ownKeys(target)){
        if(array&&key==='length')continue;
        if(!values.has(key))delete target[key];
      }
      if(array)target.length=length;
      for(const [key,value] of values)
        Object.defineProperty(target,key,{value,configurable:true,
          enumerable:true,writable:true});
    }
  };
  return {objects,values:out,commit};
}

export class BoundedRetainedModuleSession {
  constructor({modules,entryModule,maxSteps=100000}={}){
    if(!modules||typeof modules!=='object'||typeof entryModule!=='string')
      throw new TypeError('Retained module source graph and entryModule required');
    this.modules=modules;
    this.entryModule=entryModule;
    this.maxSteps=maxSteps;
    this.history=[];
    this.outputs=[];
    this.objects=new Map();
    this.closed=false;
    this.lastArchive=null;
    this.queue=Promise.resolve();
  }
  async invoke(exportName,args=[]){
    if(this.closed)throw new Error('Retained module session closed');
    const checked=checkArgs(args);
    if(typeof exportName!=='string'||!/^[$A-Za-z_][$\w]*$/.test(exportName))
      throw new TypeError('Invalid retained module export name');
    const task=async()=>{
      if(this.closed)throw new Error('Retained module session closed');
      if(this.history.length>=32)throw new RangeError('Retained session call limit');
      const calls=[...this.history,{exportName,args:checked}];
      const run=await executeEvaluatedModules({
        modules:this.modules,entryModule:this.entryModule,
        calls,maxSteps:this.maxSteps
      });
      const initial=run.bundle.initialState.control.a0.activeFrameId;
      const promiseId=run.bundle.initialState.frames[initial].asyncPromiseId;
      const result=run.bundle.finalState.promises[promiseId].value.value;
      const staged=snapshotResults(run.bundle.finalState.heap,result,this.objects,run.bundle.initialState.heap);
      for(let i=0;i<this.outputs.length;i++){
        const former=this.outputs[i],next=staged.values[i];
        if((former===null||typeof former!=='object')?
           !Object.is(former,next):former!==next)
          throw new Error('Retained historical result changed identity or primitive value');
      }
      if(this.closed)throw new Error('Retained module session closed');
      staged.commit();
      this.objects=staged.objects;
      this.outputs=staged.values;
      this.history=calls;
      this.lastArchive=run.bundle;
      return {result:staged.values.at(-1),bundle:run.bundle,metadata:run.metadata};
    };
    const result=this.queue.then(task);
    this.queue=result.then(()=>undefined,()=>undefined);
    return result;
  }
  close(){this.closed=true;this.objects.clear();}
}
export function createBoundedRetainedModuleSession(options){
  return new BoundedRetainedModuleSession(options);
}
