// Pure region meanings for semantic-execution/8. The released v7 grammar and
// semantic-algorithm/1 remain separate; source execution is never used here.
import {isDeepStrictEqual,types} from 'node:util';
import {assertAlgorithmFields as fields,assertAlgorithmDataArray as array,assertAlgorithmId as id,
  assertAlgorithmValue as value,isAlgorithmDataRecord as record,stableAlgorithmJSON} from './ir.js';
import {OPERATION_REGISTRY,evaluateTerm,encodeAlgorithmScalar as scalar,decodeAlgorithmScalar as native,
  algorithmHeapNode,snapshotAlgorithmHeap,validateDenseNumericArray} from './operations.js';

export const ALGORITHM_V8_SCHEMA='semantic-algorithm/2';
export const ALGORITHM_V8_PROFILE='ecmascript-pure-regions/1';
export const ALGORITHM_V8_LIMITS=Object.freeze({steps:256,nodes:2048,depth:64,items:128,work:32768,allocations:1024});
export const ALGORITHM_V8_INPUT_TYPES=Object.freeze(['scalar','number','dense-number-array','dense-primitive-array','data']);
export const TRAVERSAL_MODES=Object.freeze(['fold','map','filter','find','find_index','some','every','scan']);
const foldMode=mode=>['fold','scan'].includes(mode);
const fail=message=>{const error=new TypeError('Invalid '+ALGORITHM_V8_SCHEMA+': '+message);
  error.category='unsupported.algorithm-v8';throw error;};
const inheritedKeys=new Set(['__proto__','constructor','toString','toLocaleString','valueOf','hasOwnProperty',
  'isPrototypeOf','propertyIsEnumerable','__defineGetter__','__defineSetter__','__lookupGetter__','__lookupSetter__']);
const truthy=tag=>tag[0]==='ref'||Boolean(native(tag));
const copy=value=>structuredClone(value);

export const ALGORITHM_V8_OPERATION_METADATA=Object.freeze({
  ...Object.fromEntries(Object.entries(OPERATION_REGISTRY).map(([name,spec])=>[name,Object.freeze({
    family:spec.lazy?'selection':'primitive',domain:'ecmascript-primitive',order:'left-to-right',
    lazy:spec.lazy,mayThrow:!['equal','not_equal','not','void','type_of','select','and','or','coalesce'].includes(name),
    reads:[],writes:[],callsGuest:false,allocates:false,completion:['normal','throw'],
    consumer:{javascript:'implemented',native:'requires-exact-v8-admission'},arity:spec.arity,operator:spec.operator})])),
  default_undefined:Object.freeze({family:'selection',domain:'primitive-or-reference',order:'left-to-right',
    lazy:true,mayThrow:false,reads:[],writes:[],callsGuest:false,allocates:false,completion:['normal'],arity:2}),
  traverse:Object.freeze({family:'traversal',domain:'dense-primitive-array/1',order:'ascending',lazy:true,
    mayThrow:true,reads:['input-elements'],writes:[],callsGuest:false,allocates:true,completion:['normal','throw'],
    modes:TRAVERSAL_MODES}),
  get:Object.freeze({family:'projection',domain:'ordinary-own-data/1',order:'object-before-key',lazy:false,
    mayThrow:true,reads:['own-data'],writes:[],callsGuest:false,allocates:false,completion:['normal']}),
  let:Object.freeze({family:'binding',domain:'checked-pure-terms',order:'left-to-right',lazy:false,
    mayThrow:true,reads:['bound-values'],writes:[],callsGuest:false,allocates:false,completion:['normal','throw']}),
  array:Object.freeze({family:'allocation',domain:'dense-own-data/1',order:'left-to-right',lazy:false,
    mayThrow:false,reads:[],writes:['fresh-array'],callsGuest:false,allocates:true,completion:['normal']}),
  object:Object.freeze({family:'allocation',domain:'ordinary-own-data/1',order:'left-to-right',lazy:false,
    mayThrow:false,reads:[],writes:['fresh-object'],callsGuest:false,allocates:true,completion:['normal']})
});

