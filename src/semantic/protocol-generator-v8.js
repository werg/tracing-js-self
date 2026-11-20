// Explicit synchronous generator continuation semantics. Ordinary properties,
// lexical cells and scoped calls remain in the same authoritative controller.
import {assertAlgorithmFields,assertAlgorithmDataArray,isAlgorithmDataRecord} from './ir.js';
import {validateIteratorRecordV8,applyIteratorRecordV8} from './protocol-iterator-v8.js';

export const GENERATOR_PROFILE_V8='synchronous-generator/1';
export const GENERATOR_INTRINSICS_V8=Object.freeze(['GeneratorFunction.prototype','Generator.prototype','Iterator.prototype']);
export const GENERATOR_RECORD_FIELDS=Object.freeze(Object.fromEntries(Object.entries({
  'generator.function':['kind','object','prototype','name','length'],
  'generator.create':['kind','name','child','callee','receiver','arguments'],
  'generator.start':['kind','object'],
  'generator.resume':['kind','object','method','argument'],
  'generator.receive':['kind','object','bind'],
  'generator.handler.enter':['kind','object','name','catch','finally'],
  'generator.handler.route':['kind','object','completion'],
  'generator.handler.catch':['kind','object','name','bind'],
  'generator.handler.leave':['kind','object','name'],
  'generator.delegate.enter':['kind','object','iterator','next'],
  'generator.delegate.call':['kind','object','method','call'],
  'generator.delegate.result':['kind','object','result','done'],
  'generator.delegate.yield':['kind','object','result'],
  'generator.delegate.receive':['kind','object'],
  'generator.delegate.end':['kind','object'],
  'generator.delegate.absent':['kind','object','method'],
  'generator.delegate.abrupt':['kind','object','value'],
  'generator.yield':['kind','object','value','name'],
  'generator.finish':['kind','object','completion','name'],
  'generator.completed':['kind','object','method','argument','name'],
  'generator.lookup':['kind','receiver','key','method'],
  'generator.read':['kind','object','key','result'],
  'generator.identity':['kind','object','result']
}).map(([kind,fields])=>[kind,Object.freeze(fields)])));
export const GENERATOR_HEAP_FIELDS=Object.freeze(['kind','callee','invocation','receiver','arguments','phase','resume','pending','yielded',
  'handlers','delegation','prototype','properties']);
const phases=new Set(['initializing','suspendedStart','executing','suspendedYield','completed']),methods=new Set(['next','return','throw']);
const builtins=new Set(['Generator.next','Generator.return','Generator.throw','Iterator.identity']);
const bound=4096,ref=id=>['ref',id],U=()=>['undefined'];
function id(value){if(typeof value!=='string'||!value||value.length>256)throw new TypeError('Generator identity');}
function key(value){assertAlgorithmDataArray(value,'generator key');if(value.length!==2||!['str','symbol'].includes(value[0])||typeof value[1]!=='string')throw new TypeError('Generator property key');}
function completion(record,value,{normal=false}={}){assertAlgorithmFields(record,['kind','value'],'generator completion');
  if(!['return','throw',...(normal?['normal']:[])].includes(record.kind))throw new TypeError('Generator completion kind');value(record.value);
  if(record.kind==='normal'&&record.value[0]!=='undefined')throw new TypeError('Normal generator handler completion has no value');}
