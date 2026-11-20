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
  'private.has':['kind','object','privateId','result'],
  'construct.enter':['kind','id','child','callee','newTarget','arguments','receiver','mode','owner'],
  'construct.body':['kind','id','child'],
  'construct.finish':['kind','id','completion'],
  'construct.target':['kind','invocation','result'],
  'construct.this':['kind','invocation','result'],
  'super.select':['kind','owner','callee'],
  'super.bind':['kind','owner','receiver','child'],
  'super.finish':['kind','owner','completion']
}).map(([kind,fields])=>[kind,Object.freeze(fields)])));
export const CONSTRUCTION_STATE_V8_FIELDS=Object.freeze(['schema','privateNames','frames','lastCompletion']);
export const CALLABLE_STATE_V8_FIELDS=Object.freeze(['constructorKind','classConstructor','homeObject','instanceInitializer','staticInitializer']);
export const CONSTRUCTION_FRAME_V8_FIELDS=Object.freeze(['id','parent','bodyInvocation','activeChild','callee','newTarget','arguments','receiver','initialized','phase','superParent','selectedSuper']);
const id=value=>{if(typeof value!=='string'||!value||value.length>256)throw new TypeError('Construction identity must be a bounded string');};
const ref=(value,validate)=>{validate(value);if(value[0]!=='ref')throw new TypeError('Construction requires an owned reference');};
export function validateConstructionRecordV8(record,{value:validateValue}){
  const fields=CONSTRUCTION_RECORD_FIELDS[record?.kind];if(!fields)return false;
  assertAlgorithmFields(record,fields,'construction protocol record');
  for(const field of ['object','id','owner','privateId','child','invocation'])if(Object.hasOwn(record,field)&&record[field]!==null)id(record[field]);
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
  }else if(record.kind==='construct.enter'){
    ref(record.callee,validateValue);ref(record.newTarget,validateValue);validateValue(record.receiver);
    if(!['ref','undefined'].includes(record.receiver[0])||!['ordinary','super'].includes(record.mode)||
       (record.mode==='super')!==(record.owner!==null))throw new TypeError('Invalid constructor entry linkage');
    assertAlgorithmDataArray(record.arguments,'constructor arguments');if(record.arguments.length>4096)throw new TypeError('Constructor argument bound');record.arguments.forEach(validateValue);
  }else if(record.kind==='construct.finish'||record.kind==='super.finish'){
    assertAlgorithmFields(record.completion,['kind','value'],'constructor completion');
    if(!['normal','throw'].includes(record.completion.kind))throw new TypeError('Constructor completion kind');validateValue(record.completion.value);
  }else if(record.kind==='super.select')validateValue(record.callee);
  else if(record.kind==='super.bind')ref(record.receiver,validateValue);
  else if(record.kind!=='construct.body')validateValue(record.kind==='private.set'?record.value:record.result);
  return true;
}
export function createConstructionStateV8(){return {schema:CONSTRUCTION_STATE_V8_SCHEMA,privateNames:[],frames:[],lastCompletion:null};}
function state(controller,api){return api.state(controller).construction??=createConstructionStateV8();}
function callable(controller,object,api){const node=api.heapNode(controller,object);api.require(node.kind==='closure','callable construction metadata requires a closure');return node;}
function metadata(controller,object,api){const node=callable(controller,object,api);api.require(node.callable,'callable capability must be declared');return node.callable;}
function privateName(controller,id,api){const name=state(controller,api).privateNames.find(row=>row.id===id);api.require(name,'undeclared private identity');return name;}
function descriptor(value,attributes={}){return {kind:'data',value,writable:true,enumerable:false,configurable:true,...attributes};}
function frame(controller,id,api){const entry=state(controller,api).frames.find(row=>row.id===id);api.require(entry,'unknown construction continuation');return entry;}
function invokeConstructorBody(controller,entry,child,api){
  api.call(controller,{child,callee:entry.callee,receiver:entry.receiver,arguments:entry.arguments},{construction:true});
  entry.phase='body';entry.activeChild=child;entry.bodyInvocation=child;
}
function returnedToParent(controller,entry,api){
  api.require(controller.stack.at(-1)===entry.parent&&!controller.stack.includes(entry.activeChild)&&controller.lastReturn,
    'constructor continuation has not returned to its caller');
  return controller.lastReturn;
}

