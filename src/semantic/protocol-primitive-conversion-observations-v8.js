// Independent observations of native Number and ToPropertyKey. This module
// does not import the owned evaluator, source projector, or public machine.
// A private proxy observes native method selection while every guest getter
// and method receives the original object. The proxy never enters guest data.
import {parse} from 'acorn';
import {types} from 'node:util';
import {encode,decode} from '../values.js';
import {propertyKeyValue,symbolPropertyKey} from '../property-keys.js';

export const PRIMITIVE_CONVERSION_OBSERVATION_PROFILE_V8='primitive-conversion-observations/1';
const numberHook='__tracingProtocolConversionNumber',keyHook='__tracingProtocolConversionKey';
const apply=Reflect.apply,getOwn=Object.getOwnPropertyDescriptor,getPrototype=Object.getPrototypeOf,
  functionSource=Function.prototype.toString;
const reference=value=>value!==null&&['object','function'].includes(typeof value);
const site=node=>node.start+':'+node.end;
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);

function inventory(source,{reserved=false}={}){
  const numbers=[],keys=[];
  function visit(node,parent=null){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){for(const child of node)visit(child,parent);return;}
    if(reserved&&node.type==='Identifier'&&node.name.startsWith('__tracingProtocol'))
      throw new TypeError('Independent conversion observation: reserved observer name in source');
    if(node.type==='CallExpression'&&!node.optional&&node.callee.type==='Identifier'&&node.callee.name==='Number')
      numbers.push(node);
    if(node.type==='MemberExpression'&&node.computed){
      const assignment=parent?.type==='AssignmentExpression'&&parent.left===node,
        update=parent?.type==='UpdateExpression'&&parent.argument===node,
        deletion=parent?.type==='UnaryExpression'&&parent.operator==='delete';
      keys.push({key:node.property,site:site(assignment&&parent.operator==='='||update?parent:node),
        unsupported:assignment&&parent.operator!=='='||update?'compound/logical/update object keys differ from the pinned reference edition':
          deletion?'computed deletion has no owned source profile':node.object.type==='Super'?'computed super key has no owned conversion profile':null});
    }else if(node.computed&&['Property','MethodDefinition','PropertyDefinition'].includes(node.type)){
      keys.push({key:node.key,site:site(node.type==='Property'?node.key:node),unsupported:null});
    }
    for(const [key,child]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))visit(child,node);
  }
  visit(parse(source,{ecmaVersion:'latest',sourceType:'script'}));return {numbers,keys};
}

