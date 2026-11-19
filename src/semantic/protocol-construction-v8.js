// Explicit class/private operations on the shared public heap. No owned VM
// archive, bytecode, event patch or host execution is an input to this module.
import {assertAlgorithmFields,assertAlgorithmDataArray} from './ir.js';

export const CONSTRUCTION_STATE_V8_SCHEMA='semantic-construction-state/1';
export const CONSTRUCTION_RECORD_FIELDS=Object.freeze(Object.fromEntries(Object.entries({
  'callable.define':['kind','object','constructorKind','classConstructor'],
  'callable.home':['kind','object','home'],
  'class.link':['kind','object','prototype','heritage'],
  'class.initializer':['kind','object','placement','initializer'],
  'private.declare':['kind','id','owner','name'],
  'private.define':['kind','object','privateId','elementKind','value'],
  'private.get':['kind','object','privateId','result'],
  'private.set':['kind','object','privateId','value'],
  'private.has':['kind','object','privateId','result']
}).map(([kind,fields])=>[kind,Object.freeze(fields)])));
export const CONSTRUCTION_STATE_V8_FIELDS=Object.freeze(['schema','privateNames','frames','lastCompletion']);
export const CALLABLE_STATE_V8_FIELDS=Object.freeze(['constructorKind','classConstructor','homeObject','instanceInitializer','staticInitializer']);
const id=value=>{if(typeof value!=='string'||!value||value.length>256)throw new TypeError('Construction identity must be a bounded string');};
const ref=(value,validate)=>{validate(value);if(value[0]!=='ref')throw new TypeError('Construction requires an owned reference');};
export function validateConstructionRecordV8(record,{value:validateValue}){
  const fields=CONSTRUCTION_RECORD_FIELDS[record?.kind];if(!fields)return false;
  assertAlgorithmFields(record,fields,'construction protocol record');
  for(const field of ['object','id','owner','privateId'])if(Object.hasOwn(record,field))id(record[field]);
  if(record.kind==='callable.define'){
    if(![null,'base','derived'].includes(record.constructorKind)||typeof record.classConstructor!=='boolean'||
       record.classConstructor&&record.constructorKind===null||!record.classConstructor&&record.constructorKind==='derived')
      throw new TypeError('Invalid callable construction capability');
  }else if(record.kind==='callable.home')ref(record.home,validateValue);
  else if(record.kind==='class.link'){
    ref(record.prototype,validateValue);validateValue(record.heritage);
    if(!['ref','null','undefined'].includes(record.heritage[0]))throw new TypeError('Invalid class heritage');
  }else if(record.kind==='class.initializer'){
    if(!['instance','static'].includes(record.placement))throw new TypeError('Invalid class initializer placement');
    ref(record.initializer,validateValue);
  }else if(record.kind==='private.declare'){
    if(typeof record.name!=='string'||!record.name||record.name.length>256)throw new TypeError('Invalid private source name');
  }else if(record.kind==='private.define'){
    if(!['field','method'].includes(record.elementKind))throw new TypeError('Invalid private element kind');validateValue(record.value);
    if(record.elementKind==='method')ref(record.value,validateValue);
  }else if(record.kind==='private.has'){
    if(typeof record.result!=='boolean')throw new TypeError('Invalid private brand test');
  }else validateValue(record.kind==='private.get'?record.result:record.value);
  return true;
}
export function createConstructionStateV8(){return {schema:CONSTRUCTION_STATE_V8_SCHEMA,privateNames:[],frames:[],lastCompletion:null};}
function state(controller,api){return api.state(controller).construction??=createConstructionStateV8();}
function callable(controller,object,api){const node=api.heapNode(controller,object);api.require(node.kind==='closure','callable construction metadata requires a closure');return node;}
function metadata(controller,object,api){const node=callable(controller,object,api);api.require(node.callable,'callable capability must be declared');return node.callable;}
function privateName(controller,id,api){const name=state(controller,api).privateNames.find(row=>row.id===id);api.require(name,'undeclared private identity');return name;}
function descriptor(value,attributes={}){return {kind:'data',value,writable:true,enumerable:false,configurable:true,...attributes};}