export function validateGeneratorRecordV8(record,{value}){
  if(!isAlgorithmDataRecord(record))throw new TypeError('Generator record must be ordinary data');
  const fields=GENERATOR_RECORD_FIELDS[record?.kind];if(!fields)return false;assertAlgorithmFields(record,fields,'generator record');
  for(const field of ['object','child','name','prototype','bind'])if(Object.hasOwn(record,field)&&record[field]!==null&&!(field==='name'&&record.kind==='generator.function'))id(record[field]);
  for(const field of ['callee','receiver','argument','result','iterator'])if(Object.hasOwn(record,field))value(record[field]);
  if(Object.hasOwn(record,'value'))value(record.value);if(Object.hasOwn(record,'key'))key(record.key);
  if(record.kind==='generator.function'){
    if(typeof record.name!=='string'||record.name.length>bound||!Number.isSafeInteger(record.length)||record.length<0||record.length>bound)throw new TypeError('Generator function metadata');
  }
  if(record.kind==='generator.create'){
    if(record.callee[0]!=='ref')throw new TypeError('Generator callable identity');assertAlgorithmDataArray(record.arguments,'generator arguments');
    if(record.arguments.length>bound)throw new TypeError('Generator argument bound');record.arguments.forEach(value);
  }
  if(['generator.resume','generator.completed','generator.delegate.call','generator.delegate.absent'].includes(record.kind)&&!methods.has(record.method))throw new TypeError('Generator resume kind');
  if(record.kind==='generator.lookup'&&!builtins.has(record.method))throw new TypeError('Generator builtin selection');
  if(record.kind==='generator.finish')completion(record.completion,value);
  if(record.kind==='generator.handler.route')completion(record.completion,value,{normal:true});
  if(record.kind==='generator.handler.enter'&&(typeof record.catch!=='boolean'||typeof record.finally!=='boolean'||!record.catch&&!record.finally))
    throw new TypeError('Generator handler needs catch or finally');
  if(record.kind==='generator.delegate.enter'&&(!['Iterator.next','Generator.next'].includes(record.next)||record.iterator[0]!=='ref'))
    throw new TypeError('Generator delegate requires an exact iterator and cached next');
  if(record.kind==='generator.delegate.result'&&typeof record.done!=='boolean')throw new TypeError('Generator delegated completion boolean');
  if(record.kind==='generator.delegate.call'){
    if(record.call?.kind==='iterator.next')validateIteratorRecordV8(record.call,{value});
    else if(['generator.resume','generator.completed'].includes(record.call?.kind))validateGeneratorRecordV8(record.call,{value});
    else throw new TypeError('Generator delegate call needs its iterator or generator operation');
  }
  return true;
}
const data=(value,{writable=true,enumerable=false,configurable=true}={})=>({kind:'data',value,writable,enumerable,configurable});
function node(controller,id,api){const object=controller.heap.get(id);api.require(object?.kind==='generator','generator identity required');return object;}
function active(controller,object,api){api.require(controller.stack.at(-1)===object.invocation,'generator body is not the active invocation');}
function functionNode(controller,value,api){api.known(controller,value);api.require(value[0]==='ref','generator callable reference');
  const fn=controller.heap.get(value[1]);api.require(fn?.kind==='closure'&&fn.generatorFunction===true,'declared generator function required');return fn;}