function ownedObservations(bundle,original){
  const numberSites=new Set(original.numbers.map(site)),keySites=new Map(original.keys.map(row=>[row.site,row])),
    siteById=new Map(bundle.sites.map(row=>[row.siteId,site(row)])),state=structuredClone(bundle.initialState),
    rows=[],identities=new Map(),active=new Map(),children=new Map();let next=0;
  const fail=message=>{throw new TypeError('Independent owned conversion observation: '+message);};
  function value(tag){
    if(!Array.isArray(tag))fail('missing value');
    if(['builtinfn','intrinsic'].includes(tag[0]))return ['builtin',tag[1]];
    if(!['ref','symbol'].includes(tag[0]))return structuredClone(tag);
    const identity=JSON.stringify(tag);if(!identities.has(identity))identities.set(identity,++next);
    return ['identity',tag[0]==='symbol'?'symbol':bundle.finalState.heap[tag[1]]?.kind==='function'?'function':'object',identities.get(identity)];
  }
  function seed(tag){
    if(tag?.[0]!=='ref'||identities.has(JSON.stringify(tag)))return;value(tag);
    const node=state.heap[tag[1]];if(!node||Object.keys(node.accessors??{}).length)fail('input graph is not data-only');
    for(const key of Object.keys(node.properties??{}).sort())seed(node.properties[key].value);
  }
  for(const argument of bundle.entrySpec.arguments)seed(argument);
  const add=(entry,kind,fields)=>{
    if(rows.length>=32768)fail('observation bound');rows.push({site:entry.site,kind,...fields});
  };
  function lookup(input,key){
    if(input?.[0]!=='ref')fail('conversion lookup lacks an object');
    const seen=new Set();let node=state.heap[input[1]];
    for(;;){
      if(!node||!['object','array'].includes(node.kind)||seen.has(node.id))fail('exotic or cyclic conversion prototype');
      seen.add(node.id);
      if(Object.hasOwn(node.accessors??{},key))return {descriptor:'accessor',method:node.accessors[key].get.value};
      if(Object.hasOwn(node.properties??{},key))return {descriptor:'data',method:node.properties[key].value};
      const prototype=Object.hasOwn(node,'prototype')?node.prototype:node.kind==='array'?'Array.prototype':'Object.prototype';
      if(prototype===null)return {descriptor:'missing',method:['undefined']};
      if(['Object.prototype','Array.prototype'].includes(prototype)){
        const builtin=key==='valueOf'?'Object.valueOf':key==='toString'?
          prototype==='Array.prototype'?'Array.toString':'Object.toString':
          key==='join'&&prototype==='Array.prototype'?'Array.prototype.join':null;
        return builtin?{descriptor:'builtin',method:['builtinfn',builtin]}:{descriptor:'missing',method:['undefined']};
      }
      node=state.heap[prototype];
    }
  }
  function builtinResult(input,name){
    if(name==='Object.valueOf')return input;
    if(name==='Object.toString'){
      const tag=lookup(input,symbolPropertyKey('well-known:toStringTag'));
      if(tag.descriptor==='accessor')fail('toStringTag accessor requires its own observation profile');
      return ['str','[object '+(tag.method[0]==='str'?tag.method[1]:state.heap[input[1]].kind==='array'?'Array':'Object')+']'];
    }
    if(name!=='Array.toString')fail('unsupported conversion builtin');
    const node=state.heap[input[1]],join=lookup(input,'join');
    if(node.kind!=='array'||join.descriptor==='accessor'||!same(join.method,['builtinfn','Array.prototype.join']))
      fail('Array.join override or accessor requires its own observation profile');
    const length=decode(node.properties.length.value),parts=[];
    if(!Number.isSafeInteger(length)||length<0||length>10000)fail('array conversion bound');
    for(let index=0;index<length;index++){
      const element=node.properties[String(index)]?.value;
      if(Object.hasOwn(node.accessors??{},String(index))||!element||
        !['undefined','null','bool','str','num','bigint'].includes(element[0]))fail('Array.toString needs dense scalar data');
      parts.push(['undefined','null'].includes(element[0])?'':String(decode(element)));
    }
    return ['str',parts.join(',')];
  }
  const pendingFor=(frame,goal)=>goal==='Number'?frame?.pendingNumberConversion:frame?.pendingPropertyKeyConversion?.conversion;
  function callback(event,entry,pending){
    const getter=pending.phase==='getter-waiting',method=pending.method,
      child=event.stateChanges.find(change=>change.table==='frames'&&change.id===pending.waitingFrameId)?.after,
      fn=method?.[0]==='ref'?state.heap[method[1]]:null,
      expectedThis=fn?.arrow?(fn.lexicalThisFrameId?state.frames[fn.lexicalThisFrameId]?.thisValue:fn.lexicalThis):entry.input;
    if(!child||!fn||fn.kind!=='function'||fn.async||bundle.programs[fn.codeId]?.generator||
      child.callerFrameId!==entry.owner||child.codeId!==fn.codeId||!same(child.thisValue,expectedThis)||
      children.has(child.id)||!same(method,entry.selected))fail('callback identity, receiver or captured method differs');
    const args=getter||pending.index!==-1?[]:[['str',entry.goal==='Number'?'number':'string']],
      environment=event.stateChanges.find(change=>change.table==='envs'&&change.id===child.envId)?.after,
      program=bundle.programs[fn.codeId];
    if(!environment||environment.parent!==fn.closureEnvId)fail('callback environment differs');
    for(let index=0;index<program.params.length;index++){
      const actual=environment.bindings[program.params[index]]?.token?.value;
      if(index===(program.restIndex??-1)){
        const array=actual?.[0]==='ref'?event.stateChanges.find(change=>change.table==='heap'&&change.id===actual[1])?.after:null,
          rest=args.slice(index);
        if(array?.kind!=='array'||!same(array.properties.length?.value,['num',rest.length])||
          rest.some((item,offset)=>!same(array.properties[String(offset)]?.value,item)))fail('callback rest arguments differ');
      }else if(!same(actual,args[index]??['undefined']))fail('callback arguments or conversion hint differ');
    }
    add(entry,getter?'getter.call':'call',{method:value(method),receiver:value(entry.input),arguments:args.map(value)});
    children.set(child.id,{entry,getter,method});
  }
  for(const event of bundle.events){
    const callee=event.operands[0]?.[0]==='method'?event.operands[0][1]:event.operands[0],location=siteById.get(event.siteId),
      numberStart=event.operation==='call.enter'&&callee?.[0]==='intrinsic'&&callee[1]==='Number',
      keyStart=event.operation==='property.key.convert',start=numberStart||keyStart,
      conversionEvent=start||['intrinsic.number.resume','property.key.resume'].includes(event.operation);
    // A caught intrinsic fault can lose both its operands and its reads. The
    // source call/key boundary is still present; do not treat that missing
    // event evidence as an empty, successfully observed conversion.
    if(event.completion?.type==='throw'&&(keyStart||['intrinsic.number.resume','property.key.resume'].includes(event.operation)||
      event.operation==='call.enter'&&numberSites.has(location)))
      fail('intrinsic conversion fault has no complete source observation profile');
    if(start){
      const goal=numberStart?'Number':'PropertyKey',keySite=keySites.get(location);
      if(numberStart?!numberSites.has(location):!keySite)fail('unanchored '+goal+' source conversion');
      if(keySite?.unsupported&&!numberStart)fail(keySite.unsupported);
      if(active.has(event.invocationId))fail('overlapping conversions in one frame');
      const entry={site:location,goal,input:numberStart?event.operands[1]??['num',0]:event.operands[0],
        owner:event.invocationId,selected:null};
      active.set(entry.owner,entry);
      add(entry,'begin',{goal,hint:goal==='Number'?'number':'string',value:value(entry.input)});
    }
    if(conversionEvent){
      const entry=active.get(event.invocationId);if(!entry)fail('missing conversion invocation');
      // These caught faults currently discard the reads made by that event.
      // An independent observer must not invent the missing selection evidence.
      if(event.completion?.type==='throw')fail('intrinsic conversion fault has no complete source observation profile');
      for(const read of event.readObservations??[]){
        if(read.kind!=='property'||read.objectId!==entry.input[1])fail('conversion read receiver differs');
        const descriptor=lookup(entry.input,read.key),method=read.value;
        if(!same(descriptor.method,method))fail('conversion read differs from the live descriptor');
        entry.selected=method;
        add(entry,'lookup',{receiver:value(entry.input),key:propertyKeyValue(read.key),descriptor:descriptor.descriptor,value:value(method)});
        if(method[0]==='builtinfn'&&descriptor.descriptor!=='accessor')
          add(entry,'builtin',{method:method[1],receiver:value(entry.input),value:value(builtinResult(entry.input,method[1]))});
      }
      const parent=event.stateChanges.find(change=>change.table==='frames'&&change.id===entry.owner)?.after,
        pending=pendingFor(parent,entry.goal);
      if(pending){
        if(pending.operation!==entry.goal||!same(pending.input,entry.input)||!['waiting','getter-waiting'].includes(pending.phase))
          fail('conversion continuation differs');
        callback(event,entry,pending);
      }else{
        if(entry.goal==='Number'?event.result?.[0]!=='num':!['str','symbol'].includes(event.result?.[0]))fail('conversion result is absent');
        add(entry,'finish',{value:value(event.result)});active.delete(entry.owner);
      }
    }
    const finished=event.stateChanges.filter(change=>change.table==='frames'&&children.has(change.id)&&
      !['completed','thrown'].includes(change.before?.status)&&['completed','thrown'].includes(change.after?.status));
    const depth=id=>{let result=0;const seen=new Set();while(id){if(seen.has(id))fail('cyclic callback chain');seen.add(id);
      result++;id=state.frames[id]?.callerFrameId;}return result;};
    finished.sort((left,right)=>depth(right.id)-depth(left.id));
    for(const change of finished){
      const {entry,getter,method}=children.get(change.id),kind=change.after.completion?.type,
        result=change.after.completion?.value?.value;
      if(!['return','throw'].includes(kind)||!Array.isArray(result))fail('missing callback completion');
      if(getter&&kind==='return'&&['builtinfn','intrinsic','hostfn'].includes(result[0]))
        fail('getter-returned builtin requires its own callable identity profile');
      add(entry,(getter?'getter.':'')+kind,{method:value(method),value:value(result)});children.delete(change.id);
      if(kind==='throw'){add(entry,'abrupt',{value:value(result)});active.delete(entry.owner);}
      else if(getter)entry.selected=result;
    }
    for(const change of event.stateChanges)if(state[change.table]){
      if(change.after===null)delete state[change.table][change.id];
      else if(change.after!==undefined)state[change.table][change.id]=change.after;
    }
  }
  if(active.size||children.size)fail('unfinished conversion observations');return rows;
}