export function validateTermV8(term,{inputs=null,values=null,scopes=[],maxNodes=ALGORITHM_V8_LIMITS.nodes}={}){
  let nodes=0;const ancestors=new Set(),dependencies=new Set(),inputDependencies=new Set();
  function visit(node,scope,depth){
    if(!record(node)||ancestors.has(node)||++nodes>maxNodes||depth>ALGORITHM_V8_LIMITS.depth)fail('term shape or budget');
    ancestors.add(node);
    const sub=child=>visit(child,scope,depth+1);
    if(node.op==='literal'){fields(node,['op','value'],'literal');value(node.value);}
    else if(node.op==='input'||node.op==='ref'){
      fields(node,['op','id'],'dependency');id(node.id);
      const declarations=node.op==='input'?inputs:values;
      if(declarations&&!declarations.has(node.id))fail('unbound '+node.op+' '+node.id);
      (node.op==='input'?inputDependencies:dependencies).add(node.id);
    }else if(node.op==='bound'){
      fields(node,['op','depth','index'],'lexical dependency');
      if(!Number.isSafeInteger(node.depth)||!Number.isSafeInteger(node.index)||node.depth<0||node.index<0||
        node.depth>=scope.length||node.index>=scope[node.depth])fail('unbound lexical dependency');
    }else if(node.op==='project'){
      fields(node,['op','object','key'],'projection');
      if(typeof node.key!=='string'||node.key==='__proto__')fail('projection key');sub(node.object);
    }else if(node.op==='get'){
      fields(node,['op','object','key'],'projection');sub(node.object);sub(node.key);
    }else if(node.op==='array'){
      fields(node,['op','items'],'array');array(node.items);
      if(node.items.length>ALGORITHM_V8_LIMITS.items)fail('array bound');node.items.forEach(sub);
    }else if(node.op==='object'){
      fields(node,['op','properties'],'object');array(node.properties);const keys=new Set();
      if(node.properties.length>ALGORITHM_V8_LIMITS.items)fail('object bound');
      for(const property of node.properties){fields(property,['key','value'],'object property');
        if(typeof property.key!=='string'||property.key==='__proto__'||keys.has(property.key))fail('object key');
        keys.add(property.key);sub(property.value);}
    }else if(node.op==='let'){
      fields(node,['op','bindings','body'],'eager bindings');array(node.bindings);
      if(!node.bindings.length||node.bindings.length>128)fail('binding count');
      node.bindings.forEach((binding,index)=>visit(binding,[index,...scope],depth+1));
      visit(node.body,[node.bindings.length,...scope],depth+1);
    }else if(node.op==='traverse'){
      fields(node,['op','mode','input','initial','callback','profile','order'],'traversal');
      if(!TRAVERSAL_MODES.includes(node.mode)||node.order!=='ascending'||node.profile!=='dense-primitive-array/1')
        fail('traversal profile');
      fields(node.callback,['arity','body'],'callback');
      if(node.callback.arity!==(foldMode(node.mode)?4:3))fail('callback arity');
      sub(node.input);
      if(foldMode(node.mode)){if(node.initial===null)fail('fold requires an explicit initial value');sub(node.initial);}
      else if(node.initial!==null)fail('non-fold initial value');
      visit(node.callback.body,[node.callback.arity,...scope],depth+1);
    }else if(node.op==='fold_left'){
      fields(node,['op','input','initial','step','order','profile'],'legacy numeric fold');
      if(node.step!=='add'||node.order!=='ascending'||node.profile!=='dense-number-array/1')fail('legacy fold profile');
      sub(node.input);sub(node.initial);
    }else{
      const spec=Object.hasOwn(OPERATION_REGISTRY,node.op)?OPERATION_REGISTRY[node.op]:
        node.op==='default_undefined'?{arity:2}:null;
      if(!spec)fail('unknown operation '+node.op);
      fields(node,['op','args'],'operation');array(node.args);
      if(node.args.length!==spec.arity)fail('operation arity');node.args.forEach(sub);
    }
    ancestors.delete(node);
  }
  visit(term,scopes,0);return {nodes,dependencies:[...dependencies],inputs:[...inputDependencies]};
}

export function validateAlgorithmV8(core){
  fields(core,['schema','profile','inputs','steps'],'v8 core');
  if(core.schema!==ALGORITHM_V8_SCHEMA||core.profile!==ALGORITHM_V8_PROFILE)fail('version or profile');
  array(core.inputs);array(core.steps);
  if(core.inputs.length>128||!core.steps.length||core.steps.length>ALGORITHM_V8_LIMITS.steps)fail('core budget');
  const inputs=new Set(),values=new Set(),all=new Set();let completed=false;
  function declare(name,set){id(name);if(all.has(name))fail('duplicate identity '+name);all.add(name);set.add(name);}
  for(const input of core.inputs){fields(input,['id','type'],'input');declare(input.id,inputs);
    if(!ALGORITHM_V8_INPUT_TYPES.includes(input.type))fail('input domain');}
  for(const step of core.steps){
    if(completed||!record(step))fail('work after completion or invalid step');
    if(step.kind==='compute'){
      fields(step,['kind','id','term'],'computation');validateTermV8(step.term,{inputs,values});declare(step.id,values);
    }else if(['return','throw'].includes(step.kind)){
      fields(step,['kind','value'],'completion');validateTermV8(step.value,{inputs,values});completed=true;
    }else fail('pure core step '+step.kind);
  }
  if(!completed)fail('missing completion');return {inputs:inputs.size,values:values.size,steps:core.steps.length};
}
export function canonicalAlgorithmV8(core){validateAlgorithmV8(core);return stableAlgorithmJSON(core);}