/** Called only inside the shared machine's transactional staging boundary. */
export function applyConstructionRecordV8(controller,record,api){
  if(!CONSTRUCTION_RECORD_FIELDS[record.kind])return false;
  const {require,copy,eq,known,heapNode,ownDescriptor,installDescriptor}=api,construction=state(controller,api);
  if(record.kind==='private.declare'){
    api.fresh(controller,record.id);require(!construction.privateNames.some(row=>row.id===record.id),'duplicate private identity');
    const owner=metadata(controller,record.owner,api);require(owner.classConstructor,'private identity owner must be a class');
    require(!construction.privateNames.some(row=>row.owner===record.owner&&row.name===record.name),'duplicate class private name');
    require(construction.privateNames.length<4096,'private identity bound');
    construction.privateNames.push({id:record.id,owner:record.owner,name:record.name});return true;
  }
  const node=heapNode(controller,record.object);
  if(record.kind==='callable.define'){
    callable(controller,record.object,api);require(!node.callable,'callable capability already declared');
    require(node.functionKind!=='arrow'||record.constructorKind===null&&!record.classConstructor,'arrow cannot be a constructor');
    node.callable={constructorKind:record.constructorKind,classConstructor:record.classConstructor,
      homeObject:null,instanceInitializer:null,staticInitializer:null};
  }else if(record.kind==='callable.home'){
    const info=metadata(controller,record.object,api);known(controller,record.home);heapNode(controller,record.home[1]);
    require(node.functionKind!=='arrow'&&info.constructorKind===null&&info.homeObject===null,'home object is immutable and belongs to a nonconstructible method');
    info.homeObject=copy(record.home);
  }else if(record.kind==='class.link'){
    const info=metadata(controller,record.object,api),prototype=heapNode(controller,record.prototype[1]);
    require(info.classConstructor&&info.homeObject===null,'class prototype already linked or constructor is not a class');
    require(prototype.kind==='object','class prototype must be an ordinary object');
    require(record.object!==record.prototype[1],'constructor and instance prototype must differ');
    let instanceParent='ordinary',constructorParent='ordinary';
    if(info.constructorKind==='base')require(record.heritage[0]==='undefined','base class cannot have heritage');
    else{
      require(record.heritage[0]!=='undefined','derived class requires heritage');
      if(record.heritage[0]==='null')instanceParent=null;
      else{
        known(controller,record.heritage);const parent=metadata(controller,record.heritage[1],api);
        require(parent.constructorKind!==null,'class heritage is not constructible');
        const inherited=ownDescriptor(heapNode(controller,record.heritage[1]),['str','prototype']);
        require(inherited?.kind==='data','heritage prototype requires an owned data property');
        known(controller,inherited.value);require(['null','ref'].includes(inherited.value[0]),'heritage prototype must be an object or null');
        if(inherited.value[0]==='ref')heapNode(controller,inherited.value[1]);
        instanceParent=inherited.value[0]==='null'?null:copy(inherited.value);constructorParent=copy(record.heritage);
      }
    }
    const existing=ownDescriptor(node,['str','prototype']),backref=ownDescriptor(prototype,['str','constructor']);
    require(!existing||existing.kind==='data'&&eq(existing.value,record.prototype),'class prototype identity changed');
    require(!backref||backref.kind==='data'&&eq(backref.value,['ref',record.object]),'class constructor backlink changed');
    node.prototype=constructorParent;prototype.prototype=instanceParent;info.homeObject=copy(record.prototype);
    installDescriptor(node,['str','prototype'],descriptor(copy(record.prototype),{writable:false,configurable:false}));
    installDescriptor(prototype,['str','constructor'],descriptor(['ref',record.object]));
  }else if(record.kind==='class.initializer'){
    const info=metadata(controller,record.object,api);known(controller,record.initializer);
    const init=metadata(controller,record.initializer[1],api),field=record.placement+'Initializer';
    require(info.classConstructor&&info.homeObject!==null&&info[field]===null,'class initializer already declared or class unlinked');
    require(init.constructorKind===null&&!init.classConstructor,'initializer must be a nonconstructible owned function');
    require(eq(init.homeObject,record.placement==='static'?['ref',record.object]:info.homeObject),'initializer has wrong home object');
    info[field]=copy(record.initializer);
  }else{
    privateName(controller,record.privateId,api);
    const element=node.privateElements?.get(record.privateId);
    if(record.kind==='private.define'){
      require(!element,'private element is already installed');known(controller,record.value);
      if(record.elementKind==='method'){
        const method=callable(controller,record.value[1],api);require(method.callable?.constructorKind===null,'private method cannot be constructible');
      }
      (node.privateElements??=new Map()).set(record.privateId,{kind:record.elementKind,value:copy(record.value),version:1});
    }else if(record.kind==='private.has')require(record.result===!!element,'false private brand claim');
    else{
      require(element,'private element brand is absent');
      if(record.kind==='private.get'){known(controller,record.result);require(eq(record.result,element.value),'false private read');}
      else{
        require(element.kind==='field','private method is readonly');known(controller,record.value);
        element.value=copy(record.value);element.version++;
      }
    }
  }
  return true;
}