export function createPrimitiveConversionObservationAdapterV8({source,side='native',bundle=null,initialValues=[]}={}){
  const original=inventory(source,{reserved:true});if(!original.numbers.length&&!original.keys.length)return null;
  if(side==='owned')return {id:PRIMITIVE_CONVERSION_OBSERVATION_PROFILE_V8,observations:()=>ownedObservations(bundle,original)};
  const rows=[],identities=new Map(),builtins=new Map(),builtinHomes=new Set(),failures=[];
  let next=0,nativeNumber=null,nativePropertyKey=null,nativeArrayJoin=null,
    invoke=call=>apply(call.callee,call.receiver,call.arguments);
  const fail=message=>{failures.push(message);throw new TypeError('Independent native conversion observation: '+message);};
  function value(raw){
    if(builtins.has(raw))return ['builtin',builtins.get(raw)];
    if(!reference(raw)&&typeof raw!=='symbol')return encode(raw);
    if(reference(raw)&&types.isProxy(raw))fail('guest Proxy is outside the conversion profile');
    if(!identities.has(raw))identities.set(raw,++next);return ['identity',typeof raw,identities.get(raw)];
  }
  function seed(raw){
    if(!reference(raw)||identities.has(raw))return;value(raw);
    const descriptors=Object.getOwnPropertyDescriptors(raw);
    for(const key of Object.keys(descriptors).sort()){
      if(!Object.hasOwn(descriptors[key],'value'))fail('input graph is not data-only');seed(descriptors[key].value);
    }
  }
  initialValues.forEach(seed);
  const add=(location,kind,fields)=>{if(rows.length>=32768)fail('observation bound');rows.push({site:location,kind,...fields});};
  function lookup(object,key){
    const seen=new Set();let node=object;
    while(node!==null){
      if(types.isProxy(node)||seen.has(node))fail('exotic or cyclic conversion prototype');seen.add(node);
      const descriptor=getOwn(node,key);
      if(descriptor)return Object.hasOwn(descriptor,'value')?
        {descriptor:builtinHomes.has(node)&&builtins.has(descriptor.value)?'builtin':'data',method:descriptor.value}:
        {descriptor:'accessor',method:descriptor.get};
      node=getPrototype(node);
    }
    return {descriptor:'missing',method:undefined};
  }
  function sourceCallable(method){
    if(types.isProxy(method)||types.isAsyncFunction(method)||types.isGeneratorFunction(method)||
      /\[native code\]/.test(apply(functionSource,method,[])))fail('conversion callback requires an ordinary source function');
  }
  function builtinCall(input,method,name,args){
    if(name==='Object.toString'&&lookup(input,Symbol.toStringTag).descriptor==='accessor')
      fail('toStringTag accessor requires its own observation profile');
    if(name==='Array.toString'){
      const join=lookup(input,'join'),length=getOwn(input,'length')?.value;
      if(!Array.isArray(input)||join.descriptor==='accessor'||
        ![nativeArrayJoin,Array.prototype.join].includes(join.method))fail('Array.join override or accessor requires its own observation profile');
      if(!Number.isSafeInteger(length)||length<0||length>10000)fail('array conversion bound');
      for(let index=0;index<length;index++){
        const descriptor=getOwn(input,String(index));
        if(!descriptor||!Object.hasOwn(descriptor,'value')||reference(descriptor.value)||typeof descriptor.value==='symbol')
          fail('Array.toString needs dense scalar data');
      }
    }
    return apply(method,input,args);
  }
  function convert(goal,location,input,perform){
    if(reference(input)&&(typeof input!=='object'||types.isProxy(input)))fail('guest Proxy or function input is outside the conversion profile');
    add(location,'begin',{goal,hint:goal==='Number'?'number':'string',value:value(input)});
    let callbackThrow=false,result;
    const execute=(method,args,getter)=>{
      sourceCallable(method);
      add(location,getter?'getter.call':'call',{method:value(method),receiver:value(input),arguments:args.map(value)});
      try{
        const returned=invoke({callee:method,receiver:input,arguments:args});
        if(getter&&builtins.has(returned))fail('getter-returned builtin requires its own callable identity profile');
        add(location,getter?'getter.return':'return',{method:value(method),value:value(returned)});return returned;
      }catch(error){callbackThrow=true;add(location,getter?'getter.throw':'throw',{method:value(method),value:value(error)});throw error;}
    };
    try{
      if(!reference(input))result=perform(input);
      else{
        const observed=new Proxy({}, {get(_target,key){
          if(key!==Symbol.toPrimitive&&key!=='valueOf'&&key!=='toString')fail('unexpected conversion lookup');
          const descriptor=lookup(input,key),encoded=key===Symbol.toPrimitive?['symbol','well-known:toPrimitive']:['str',key];
          add(location,'lookup',{receiver:value(input),key:encoded,descriptor:descriptor.descriptor,value:value(descriptor.method)});
          const method=descriptor.descriptor==='accessor'&&descriptor.method!==undefined?execute(descriptor.method,[],true):descriptor.method;
          if(typeof method!=='function')return method;
          return (...args)=>{
            const builtin=builtins.get(method);
            if(builtin){
              const returned=builtinCall(input,method,builtin,args);
              add(location,'builtin',{method:builtin,receiver:value(input),value:value(returned)});return returned;
            }
            return execute(method,args,false);
          };
        }});
        result=perform(observed);
      }
    }catch(error){
      if(!callbackThrow)fail('intrinsic conversion fault has no complete source observation profile');
      add(location,'abrupt',{value:value(error)});throw error;
    }
    add(location,'finish',{value:value(result)});return result;
  }
  return {id:PRIMITIVE_CONVERSION_OBSERVATION_PROFILE_V8,
    setCallObserver(observer){invoke=observer;},
    globals:{
      [numberHook]:(location,callee)=>(...args)=>invoke({callee,receiver:undefined,arguments:args,site:location}),
      [keyHook]:(index,input)=>{
        if(!reference(input))return input;
        const key=original.keys[index];if(!key)fail('unanchored property key');
        // Deferring conversion preserves native reference timing: a simple
        // assignment evaluates its RHS before looking up this key's methods.
        return {[Symbol.toPrimitive](hint){
          if(hint!=='string')fail('unexpected property-key hint');
          if(key.unsupported)fail(key.unsupported);
          return convert('PropertyKey',key.site,input,raw=>nativePropertyKey(raw));
        }};
      }
    },
    initializeRealm(evaluate){
      const intrinsics=evaluate('({Number,object:Object.prototype,array:Array.prototype,valueOf:Object.prototype.valueOf,toString:Object.prototype.toString,arrayToString:Array.prototype.toString,join:Array.prototype.join})');
      nativeNumber=intrinsics.Number;nativeArrayJoin=intrinsics.join;
      for(const [fn,name]of [[intrinsics.valueOf,'Object.valueOf'],[intrinsics.toString,'Object.toString'],[intrinsics.arrayToString,'Array.toString'],
        [Object.prototype.valueOf,'Object.valueOf'],[Object.prototype.toString,'Object.toString'],[Array.prototype.toString,'Array.toString']])builtins.set(fn,name);
      for(const home of [intrinsics.object,intrinsics.array,Object.prototype,Array.prototype])builtinHomes.add(home);
      nativePropertyKey=evaluate('(()=>{const keys=Reflect.ownKeys;return value=>keys({[value]:0})[0];})()');
    },
    instrument(text){
      const current=inventory(text);
      if(current.numbers.length!==original.numbers.length||current.keys.length!==original.keys.length)fail('source conversion inventory changed');
      const edits=current.numbers.map((node,index)=>({start:node.callee.start,end:node.callee.end,
        text:numberHook+'('+JSON.stringify(site(original.numbers[index]))+',Number)'}));
      for(let index=0;index<current.keys.length;index++){
        const key=current.keys[index].key;
        edits.push({start:key.start,end:key.start,text:keyHook+'('+index+',('}, {start:key.end,end:key.end,text:'))'});
      }
      edits.sort((left,right)=>right.start-left.start||right.end-left.end);
      for(const edit of edits)text=text.slice(0,edit.start)+edit.text+text.slice(edit.end);return text;
    },
    observeCall(call,nextCall){
      if(call.callee!==nativeNumber)return nextCall();
      if(typeof call.site!=='string')fail('unanchored Number source call');
      const input=call.arguments.length?call.arguments[0]:0;
      return convert('Number',call.site,input,raw=>reference(input)?apply(call.callee,call.receiver,[raw,...call.arguments.slice(1)]):nextCall());
    },
    observations(){if(failures.length)throw new TypeError('Independent native conversion observation: '+failures[0]);return rows;}
  };
}
