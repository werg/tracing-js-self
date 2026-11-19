// Independent class metadata evidence. Native private readers are inserted in
// the declaring lexical class scope, never exposed as public object properties.
// No owned execution, source projector or public protocol evaluator is imported.
import {parse} from 'acorn';
import {types} from 'node:util';
import {constructionSourceInventoryV8} from './protocol-construction-source-inventory-v8.js';

export const CONSTRUCTION_OBSERVATION_PROFILE_V8='class-private-metadata/1';
const registerName='__tracingProtocolConstructionRegister';
const fail=message=>{throw new TypeError('Construction metadata observation: '+message);};
const ref=id=>['ref',id];
const sourceClasses=source=>constructionSourceInventoryV8(source).classes;
function instructionFor(bundle,event){
  const patch=event.stateChanges.find(change=>change.table==='frames'&&change.id===event.invocationId);
  return bundle.programs[event.codeId]?.instructions[patch?.before?.pc];
}
function ownedInventory(bundle,classes){
  const classByStart=new Map(classes.map(item=>[item.node.start,item])),classByMethod=new Map(),classByCode=new Map();
  for(const item of classes)if(item.constructor)classByMethod.set(item.constructor.value.start,item);
  for(const program of Object.values(bundle.programs))for(const instruction of program.instructions){
    const code=instruction.arg?.codeId;
    if(instruction.op==='MAKE_FUNCTION'&&bundle.programs[code]?.instructions.some(row=>row.op==='CLASS_CONSTRUCTOR_GUARD')){
      const item=classByMethod.get(instruction.start)??classByStart.get(instruction.start);
      if(!item)fail('class constructor has no independent source definition');classByCode.set(code,item);
    }
  }
  const registered=[];
  for(const event of bundle.events)if(instructionFor(bundle,event)?.op==='CLASS_FINISH'){
    const value=event.operands[0],node=value?.[0]==='ref'?bundle.finalState.heap[value[1]]:null,
      item=node&&classByCode.get(node.codeId);
    if(!item||registered.some(row=>row.id===value[1]))fail('class registration identity');
    registered.push({id:value[1],item});
  }
  return {registered,classByCode};
}