/** Additional state is validated separately from ordinary descriptors. */
export function restoreConstructionStateV8(controller,snapshot,api){
  assertAlgorithmFields(snapshot,CONSTRUCTION_STATE_V8_FIELDS,'construction protocol state');
  api.require(snapshot.schema===CONSTRUCTION_STATE_V8_SCHEMA,'construction state schema');
  assertAlgorithmDataArray(snapshot.privateNames,'private identities');assertAlgorithmDataArray(snapshot.frames,'construction frames');
  api.require(snapshot.privateNames.length<=4096&&!snapshot.frames.length&&snapshot.lastCompletion===null,'construction state bound or unsupported active continuation');
  const declared=new Map(),names=new Set();
  for(const row of snapshot.privateNames){
    assertAlgorithmFields(row,['id','owner','name'],'private identity');id(row.id);id(row.owner);id(row.name);
    api.require(!declared.has(row.id)&&!names.has(row.owner+'\0'+row.name),'duplicate private identity or class name');
    api.require(!controller.heap.has(row.id)&&!api.state(controller).symbols.some(symbol=>symbol.id===row.id),'private identity collides with an object or Symbol');
    api.require(metadata(controller,row.owner,api).classConstructor,'private owner is not a class');
    declared.set(row.id,row);names.add(row.owner+'\0'+row.name);
  }
  for(const [object,node] of controller.heap){
    if(node.callable){
      callable(controller,object,api);const info=node.callable;assertAlgorithmFields(info,CALLABLE_STATE_V8_FIELDS,'callable state');
      validateConstructionRecordV8({kind:'callable.define',object,constructorKind:info.constructorKind,classConstructor:info.classConstructor},{value:api.known.bind(null,controller)});
      api.require(node.functionKind!=='arrow'||info.constructorKind===null&&!info.classConstructor,'invalid arrow capability');
      if(info.homeObject!==null){api.known(controller,info.homeObject);api.require(info.homeObject[0]==='ref','home object reference');api.heapNode(controller,info.homeObject[1]);}
      for(const placement of ['instance','static'])if(info[placement+'Initializer']!==null){
        const initializer=info[placement+'Initializer'];api.known(controller,initializer);api.require(initializer[0]==='ref','initializer reference');
        const init=metadata(controller,initializer[1],api);
        api.require(info.classConstructor&&init.constructorKind===null&&!init.classConstructor&&
          api.eq(init.homeObject,placement==='static'?['ref',object]:info.homeObject),'invalid initializer ownership');
      }
    }
    if(node.privateElements!==undefined){
      api.require(node.privateElements instanceof Map,'private elements must be a map');
      for(const [name,element] of node.privateElements){
        api.require(declared.has(name),'private storage has an undeclared identity');
        assertAlgorithmFields(element,['kind','value','version'],'private element');
        api.require(['field','method'].includes(element.kind)&&Number.isSafeInteger(element.version)&&element.version>=1,'invalid private element kind/version');
        api.known(controller,element.value);
        if(element.kind==='method')api.require(element.value[0]==='ref'&&element.version===1&&metadata(controller,element.value[1],api).constructorKind===null,'invalid private method storage');
      }
    }
  }
  return {valid:true,privateNames:declared.size};
}
export function constructionReservedIdentitiesV8(controller){return (controller.protocol?.construction?.privateNames??[]).map(row=>row.id);}
export function hasConstructionStateV8(node){return node.callable!==undefined||node.privateElements!==undefined;}
export function describeConstructionObjectV8(node){return {
  ...(node.callable?{callable:structuredClone(node.callable)}:{}),
  ...(node.privateElements?{privateElements:[...node.privateElements].map(([id,element])=>({id,...structuredClone(element)}))}:{})
};}