export function validateDensePrimitiveArray(tag,{heap=new Map()}={}){
  value(tag);if(tag[0]!=='ref')fail('dense array identity required');
  const {node,properties}=algorithmHeapNode(heap,tag[1]),length=properties.get('length');
  if(node.kind!=='array'||length?.[0]!=='num'||!Number.isSafeInteger(length[1])||
    length[1]<0||length[1]>ALGORITHM_V8_LIMITS.items||properties.size!==length[1]+1)fail('dense array bound, holes or properties');
  return Array.from({length:length[1]},(_,i)=>{
    const item=properties.get(String(i));if(!item||item[0]==='ref')fail('dense primitive elements required');
    value(item);return item;
  });
}
function read(map,key){
  if(types.isProxy(map))fail('proxy state');
  if(map instanceof Map)return Map.prototype.get.call(map,key);
  if(!record(map))fail('state data');return Object.hasOwn(map,key)?map[key]:undefined;
}
export function evaluateTermV8(term,{inputs=new Map(),values=new Map(),heap=new Map(),
  allocator={prefix:'v8',next:0},scopes=[],budget={remaining:ALGORITHM_V8_LIMITS.work}}={}){
  validateTermV8(term,{scopes:scopes.map(row=>row.length)});
  if(types.isProxy(heap)||!(heap instanceof Map))fail('mutable ordinary Map heap required');
  fields(allocator,['prefix','next'],'allocator');id(allocator.prefix);
  if(!Number.isSafeInteger(allocator.next)||allocator.next<0||allocator.next>ALGORITHM_V8_LIMITS.allocations)fail('allocation budget');
  const committed=tag=>{value(tag);if(tag[0]==='ref')algorithmHeapNode(heap,tag[1]);return copy(tag);};
  const allocate=(kind,properties)=>{
    let key;
    do{
      if(allocator.next>=ALGORITHM_V8_LIMITS.allocations)fail('allocation budget');
      key=allocator.prefix+':'+allocator.next++;
    }while(Map.prototype.has.call(heap,key));
    Map.prototype.set.call(heap,key,{id:key,kind,properties:new Map(properties)});return ['ref',key];
  };
  function get(object,key){
    if(key[0]==='ref')fail('object property key requires conversion hooks');
    const property=String(native(key));
    if(object[0]==='str'){
      if(property==='length')return scalar(object[1].length);
      if(/^(?:0|[1-9][0-9]*)$/.test(property))return scalar(object[1][Number(property)]);
      fail('string property outside ordinary index profile');
    }
    if(object[0]!=='ref')fail('ordinary object projection requires identity');
    const {properties}=algorithmHeapNode(heap,object[1]);
    if(!properties.has(property)&&inheritedKeys.has(property))fail('inherited property requires a detailed access');
    return committed(properties.get(property)??['undefined']);
  }
  function visit(node,scope){
    if(--budget.remaining<0)fail('semantic work budget');
    const sub=child=>visit(child,scope);
    if(node.op==='literal')return committed(node.value);
    if(node.op==='input'||node.op==='ref'){
      const result=read(node.op==='input'?inputs:values,node.id);if(result===undefined)fail('uncommitted dependency '+node.id);
      return committed(result);
    }
    if(node.op==='bound')return committed(scope[node.depth][node.index]);
    if(node.op==='project')return get(sub(node.object),scalar(node.key));
    if(node.op==='get')return get(sub(node.object),sub(node.key));
    if(node.op==='array'){
      const items=node.items.map(sub);return allocate('array',[['length',scalar(items.length)],...items.map((item,i)=>[String(i),item])]);
    }
    if(node.op==='object')return allocate('object',node.properties.map(prop=>[prop.key,sub(prop.value)]));
    if(node.op==='let'){
      const bindings=[],nested=[bindings,...scope];
      for(const binding of node.bindings)bindings.push(visit(binding,nested));
      return visit(node.body,nested);
    }
    if(node.op==='select')return sub(node.args[truthy(sub(node.args[0]))?1:2]);
    if(['and','or','coalesce','default_undefined'].includes(node.op)){
      const left=sub(node.args[0]);
      const right=node.op==='and'?truthy(left):node.op==='or'?!truthy(left):node.op==='default_undefined'?
        left[0]==='undefined':['null','undefined'].includes(left[0]);
      return right?sub(node.args[1]):left;
    }
    if(node.op==='traverse'){
      // Evaluate input before initial, then read the checked array snapshot.
      const input=sub(node.input);let accumulator=foldMode(node.mode)?sub(node.initial):null;
      const items=validateDensePrimitiveArray(input,{heap}),output=[];
      for(let index=0;index<items.length;index++){
        if(--budget.remaining<0)fail('semantic work budget');
        const item=items[index],parameters=foldMode(node.mode)?[accumulator,item,scalar(index),input]:[item,scalar(index),input];
        const result=visit(node.callback.body,[parameters,...scope]);
        if(foldMode(node.mode)){accumulator=result;if(node.mode==='scan')output.push(result);}
        else if(node.mode==='map')output.push(result);
        else if(node.mode==='filter'){if(truthy(result))output.push(item);}
        else if(node.mode==='find'&&truthy(result))return copy(item);
        else if(node.mode==='find_index'&&truthy(result))return scalar(index);
        else if(node.mode==='some'&&truthy(result))return scalar(true);
        else if(node.mode==='every'&&!truthy(result))return scalar(false);
      }
      if(node.mode==='fold')return copy(accumulator);
      if(node.mode==='find')return ['undefined'];if(node.mode==='find_index')return scalar(-1);
      if(node.mode==='some')return scalar(false);if(node.mode==='every')return scalar(true);
      return allocate('array',[['length',scalar(output.length)],...output.map((item,i)=>[String(i),item])]);
    }
    if(node.op==='fold_left'){
      const input=sub(node.input),initial=sub(node.initial),items=validateDenseNumericArray(input,{heap});
      if(initial[0]!=='num')fail('numeric fold initial value');
      let result=native(initial);for(const item of items)result+=native(item);return scalar(result);
    }
    const args=node.args.map(sub);
    return evaluateTerm({op:node.op,args:args.map(tag=>({op:'literal',value:tag}))},{heap});
  }
  return visit(term,scopes);
}