export function createConstructionObservationAdapterV8({source,side='native',bundle=null}={}){
  const classes=sourceClasses(source);if(!classes.length)return null;
  for(const item of classes)for(const entry of item.privateNames)
    if(!['field','method'].includes(entry.kind))fail('private accessor metadata requires an accessor protocol');
  const inferredNames=new Map();
  function infer(node){
    if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(infer);return;}
    if(node.type==='VariableDeclarator'&&node.id.type==='Identifier'&&node.init?.type==='ClassExpression'&&!node.init.id)
      inferredNames.set(node.init.start,node.id.name);
    for(const [key,child]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))infer(child);
  }
  infer(parse(source,{ecmaVersion:'latest',sourceType:'script'}));
  const classByStart=new Map(classes.map(item=>[item.node.start,item])),nativeClasses=[],nativeClass=new WeakMap(),nativeHome=new WeakMap(),
    owned=side==='owned'?ownedInventory(bundle,classes):null;
  function register(constructor,start,readers){
    if(typeof constructor!=='function'||types.isProxy(constructor)||nativeClass.has(constructor))fail('invalid native class registration');
    const item=classByStart.get(start),prototype=Object.getOwnPropertyDescriptor(constructor,'prototype')?.value;
    if(!item||prototype===null||typeof prototype!=='object'||types.isProxy(prototype)||
      !Array.isArray(readers)||readers.length!==item.privateNames.length)fail('native class registration shape');
    for(const reader of readers)if(!reader||typeof reader.has!=='function'||typeof reader.get!=='function'||
      types.isProxy(reader.has)||types.isProxy(reader.get))fail('private reader registration shape');
    const row={constructor,prototype,item,readers};nativeClasses.push(row);nativeClass.set(constructor,row);nativeHome.set(constructor,prototype);
    // These descriptors are inspected before original static initialization.
    // They identify methods created in this exact class lexical environment.
    for(const home of [prototype,constructor])for(const key of Reflect.ownKeys(home)){
      if(home===prototype&&key==='constructor')continue;
      const d=Object.getOwnPropertyDescriptor(home,key);
      for(const fn of [d.value,d.get,d.set])if(typeof fn==='function'&&!types.isProxy(fn))nativeHome.set(fn,home);
    }
  }
  function instrument(text){
    const current=sourceClasses(text);
    if(current.length!==classes.length)fail('completion instrumentation changed the class inventory');
    const insertions=current.flatMap(({node},index)=>{
      const item=classes[index],readers=item.privateNames.map(entry=>
        '{has:(o)=>#'+entry.name+' in o,get:(o)=>o.#'+entry.name+'}').join(',');
      const result=[{at:node.body.start+1,text:'static{'+registerName+'(this,'+item.node.start+',['+readers+']);}'}];
      // A completion hook around a declarator initializer would otherwise
      // suppress NamedEvaluation. A computed own data property preserves the
      // original inferred name before static initialization, including the
      // special spelling "__proto__", without mutating native metadata later.
      const name=inferredNames.get(item.node.start);
      if(name!==undefined){const key=JSON.stringify(name);
        result.push({at:node.start,text:'({['+key+']:'},{at:node.end,text:'})['+key+']'});}
      return result;
    }).sort((a,b)=>b.at-a.at);
    for(const insertion of insertions)text=text.slice(0,insertion.at)+insertion.text+text.slice(insertion.at);
    return text;
  }
  function nativeNode(value,ctx){
    if(types.isProxy(value))ctx.fail('Proxy metadata is outside the construction profile');
    const annotations=[],owner=nativeClass.get(value),home=nativeHome.get(value);
    if(owner)annotations.push({name:'class/1',values:[],data:{sourceStart:owner.item.node.start,derived:!!owner.item.node.superClass}});
    if(home)annotations.push({name:'home-object/1',values:[home],data:{}});
    for(const row of nativeClasses)for(let index=0;index<row.item.privateNames.length;index++){
      const entry=row.item.privateNames[index],reader=row.readers[index];
      // Only generated lexical brand/read functions are called; private
      // accessors and Proxy receivers were refused before this point.
      if(!reader.has(value))continue;
      const privateValue=reader.get(value);
      if(entry.kind==='method'&&typeof privateValue==='function')nativeHome.set(privateValue,entry.static?row.constructor:row.prototype);
      annotations.push({name:'private-element/1',values:[row.constructor,privateValue],
        data:{name:entry.name,kind:entry.kind,static:entry.static}});
    }
    if(!annotations.length&&typeof value==='function')return null;
    return {...ctx.defaultNode(value,{includeFunctions:true}),annotations};
  }
  function ownedNode(value,ctx){
    if(value[0]!=='ref')return null;
    const node=ctx.state.heap[value[1]];if(!node||!['function','object','array'].includes(node.kind))return null;
    const annotations=[];
    if(node.classConstructor){
      const item=owned.classByCode.get(node.codeId);if(!item)ctx.fail('owned class has no independent source definition');
      annotations.push({name:'class/1',values:[],data:{sourceStart:item.node.start,derived:node.derivedConstructor===true}});
    }
    if(node.homeObject)annotations.push({name:'home-object/1',values:[node.homeObject],data:{}});
    const accounted=new Set();
    for(const row of owned.registered)for(let index=0;index<row.item.privateNames.length;index++){
      const entry=row.item.privateNames[index],key='private:'+row.id+':'+index;
      if(!Object.hasOwn(node.privateSlots??{},key))continue;
      if(node.privateKinds?.[key]!==entry.kind)ctx.fail('private element kind differs from its declaring source');
      accounted.add(key);annotations.push({name:'private-element/1',values:[ref(row.id),node.privateSlots[key].value],
        data:{name:entry.name,kind:node.privateKinds[key],static:entry.static}});
    }
    if(Object.keys(node.privateSlots??{}).some(key=>!accounted.has(key)))ctx.fail('unregistered private element identity');
    if(!annotations.length&&node.kind==='function')return null;
    return {...ctx.defaultNode(value,{includeFunctions:true}),annotations};
  }
  // Reject direct use of the reserved observer namespace even when this
  // observer is exercised separately from the source compiler's syntax guard.
  function reserved(node){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){node.forEach(reserved);return;}
    if(node.type==='Identifier'&&node.name.startsWith('__tracingProtocol'))fail('reserved observer name in source');
    for(const [key,child]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))reserved(child);
  }
  reserved(parse(source,{ecmaVersion:'latest',sourceType:'script'}));
  return {id:CONSTRUCTION_OBSERVATION_PROFILE_V8,instrument,globals:{[registerName]:register},
    metadataAdapter:side==='owned'?{ownedNode}:{nativeNode}};
}