function prototype(controller,fn,api){
  const descriptor=api.ownDescriptor(fn,['str','prototype']);api.require(descriptor?.kind==='data','generator prototype getter requires a creation continuation');
  const value=descriptor.value;api.known(controller,value);
  if(value[0]==='ref'){const target=controller.heap.get(value[1]);api.require(['object','array','closure','generator'].includes(target?.kind),'generator prototype needs ordinary owned storage');return api.copy(value);}
  return 'Generator.prototype';
}
function allocateResult(controller,name,value,done,api){
  api.require(name!==null,'generator iterator result requires a fresh identity');
  api.allocate(controller,{name,objectKind:'object',length:null,code:null,captures:[],functionKind:null,lexicalReceiver:null,
    properties:[{key:['str','value'],value},{key:['str','done'],value:['bool',done]}]});
  return ref(name);
}
function intrinsic(prototype,key){
  if(prototype==='GeneratorFunction.prototype'){
    if(key[0]==='symbol'&&key[1]==='well-known:toStringTag')return {descriptor:data(['str','GeneratorFunction'],{writable:false})};
    if(key[0]==='str'&&['prototype','constructor','call','apply','bind','caller','arguments','toString','valueOf','__proto__'].includes(key[1])||key[0]==='symbol'&&key[1]==='well-known:hasInstance')return {unsupported:true};
  }else{
    if(prototype==='Generator.prototype'){
      if(key[0]==='str'&&methods.has(key[1]))return {builtin:'Generator.'+key[1]};
      if(key[0]==='symbol'&&key[1]==='well-known:toStringTag')return {descriptor:data(['str','Generator'],{writable:false})};
      if(key[0]==='str'&&key[1]==='constructor')return {unsupported:true};
    }
    if(key[0]==='symbol'&&key[1]==='well-known:iterator')return {builtin:'Iterator.identity'};
  }
  if(key[0]==='str'&&['constructor','__proto__','toString','toLocaleString','valueOf','hasOwnProperty','isPrototypeOf','propertyIsEnumerable',
    '__defineGetter__','__defineSetter__','__lookupGetter__','__lookupSetter__'].includes(key[1]))return {unsupported:true};
  return {descriptor:null};
}
export function resolveGeneratorIntrinsicV8(_controller,prototype,key,api){
  const result=intrinsic(prototype,key);api.require(!result.unsupported&&!result.builtin,'generator intrinsic requires its callable protocol');return result;
}
function lookup(controller,receiver,key,api){
  api.known(controller,receiver);api.knownKey(controller,key);api.require(receiver[0]==='ref','generator property receiver');
  let current=receiver[1];const seen=new Set();
  for(;;){api.require(!seen.has(current),'generator prototype cycle');seen.add(current);
    const object=controller.heap.get(current);api.require(['object','array','closure','generator'].includes(object?.kind),'generator ordinary prototype chain');
    const descriptor=api.ownDescriptor(object,key);if(descriptor)return {descriptor};
    const parent=object.prototype===undefined?'ordinary':object.prototype;
    if(GENERATOR_INTRINSICS_V8.includes(parent))return intrinsic(parent,key);
    if(parent===null||parent==='ordinary')return {descriptor:null};
    api.known(controller,parent);api.require(parent[0]==='ref','generator prototype identity');current=parent[1];
  }
}
export function assertGeneratorCallV8(controller,callee,options,api){
  if(callee?.[0]==='ref'&&controller.heap.get(callee[1])?.generatorFunction)
    api.require(options?.generator===true,'generator call requires its creation/resume protocol');
  return true;
}
export function assertGeneratorNextV8(controller,record,api){
  const current=[...controller.heap.values()].find(object=>object.kind==='generator'&&object.invocation===controller.stack.at(-1));
  if(!current)return true;
  api.require(!['return','throw'].includes(record.kind),'generator completion requires its retained continuation protocol');
  if(current.resume&&current.delegation)api.require(record.kind==='generator.delegate.receive'&&record.object===currentId(controller,current),
    'delegated generator resume must preserve its exact input');
  else if(current.resume?.kind==='next')api.require(record.kind==='generator.receive'&&record.object===currentId(controller,current),
    'normal generator resume input must be consumed before body work');
  else if(current.resume&&current.resume.kind!=='next')api.require(['generator.finish','generator.handler.route'].includes(record.kind)&&record.object===currentId(controller,current),
    'abrupt generator resume requires its handler continuation or completion');
  if(current.delegation?.phase==='calling')api.require(['generator.delegate.result','generator.delegate.abrupt'].includes(record.kind)&&record.object===currentId(controller,current),
    'delegated call must consume its exact result before continuation');
  if(current.pending)api.require(record.kind==='generator.finish'&&record.object===currentId(controller,current),
    'generator pending terminal completion cannot be discarded');
  if(current.handlers.at(-1)?.caught!==null&&current.handlers.at(-1)?.caught!==undefined)
    api.require(record.kind==='generator.handler.catch'&&record.object===currentId(controller,current),
      'generator catch must consume the exact thrown value');
  return true;
}
function currentId(controller,value){for(const [id,node]of controller.heap)if(node===value)return id;return null;}
function route(controller,object,completion,api){
  api.known(controller,completion.value);
  if(completion.kind==='normal'){
    const handler=object.handlers.at(-1);
    api.require(handler&&handler.phase!=='finally'&&handler.caught===null,'normal generator handler completion');
    if(handler.finally){handler.phase='finally';handler.pending=api.copy(completion);}
    else object.handlers.pop();return;
  }
  while(object.handlers.length){
    const handler=object.handlers.at(-1);
    if(completion.kind==='throw'&&handler.phase==='try'&&handler.catch){
      handler.phase='catch';handler.caught=api.copy(completion.value);return;
    }
    if(handler.phase!=='finally'&&handler.finally){
      handler.phase='finally';handler.caught=null;handler.pending=api.copy(completion);return;
    }
    object.handlers.pop();
  }
  object.pending=api.copy(completion);
}
function delegateMethod(controller,iterator,method,api){
  api.known(controller,iterator);api.require(iterator[0]==='ref','generator delegate identity');
  const target=controller.heap.get(iterator[1]);
  if(target?.kind==='iterator')return method==='next'?'Iterator.next':null;
  api.require(target?.kind==='generator','generator delegate requires its declared iterator profile');
  const selected=lookup(controller,iterator,['str',method],api);
  if(selected.builtin)return selected.builtin;
  api.require(!selected.unsupported&&(!selected.descriptor||selected.descriptor.kind==='data'&&['undefined','null'].includes(selected.descriptor.value[0])),
    'custom delegate methods need their callable continuation');return null;
}
function delegatedResult(controller,value,api){
  api.known(controller,value);api.require(value?.[0]==='ref','delegate result must be an ordinary object');
  const result=controller.heap.get(value[1]);api.require(result?.kind==='object','delegate result needs ordinary storage');
  const done=api.ownDescriptor(result,['str','done']);
  api.require(done?.kind==='data'&&done.value[0]==='bool','delegate done getter/conversion requires its continuation');
  return {object:result,done:done.value[1]};
}
function applyDelegation(controller,object,record,api){
  active(controller,object,api);api.require(object.phase==='executing'&&!object.pending,'generator delegation is not executing');
  if(record.kind==='generator.delegate.enter'){
    api.require(!object.delegation&&!object.resume&&record.iterator[1]!==record.object,'generator already delegates or has an unconsumed resume');
    api.require(delegateMethod(controller,record.iterator,'next',api)===record.next,'false cached delegate next');
    object.delegation={iterator:api.copy(record.iterator),next:record.next,request:{kind:'next',value:U()},phase:'ready',result:null};return;
  }
  const delegate=object.delegation;api.require(delegate,'generator has no delegate');
  if(record.kind==='generator.delegate.receive'){
    api.require(delegate.phase==='yielded'&&object.resume?.from==='suspendedYield','generator has no suspended delegate input');
    delegate.request={kind:object.resume.kind,value:api.copy(object.resume.value)};object.resume=null;delegate.phase='ready';delegate.result=null;return;
  }
  api.require(!object.resume,'delegation input must be consumed first');
  if(record.kind==='generator.delegate.call'){
    api.require(delegate.phase==='ready'&&record.method===delegate.request.kind,'delegate call changed its pending method');
    const selected=record.method==='next'?delegate.next:delegateMethod(controller,delegate.iterator,record.method,api),call=record.call;
    api.require(call.object===delegate.iterator[1],'delegate call changed its iterator receiver');
    delegate.phase='calling';
    if(selected==='Iterator.next'){
      api.require(record.method==='next'&&call.kind==='iterator.next','delegate cached next requires its builtin iterator step');
      applyIteratorRecordV8(controller,call,api);delegate.result=ref(call.name);
    }else{
      api.require(selected==='Generator.'+record.method&&['generator.resume','generator.completed'].includes(call.kind)&&
        call.method===record.method&&api.eq(call.argument,delegate.request.value),'delegate call changed its selected generator method or sent value');
      applyGeneratorRecordV8(controller,call,api);
    }
  }else if(record.kind==='generator.delegate.result'){
    api.require(delegate.phase==='calling','delegate result has no pending call');
    const expected=delegate.result??(controller.lastReturn?.kind==='return'?controller.lastReturn.value:null);
    api.require(expected&&api.eq(expected,record.result),'delegate result changed its exact call-result identity');
    const selected=delegatedResult(controller,record.result,api);api.require(selected.done===record.done,'delegate completion changed');
    delegate.result=api.copy(record.result);delegate.phase=record.done?'complete':'result';
  }else if(record.kind==='generator.delegate.yield'){
    api.require(delegate.phase==='result'&&api.eq(delegate.result,record.result)&&!delegatedResult(controller,record.result,api).done,
      'delegated yield changed its result or done state');api.require(object.yielded<bound,'generator yield bound');
    object.phase='suspendedYield';object.yielded++;delegate.phase='yielded';
    api.complete(controller,{kind:'return',invocation:object.invocation,value:record.result});
  }else if(record.kind==='generator.delegate.end'){
    api.require(delegate.phase==='complete','delegate has no completed result');const selected=delegatedResult(controller,delegate.result,api);
    api.require(selected.done,'delegate completion changed before continuation');const value=api.ownDescriptor(selected.object,['str','value']);
    api.require(!value||value.kind==='data','delegate value getter requires its continuation');object.delegation=null;
    if(delegate.request.kind==='return')route(controller,object,{kind:'return',value:value?.value??U()},api);
  }else if(record.kind==='generator.delegate.absent'){
    api.require(delegate.phase==='ready'&&record.method==='return'&&delegate.request.kind==='return'&&
      delegateMethod(controller,delegate.iterator,'return',api)===null,'delegate return is not absent');object.delegation=null;
    route(controller,object,{kind:'return',value:delegate.request.value},api);
  }else if(record.kind==='generator.delegate.abrupt'){
    api.require(delegate.phase==='calling'&&delegate.result===null&&controller.heap.get(delegate.iterator[1])?.kind==='generator'&&
      controller.lastReturn?.kind==='throw'&&api.eq(controller.lastReturn.value,record.value),
      'delegate throw changed its exact abrupt completion');object.delegation=null;route(controller,object,{kind:'throw',value:record.value},api);
  }
}
export function applyGeneratorRecordV8(controller,record,api){
  if(!Object.hasOwn(GENERATOR_RECORD_FIELDS,record.kind))return false;
  if(record.kind==='generator.function'){
    const fn=controller.heap.get(record.object);api.require(fn?.kind==='closure'&&fn.functionKind==='ordinary'&&!fn.generatorFunction&&!fn.callable,
      'generator function declaration needs an undeclared ordinary closure');
    api.require(fn.properties.size===0&&!(fn.descriptors?.size),'generator definition has preexisting own descriptors');api.fresh(controller,record.prototype);
    api.allocate(controller,{name:record.prototype,objectKind:'object',length:null,properties:[],code:null,captures:[],functionKind:null,lexicalReceiver:null});
    controller.heap.get(record.prototype).prototype='Generator.prototype';fn.generatorFunction=true;fn.prototype='GeneratorFunction.prototype';
    for(const [key,descriptor]of [['length',data(['num',record.length],{writable:false})],['name',data(['str',record.name],{writable:false})],
      ['prototype',data(ref(record.prototype),{configurable:false})]])api.installDescriptor(fn,['str',key],descriptor);
  }else if(record.kind==='generator.create'){
    const fn=functionNode(controller,record.callee,api);api.fresh(controller,record.name);api.known(controller,record.receiver);record.arguments.forEach(value=>api.known(controller,value));
    const parent=prototype(controller,fn,api);
    api.call(controller,{child:record.child,callee:record.callee,receiver:record.receiver,arguments:record.arguments},{generator:true});
    controller.heap.set(record.name,{kind:'generator',callee:api.copy(record.callee),invocation:record.child,receiver:api.copy(record.receiver),arguments:api.copy(record.arguments),
      phase:'initializing',resume:null,pending:null,yielded:0,handlers:[],delegation:null,prototype:parent,properties:new Map()});
  }else if(record.kind==='generator.lookup'){
    api.require(lookup(controller,record.receiver,record.key,api).builtin===record.method,'false generator builtin selection');
  }else{
    const object=node(controller,record.object,api);
    if(record.kind.startsWith('generator.delegate.'))applyDelegation(controller,object,record,api);
    else if(record.kind==='generator.read'){
      const selected=lookup(controller,ref(record.object),record.key,api);api.require(!selected.builtin&&!selected.unsupported,'generator property needs its callable profile');
      const descriptor=selected.descriptor;api.require(!descriptor||descriptor.kind==='data'||descriptor.get[0]==='undefined','generator getter requires a scoped call');
      api.known(controller,record.result);api.require(api.eq(record.result,descriptor?.kind==='data'?descriptor.value:U()),'false generator property read');
    }else if(record.kind==='generator.identity'){
      api.known(controller,record.result);api.require(api.eq(record.result,ref(record.object)),'generator iterable identity changed');
    }else if(record.kind==='generator.start'){
      active(controller,object,api);api.require(object.phase==='initializing'&&!object.resume,'generator body start is not pending');
      object.phase='suspendedStart';api.complete(controller,{kind:'return',invocation:object.invocation,value:ref(record.object)});
    }else if(record.kind==='generator.resume'){
      api.require(['suspendedStart','suspendedYield'].includes(object.phase),'generator is executing or completed');api.known(controller,record.argument);
      const from=object.phase;
      api.call(controller,{child:object.invocation,callee:object.callee,receiver:object.receiver,arguments:object.arguments},{generator:true,resume:true});
      object.phase='executing';object.resume={kind:record.method,from,value:record.method==='next'&&from==='suspendedStart'?U():api.copy(record.argument)};
    }else if(record.kind==='generator.receive'){
      active(controller,object,api);api.require(object.phase==='executing'&&object.resume?.kind==='next','generator has no normal sent value');
      api.require(record.bind===null||object.resume.from==='suspendedYield','initial next argument is ignored');
      if(record.bind!==null)api.setLocal(controller,record.bind,object.resume.value);object.resume=null;
    }else if(record.kind==='generator.handler.enter'){
      active(controller,object,api);api.require(object.phase==='executing'&&!object.resume&&!object.pending&&object.handlers.length<64,
        'generator handler entry has an outstanding completion or exceeds its bound');
      api.require(!object.handlers.some(handler=>handler.name===record.name),'duplicate active generator handler');
      object.handlers.push({name:record.name,catch:record.catch,finally:record.finally,phase:'try',caught:null,pending:null});
    }else if(record.kind==='generator.handler.route'){
      active(controller,object,api);api.require(object.phase==='executing'&&!object.pending,'generator completion routing is not active');
      api.known(controller,record.completion.value);
      if(object.resume){api.require(object.resume.kind!=='next'&&api.eq(record.completion,{kind:object.resume.kind,value:object.resume.value}),
        'generator handler changed its abrupt resume');object.resume=null;}
      route(controller,object,record.completion,api);
    }else if(record.kind==='generator.handler.catch'){
      active(controller,object,api);const handler=object.handlers.at(-1);
      api.require(handler?.name===record.name&&handler.phase==='catch'&&handler.caught!==null,'generator catch has no thrown value');
      if(record.bind!==null)api.setLocal(controller,record.bind,handler.caught);handler.caught=null;
    }else if(record.kind==='generator.handler.leave'){
      active(controller,object,api);const handler=object.handlers.at(-1);
      api.require(handler?.name===record.name&&handler.phase==='finally'&&handler.pending!==null&&!object.pending,
        'generator cleanup must finish its exact active obligation');
      object.handlers.pop();if(handler.pending.kind!=='normal')route(controller,object,handler.pending,api);
    }else if(record.kind==='generator.yield'){
      active(controller,object,api);api.require(object.phase==='executing'&&object.resume===null&&object.pending===null&&!object.delegation,'generator suspension has an outstanding continuation');
      api.require(object.yielded<bound,'generator yield bound');api.known(controller,record.value);
      const result=allocateResult(controller,record.name,record.value,false,api);object.phase='suspendedYield';object.yielded++;
      api.complete(controller,{kind:'return',invocation:object.invocation,value:result});
    }else if(record.kind==='generator.finish'){
      active(controller,object,api);api.require(['initializing','executing'].includes(object.phase)&&!object.handlers.length&&!object.delegation,'generator completion has an outstanding continuation');
      api.known(controller,record.completion.value);
      if(object.pending)api.require(api.eq(object.pending,record.completion),'generator cleanup changed its pending completion');
      if(object.phase==='initializing')api.require(record.completion.kind==='throw','parameter initialization cannot return a body result');
      if(object.resume)api.require(object.resume.kind!=='next'&&record.completion.kind===object.resume.kind&&api.eq(record.completion.value,object.resume.value),'abrupt resume completion changed');
      object.phase='completed';object.resume=null;object.pending=null;
      if(record.completion.kind==='return')api.complete(controller,{kind:'return',invocation:object.invocation,
        value:allocateResult(controller,record.name,record.completion.value,true,api)});
      else{api.require(record.name===null,'thrown generator completion cannot allocate a result');api.complete(controller,{kind:'throw',invocation:object.invocation,value:record.completion.value});}
    }else if(record.kind==='generator.completed'){
      api.known(controller,record.argument);api.require(object.phase==='completed'||object.phase==='suspendedStart'&&record.method!=='next','generator body still needs a resume');
      api.require(!controller.stack.includes(object.invocation),'completed generator frame is active');object.phase='completed';object.resume=null;object.pending=null;
      if(record.method==='throw'){api.require(record.name===null,'throw cannot allocate a generator result');controller.lastReturn={kind:'throw',value:api.copy(record.argument)};}
      else controller.lastReturn={kind:'return',value:allocateResult(controller,record.name,record.method==='return'?record.argument:U(),true,api)};
    }else return false;
  }
  return true;
}
export function hasGeneratorStateV8(node){return node.kind==='generator'||node.generatorFunction!==undefined;}
export function restoreGeneratorStateV8(controller,api){let count=0;const invocations=new Set();
  for(const [id,object]of controller.heap){
    if(object.generatorFunction!==undefined){
      api.require(object.kind==='closure'&&object.generatorFunction===true&&object.functionKind==='ordinary'&&!object.callable,'generator function capability');
      const descriptor=api.ownDescriptor(object,['str','prototype']);api.require(descriptor?.kind==='data'&&descriptor.writable&&!descriptor.enumerable&&!descriptor.configurable,'generator prototype descriptor');
    }
    if(object.kind!=='generator')continue;count++;
    // Additional ordinary property metadata is checked by the common heap
    // validator when this component is registered in the public contract.
    const extras=['descriptors','keyOrder','extensible'].filter(field=>Object.hasOwn(object,field));
    assertAlgorithmFields(object,[...GENERATOR_HEAP_FIELDS,...extras],'generator heap node');
    functionNode(controller,object.callee,api);api.known(controller,object.receiver);assertAlgorithmDataArray(object.arguments,'generator saved arguments');object.arguments.forEach(value=>api.known(controller,value));
    api.require(object.arguments.length<=bound&&typeof object.invocation==='string'&&!invocations.has(object.invocation)&&
      controller.frameFunctions.get(object.invocation)===controller.heap.get(object.callee[1]).code,'generator retained invocation');invocations.add(object.invocation);
    api.require(phases.has(object.phase)&&Number.isSafeInteger(object.yielded)&&object.yielded>=0&&object.yielded<=bound&&object.properties instanceof Map,'generator state or yield bound');
    assertAlgorithmDataArray(object.handlers,'generator handlers');api.require(object.handlers.length<=64,'generator handler bound');
    const handlerNames=new Set();
    for(const handler of object.handlers){
      assertAlgorithmFields(handler,['name','catch','finally','phase','caught','pending'],'generator handler');
      api.require(typeof handler.name==='string'&&handler.name.length>0&&handler.name.length<=256&&!handlerNames.has(handler.name)&&typeof handler.catch==='boolean'&&typeof handler.finally==='boolean'&&
        (handler.catch||handler.finally)&&['try','catch','finally'].includes(handler.phase),'generator handler identity/capability');handlerNames.add(handler.name);
      api.require(handler.phase!=='catch'||handler.catch,'generator catch has no source capability');
      api.require(handler.phase!=='finally'||handler.finally,'generator finally has no source capability');
      if(handler.caught!==null){api.known(controller,handler.caught);api.require(handler.phase==='catch','caught value outside catch');}
      if(handler.pending!==null){completion(handler.pending,value=>api.known(controller,value),{normal:true});api.require(handler.phase==='finally','pending completion outside cleanup');}
      api.require(handler.phase==='finally'?handler.pending!==null:handler.pending===null,'generator handler completion state');
    }
    if(object.pending!==null){completion(object.pending,value=>api.known(controller,value));
      api.require(object.phase==='executing'&&object.handlers.length===0&&object.resume===null&&object.delegation===null,'generator terminal completion state');}
    if(object.delegation!==null){
      const delegate=object.delegation;assertAlgorithmFields(delegate,['iterator','next','request','phase','result'],'generator delegation');
      api.known(controller,delegate.iterator);const target=delegate.iterator[0]==='ref'?controller.heap.get(delegate.iterator[1]):null;
      api.require(delegate.iterator[1]!==id&&['iterator','generator'].includes(target?.kind)&&
        delegate.next===(target.kind==='iterator'?'Iterator.next':'Generator.next'),'generator cached delegate capability');
      assertAlgorithmFields(delegate.request,['kind','value'],'generator delegate request');
      api.require(methods.has(delegate.request.kind),'generator delegate resume kind');api.known(controller,delegate.request.value);
      api.require(['ready','calling','result','complete','yielded'].includes(delegate.phase)&&['executing','suspendedYield'].includes(object.phase),
        'generator delegate phase');
      if(delegate.phase==='ready')api.require(delegate.result===null&&object.resume===null,'generator delegate request state');
      if(delegate.phase==='calling'&&target.kind==='generator')api.require(delegate.result===null,'generator delegate cannot predeclare its call result');
      if(delegate.phase==='yielded')api.require(object.phase==='suspendedYield'&&object.resume===null||
        object.phase==='executing'&&object.resume?.from==='suspendedYield','generator suspended delegate state');
      else api.require(object.phase==='executing'&&object.resume===null,'generator active delegate state');
      if(delegate.result!==null){
        if(delegate.phase==='yielded'){
          // The caller owns the published result object now. Its done value
          // was already consumed, so later writes cannot change that decision.
          api.known(controller,delegate.result);
          api.require(delegate.result[0]==='ref'&&controller.heap.get(delegate.result[1])?.kind==='object',
            'generator retained delegate result object');
        }else{const result=delegatedResult(controller,delegate.result,api);
          if(['result','complete'].includes(delegate.phase))api.require(result.done===(delegate.phase==='complete'),'generator saved delegate completion');}}
      else api.require(['ready','calling'].includes(delegate.phase),'generator delegate lacks its result identity');
    }
    api.require(!['suspendedStart','completed'].includes(object.phase)||object.handlers.length===0,'inactive generator has entered handler obligations');
    const isActive=controller.stack.includes(object.invocation);api.require(isActive===['initializing','executing'].includes(object.phase),'generator suspension and shared call stack disagree');
    if(object.resume!==null){assertAlgorithmFields(object.resume,['kind','from','value'],'generator resume');
      api.require(object.phase==='executing'&&methods.has(object.resume.kind)&&['suspendedStart','suspendedYield'].includes(object.resume.from),'generator resume state');api.known(controller,object.resume.value);
      if(object.resume.kind==='next'&&object.resume.from==='suspendedStart')api.require(object.resume.value[0]==='undefined','initial next input was not ignored');
    }
    if(object.prototype!==null&&object.prototype!=='ordinary'&&!GENERATOR_INTRINSICS_V8.includes(object.prototype)){
      api.known(controller,object.prototype);api.require(object.prototype[0]==='ref','generator prototype identity');
    }
  }
  api.require(count<=bound,'generator allocation bound');return {valid:true,generators:count};
}