/** Prevent ordinary records from bypassing a pending constructor continuation. */
export function assertConstructionNextV8(controller,record,api){
  const construction=controller.protocol?.construction;if(!construction)return true;
  const pending=construction.frames.findLast(row=>row.phase!=='complete'&&!controller.stack.includes(row.activeChild));
  if(pending){
    const expected=pending.phase==='initialize-base'&&controller.lastReturn?.kind!=='throw'?'construct.body':pending.phase==='initialize-derived'?'super.finish':'construct.finish';
    api.require(record.kind===expected&&(record.id??record.owner)===pending.id,'pending constructor continuation requires '+expected);
  }
  const completed=construction.lastCompletion;
  if(completed?.superParent!==null&&completed?.completion.kind==='normal')
    api.require(record.kind==='super.bind'&&record.owner===completed.superParent,'super result must bind its derived receiver');
  return true;
}
export function assertConstructionCallV8(controller,callee,{construction=false}={},api){
  const info=api.heapNode(controller,callee[1]).callable;
  api.require(!info?.classConstructor||construction,'class constructor cannot be called without construction');
  return true;
}

function applyContinuation(controller,record,api){
  const {require,copy,eq,known,heapNode,ownDescriptor}=api,construction=state(controller,api);
  if(record.kind==='construct.enter'){
    known(controller,record.callee);known(controller,record.newTarget);record.arguments.forEach(value=>known(controller,value));
    const info=metadata(controller,record.callee[1],api),target=metadata(controller,record.newTarget[1],api);
    require(info.constructorKind!==null&&target.constructorKind!==null,'construction requires constructible targets');
    require(construction.frames.length<4096&&!construction.frames.some(row=>row.id===record.id),'construction identity or frame bound');
    const parent=controller.stack.at(-1);require(parent,'construction requires an active caller');
    if(record.mode==='super'){
      const owner=frame(controller,record.owner,api);
      require(owner.phase==='body'&&owner.bodyInvocation===parent&&metadata(controller,owner.callee[1],api).constructorKind==='derived',
        'super call has no active derived owner');
      require(eq(owner.selectedSuper,record.callee)&&eq(owner.newTarget,record.newTarget),'super constructor or newTarget changed after selection');
      owner.selectedSuper=null;
    }
    const derived=info.constructorKind==='derived';
    if(derived)require(record.receiver[0]==='undefined','derived this must begin uninitialized');
    else{
      require(record.receiver[0]==='ref','base constructor requires a fresh receiver identity');api.fresh(controller,record.receiver[1]);
      const prototype=ownDescriptor(heapNode(controller,record.newTarget[1]),['str','prototype']);
      require(!prototype||prototype.kind==='data','newTarget prototype accessor requires its own continuation');
      let parent='ordinary';if(prototype?.value[0]==='ref'){
        known(controller,prototype.value);require(['object','array'].includes(heapNode(controller,prototype.value[1]).kind),'unsupported exotic constructor prototype');parent=copy(prototype.value);
      }
      api.allocate(controller,{name:record.receiver[1],objectKind:'object',length:null,properties:[],code:null,captures:[],functionKind:null,lexicalReceiver:null});
      heapNode(controller,record.receiver[1]).prototype=parent;
    }
    const entry={id:record.id,parent,bodyInvocation:null,activeChild:record.child,callee:copy(record.callee),newTarget:copy(record.newTarget),
      arguments:copy(record.arguments),receiver:copy(record.receiver),initialized:!derived,phase:'body',superParent:record.owner,selectedSuper:null};
    construction.frames.push(entry);construction.lastCompletion=null;
    if(!derived&&info.instanceInitializer){
      entry.phase='initialize-base';api.call(controller,{child:record.child,callee:info.instanceInitializer,receiver:entry.receiver,arguments:[]});
    }else invokeConstructorBody(controller,entry,record.child,api);
  }else if(record.kind==='construct.body'){
    const entry=frame(controller,record.id,api),returned=returnedToParent(controller,entry,api);
    require(entry.phase==='initialize-base'&&returned.kind==='return','base initializer must return before body entry');
    invokeConstructorBody(controller,entry,record.child,api);
  }else if(record.kind==='construct.finish'){
    const entry=frame(controller,record.id,api),returned=returnedToParent(controller,entry,api);
    require(entry.phase==='body'||entry.phase==='initialize-base'&&returned.kind==='throw',
      'constructor body or abrupt base initializer is not complete');known(controller,record.completion.value);
    let expected;
    if(returned.kind==='throw')expected={kind:'throw',value:returned.value};
    else{
      const kind=metadata(controller,entry.callee[1],api).constructorKind;
      if(returned.value[0]==='ref')expected={kind:'normal',value:returned.value};
      else{
        require(kind==='base'||returned.value[0]==='undefined'&&entry.initialized,'derived primitive/uninitialized return requires a guest abrupt-construction record');
        expected={kind:'normal',value:entry.receiver};
      }
    }
    require(eq(expected,record.completion),'false constructor completion');entry.phase='complete';
    construction.lastCompletion={id:entry.id,parent:entry.parent,superParent:entry.superParent,completion:copy(expected)};
    controller.lastReturn={kind:expected.kind==='normal'?'return':'throw',value:copy(expected.value)};
  }else if(record.kind==='construct.target'||record.kind==='construct.this'){
    require(controller.stack.at(-1)===record.invocation,'receiver/newTarget read has wrong active invocation');
    const entry=construction.frames.findLast(row=>row.bodyInvocation===record.invocation&&row.phase!=='complete');
    const expected=record.kind==='construct.target'?entry?.newTarget??['undefined']:controller.receiver;
    if(record.kind==='construct.this')require(!entry||entry.initialized,'uninitialized this requires a guest abrupt-construction record');
    known(controller,record.result);require(eq(record.result,expected),'false receiver/newTarget read');
  }else if(record.kind==='super.select'){
    const owner=frame(controller,record.owner,api);
    require(owner.phase==='body'&&owner.bodyInvocation===controller.stack.at(-1)&&metadata(controller,owner.callee[1],api).constructorKind==='derived'&&owner.selectedSuper===null,
      'super selection requires an active derived constructor');
    const parent=heapNode(controller,owner.callee[1]).prototype,expected=Array.isArray(parent)?parent:['undefined'];
    known(controller,record.callee);require(eq(record.callee,expected),'false super constructor selection');owner.selectedSuper=copy(expected);
  }else if(record.kind==='super.bind'){
    const owner=frame(controller,record.owner,api),completed=construction.lastCompletion;
    require(owner.phase==='body'&&owner.bodyInvocation===controller.stack.at(-1)&&!owner.initialized&&
      completed?.superParent===owner.id&&completed.parent===owner.bodyInvocation&&completed.completion.kind==='normal'&&eq(completed.completion.value,record.receiver),
      'super binding has no unique successful superclass result');
    known(controller,record.receiver);owner.receiver=copy(record.receiver);owner.initialized=true;construction.lastCompletion=null;
    controller.receiver=copy(record.receiver);controller.locals.set(owner.bodyInvocation+':this',copy(record.receiver));
    const initializer=metadata(controller,owner.callee[1],api).instanceInitializer;
    if(initializer){
      require(record.child!==null,'derived initializer requires its invocation');owner.phase='initialize-derived';owner.activeChild=record.child;
      api.call(controller,{child:record.child,callee:initializer,receiver:record.receiver,arguments:[]});
    }else require(record.child===null,'class without derived fields cannot invent an initializer');
  }else if(record.kind==='super.finish'){
    const owner=frame(controller,record.owner,api);
    const returned=controller.lastReturn;
    require(owner.phase==='initialize-derived'&&controller.stack.at(-1)===owner.bodyInvocation&&!controller.stack.includes(owner.activeChild)&&
      ['return','throw'].includes(returned?.kind),'derived initializer has not completed');
    const expected={kind:returned.kind==='throw'?'throw':'normal',value:returned.kind==='throw'?returned.value:owner.receiver};
    known(controller,record.completion.value);
    require(eq(record.completion,expected)&&eq(controller.receiver,owner.receiver),'false derived initializer completion or receiver');
    owner.phase='body';owner.activeChild=owner.bodyInvocation;
  }else return false;
  return true;
}