export function evaluateAlgorithmV8(core,args,{heap=new Map(),inputGraph=null,allocator={prefix:'v8',next:0}}={}){
  validateAlgorithmV8(core);
  if(inputGraph){fields(inputGraph,['roots','objects'],'input graph');args=inputGraph.roots;
    heap=new Map(inputGraph.objects.map(node=>[node.id,node]));}
  array(args);if(args.length!==core.inputs.length)fail('exact input arity required');
  const publicHeap=snapshotAlgorithmHeap(heap),inputs=new Map(),values=new Map(),claims=[],
    allocations=copy(allocator),budget={remaining:ALGORITHM_V8_LIMITS.work};
  core.inputs.forEach((input,index)=>{
    const tag=args[index];value(tag);
    if(input.type==='scalar'&&tag[0]==='ref')fail('scalar input');
    if(input.type==='number'&&tag[0]!=='num')fail('number input');
    if(input.type==='dense-number-array')validateDenseNumericArray(tag,{heap:publicHeap});
    if(input.type==='dense-primitive-array')validateDensePrimitiveArray(tag,{heap:publicHeap});
    if(tag[0]==='ref')algorithmHeapNode(publicHeap,tag[1]);inputs.set(input.id,copy(tag));
  });
  const env={inputs,values,heap:publicHeap,allocator:allocations,budget};let completion;
  for(const [index,step] of core.steps.entries()){
    const result=evaluateTermV8(step.kind==='compute'?step.term:step.value,env);
    if(step.kind==='compute'){values.set(step.id,result);claims.push({step:index,kind:'compute',id:step.id,result:copy(result)});}
    else {completion={kind:step.kind,value:result};claims.push({step:index,...copy(completion)});}
  }
  const graph={roots:[...copy(args),copy(completion.value)],objects:[...publicHeap].map(([key,node])=>({
    id:key,kind:node.kind,...(node.prototype===null?{prototype:null}:{}),
    properties:[...algorithmHeapNode(publicHeap,key).properties].map(([key,value])=>({key,value:copy(value)}))}))};
  return {completion,claims,inputs,values,heap:publicHeap,graph,allocator:allocations,work:ALGORITHM_V8_LIMITS.work-budget.remaining};
}
export function checkAlgorithmV8Claims(core,args,claims,options={}){
  try{const result=evaluateAlgorithmV8(core,args,options);
    if(!isDeepStrictEqual(result.claims,claims))return {consistent:false,reason:'Computation, ordering, identity or completion mismatch'};
    return {consistent:true,completion:result.completion,graph:result.graph};
  }catch(error){return {consistent:false,reason:error.message,category:error.category??'guest-computation'};}
}