/** Called only inside the shared machine's transactional staging boundary. */
export function applyConstructionRecordV8(controller,record,api){
  if(!CONSTRUCTION_RECORD_FIELDS[record.kind])return false;
  if(applyContinuation(controller,record,api))return true;
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
  if(snapshot===null){
    api.require(![...controller.heap.values()].some(hasConstructionStateV8),'construction heap metadata requires declared construction state');
    return {valid:true,privateNames:0};
  }
  assertAlgorithmFields(snapshot,CONSTRUCTION_STATE_V8_FIELDS,'construction protocol state');
  api.require(snapshot.schema===CONSTRUCTION_STATE_V8_SCHEMA,'construction state schema');
  assertAlgorithmDataArray(snapshot.privateNames,'private identities');assertAlgorithmDataArray(snapshot.frames,'construction frames');
  api.require(snapshot.privateNames.length<=4096&&snapshot.frames.length<=4096,'construction state bound');
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
  const frames=new Map();
  for(const entry of snapshot.frames){
    assertAlgorithmFields(entry,CONSTRUCTION_FRAME_V8_FIELDS,'construction frame');
    for(const key of ['id','parent','activeChild'])id(entry[key]);
    if(entry.bodyInvocation!==null)id(entry.bodyInvocation);
    api.require(!frames.has(entry.id),'duplicate construction continuation');frames.set(entry.id,entry);
    api.known(controller,entry.callee);api.known(controller,entry.newTarget);api.known(controller,entry.receiver);
    api.require(entry.callee[0]==='ref'&&entry.newTarget[0]==='ref','constructor identities must be references');
    const info=metadata(controller,entry.callee[1],api);
    api.require(info.constructorKind!==null&&metadata(controller,entry.newTarget[1],api).constructorKind!==null,'frame has nonconstructible target');
    assertAlgorithmDataArray(entry.arguments,'retained constructor arguments');api.require(entry.arguments.length<=4096,'retained constructor argument bound');entry.arguments.forEach(value=>api.known(controller,value));
    api.require(typeof entry.initialized==='boolean'&&['initialize-base','body','initialize-derived','complete'].includes(entry.phase),'receiver initialization phase');
    api.require(entry.initialized?entry.receiver[0]==='ref':info.constructorKind==='derived'&&entry.receiver[0]==='undefined','invalid retained receiver');
    api.require(controller.frameFunctions.has(entry.parent)&&controller.frameFunctions.has(entry.activeChild),'constructor invocation identity is absent');
    if(entry.bodyInvocation!==null)api.require(controller.frameFunctions.get(entry.bodyInvocation)===controller.heap.get(entry.callee[1]).code,'constructor body identity mismatch');
    if(entry.phase==='initialize-base')api.require(info.constructorKind==='base'&&entry.bodyInvocation===null&&info.instanceInitializer!==null,'invalid base initializer continuation');
    if(entry.phase==='initialize-derived')api.require(info.constructorKind==='derived'&&entry.bodyInvocation!==null&&entry.initialized&&info.instanceInitializer!==null,'invalid derived initializer continuation');
    if(entry.phase==='body')api.require(entry.bodyInvocation===entry.activeChild,'constructor active body mismatch');
    if(entry.phase==='complete')api.require(!controller.stack.includes(entry.activeChild)&&!controller.stack.includes(entry.bodyInvocation),'completed constructor remains active');
    else if(controller.stack.includes(entry.activeChild)){
      const parent=entry.phase==='initialize-derived'?entry.bodyInvocation:entry.parent;
      api.require(controller.stack.indexOf(entry.activeChild)===controller.stack.indexOf(parent)+1,'constructor continuation stack mismatch');
    }
    if(entry.selectedSuper!==null){api.known(controller,entry.selectedSuper);api.require(info.constructorKind==='derived'&&entry.phase==='body','super selection outside derived body');}
  }
  for(const entry of snapshot.frames)if(entry.superParent!==null){
    const owner=frames.get(entry.superParent);api.require(owner&&owner.bodyInvocation===entry.parent&&api.eq(owner.newTarget,entry.newTarget),'super constructor owner/newTarget mismatch');
  }
  if(snapshot.lastCompletion!==null){
    const completed=snapshot.lastCompletion;assertAlgorithmFields(completed,['id','parent','superParent','completion'],'last constructor completion');
    const entry=frames.get(completed.id);api.require(entry?.phase==='complete'&&entry.parent===completed.parent&&entry.superParent===completed.superParent,'last constructor completion identity mismatch');
    assertAlgorithmFields(completed.completion,['kind','value'],'last constructor result');api.require(['normal','throw'].includes(completed.completion.kind),'last constructor completion kind');api.known(controller,completed.completion.value);
  }
  return {valid:true,privateNames:declared.size};
}
export function constructionReservedIdentitiesV8(controller){return (controller.protocol?.construction?.privateNames??[]).map(row=>row.id);}
export function hasConstructionStateV8(node){return node.callable!==undefined||node.privateElements!==undefined;}
export function describeConstructionObjectV8(node){return {
  ...(node.callable?{callable:structuredClone(node.callable)}:{}),
  ...(node.privateElements?{privateElements:[...node.privateElements].map(([id,element])=>({id,...structuredClone(element)}))}:{})
};}
