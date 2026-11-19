// The algorithm core contains meanings and causal identities, never source sites.
// Runtime values use the same lossless scalar tags as execution evidence.
import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {OPERATION_REGISTRY} from './operations.js';

export const ALGORITHM_VERSION='semantic-algorithm/1';
export const ALGORITHM_PROFILE='ecmascript-primitive/1';
export const ALGORITHM_LIMITS=Object.freeze({steps:256,termNodes:512,depth:64,foldItems:128});
export const ALGORITHM_INPUT_TYPES=Object.freeze(['scalar','number','dense-number-array','data']);
const identifier=/^[A-Za-z_$][A-Za-z0-9_$:-]*$/;
const specialNumbers=new Set(['-0','NaN','+Infinity','-Infinity']);
const own=(value,key)=>Object.hasOwn(value,key);
// Validation of untrusted records must itself be effect-free. Inspect own
// descriptors before accessing fields; a Proxy is refused before any traps.
export function isAlgorithmDataRecord(value){
  if(value===null||typeof value!=='object'||types.isProxy(value)||Array.isArray(value)||
    ![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
  return keys.every(key=>typeof key==='string'&&own(descriptors[key],'value')&&descriptors[key].enumerable);
}
const plain=isAlgorithmDataRecord;

export function algorithmError(message){throw new TypeError('Invalid '+ALGORITHM_VERSION+': '+message);}
export function assertAlgorithmFields(value,fields,label='record'){
  if(!plain(value)||Object.keys(value).length!==fields.length||fields.some(key=>!own(value,key)))
    algorithmError(label+' fields');
}
export function assertAlgorithmId(id,label='identity'){
  if(typeof id!=='string'||!identifier.test(id))algorithmError(label);
  return id;
}
export function assertAlgorithmDataArray(value,label='array'){
  if(!Array.isArray(value)||types.isProxy(value)||Object.getPrototypeOf(value)!==Array.prototype)
    algorithmError(label+' must be an ordinary data array');
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
  if(keys.length!==value.length+1||keys.some(key=>typeof key!=='string')||
    Array.from({length:value.length},(_,i)=>String(i)).some(key=>
      !own(descriptors,key)||!own(descriptors[key],'value')))
    algorithmError(label+' must be dense data without hooks or extra properties');
  return value;
}
export function assertAlgorithmValue(value,{allowReference=true}={}){
  assertAlgorithmDataArray(value,'tagged value');
  const tag=value[0],arg=value[1];
  if(['undefined','null'].includes(tag)&&value.length===1)return value;
  if(value.length!==2)algorithmError('value arity');
  if(tag==='bool'&&typeof arg==='boolean'||tag==='str'&&typeof arg==='string')return value;
  if(tag==='bigint'&&typeof arg==='string'&&/^(?:0|-?[1-9][0-9]*)$/.test(arg))return value;
  if(tag==='num'&&(typeof arg==='number'&&Number.isFinite(arg)&&!Object.is(arg,-0)||specialNumbers.has(arg)))
    return value;
  if(tag==='ref'&&allowReference){assertAlgorithmId(arg,'value reference');return value;}
  algorithmError('noncanonical scalar or reference');
}

/** Validate structure and, when scopes are supplied, every def-use edge. */
export function validateTerm(term,{inputs=null,values=null,maxNodes=ALGORITHM_LIMITS.termNodes}={}){
  let nodes=0;
  const dependencies=new Set(),inputDependencies=new Set(),ancestors=new Set();
  function visit(node,depth=0){
    if(!plain(node)||++nodes>maxNodes||depth>ALGORITHM_LIMITS.depth||ancestors.has(node))
      algorithmError('term shape or budget');
    ancestors.add(node);
    if(node.op==='literal'){
      assertAlgorithmFields(node,['op','value'],'literal');assertAlgorithmValue(node.value);
    }else if(node.op==='input'||node.op==='ref'){
      assertAlgorithmFields(node,['op','id'],'dependency');assertAlgorithmId(node.id);
      const scope=node.op==='input'?inputs:values;
      if(scope&&!scope.has(node.id))algorithmError('unbound '+node.op+' '+node.id);
      (node.op==='input'?inputDependencies:dependencies).add(node.id);
    }else if(node.op==='project'){
      assertAlgorithmFields(node,['op','object','key'],'projection');
      if(typeof node.key!=='string'||node.key==='__proto__')algorithmError('data property key');
      visit(node.object,depth+1);
    }else if(node.op==='fold_left'){
      assertAlgorithmFields(node,['op','input','initial','step','order','profile'],'fold');
      if(node.step!=='add'||node.order!=='ascending'||node.profile!=='dense-number-array/1')
        algorithmError('ordered fold profile');
      visit(node.input,depth+1);visit(node.initial,depth+1);
    }else{
      const operation=own(OPERATION_REGISTRY,node.op)?OPERATION_REGISTRY[node.op]:null;
      if(!operation)algorithmError('unknown operation '+String(node.op));
      assertAlgorithmFields(node,['op','args'],'operation');
      assertAlgorithmDataArray(node.args,'operation arguments');
      if(node.args.length!==operation.arity)algorithmError('operation arity');
      for(const arg of node.args)visit(arg,depth+1);
    }
    ancestors.delete(node);
  }
  visit(term);
  return {nodes,dependencies:[...dependencies],inputs:[...inputDependencies]};
}

export function validateAlgorithm(core){
  assertAlgorithmFields(core,['schema','profile','inputs','steps'],'core');
  if(core.schema!==ALGORITHM_VERSION||core.profile!==ALGORITHM_PROFILE)
    algorithmError('version or semantic profile');
  assertAlgorithmDataArray(core.inputs,'inputs');assertAlgorithmDataArray(core.steps,'steps');
  if(core.inputs.length>128||
    !core.steps.length||core.steps.length>ALGORITHM_LIMITS.steps)algorithmError('core budget');
  const inputs=new Set(),values=new Set(),requests=new Set(),observed=new Set(),all=new Set();
  const declare=(id,scope)=>{assertAlgorithmId(id);if(all.has(id))algorithmError('duplicate identity '+id);
    all.add(id);scope.add(id);};
  for(const input of core.inputs){
    assertAlgorithmFields(input,['id','type'],'input');declare(input.id,inputs);
    if(!ALGORITHM_INPUT_TYPES.includes(input.type))algorithmError('input type');
  }
  const term=node=>validateTerm(node,{inputs,values});
  let terminated=false;
  for(const step of core.steps){
    if(terminated)algorithmError('work after completion');
    if(!plain(step))algorithmError('step');
    switch(step.kind){
      case 'compute':
        assertAlgorithmFields(step,['kind','id','term'],'compute');term(step.term);declare(step.id,values);break;
      case 'request':
        assertAlgorithmFields(step,['kind','id','boundary','operation','arguments'],'request');
        assertAlgorithmId(step.boundary,'effect boundary');
        if(typeof step.operation!=='string'||!step.operation||step.operation.length>256||
          !Array.isArray(step.arguments)||step.arguments.length>128)algorithmError('effect operation or arguments');
        assertAlgorithmDataArray(step.arguments,'effect arguments');
        step.arguments.forEach(term);declare(step.id,requests);break;
      case 'observe':
        assertAlgorithmFields(step,['kind','id','request'],'observation');
        if(!requests.has(step.request)||observed.has(step.request))algorithmError('observation correlation');
        observed.add(step.request);declare(step.id,values);break;
      case 'write':
        assertAlgorithmFields(step,['kind','object','key','value','present'],'visible write');
        if(typeof step.key!=='string'||step.key==='__proto__'||typeof step.present!=='boolean')
          algorithmError('visible property change');
        term(step.object);term(step.value);break;
      case 'return':case 'throw':
        assertAlgorithmFields(step,['kind','value'],'completion');term(step.value);terminated=true;break;
      case 'suspend':
        assertAlgorithmFields(step,['kind','requests','live'],'suspension');
        assertAlgorithmDataArray(step.requests,'pending requests');assertAlgorithmDataArray(step.live,'live values');
        if(!step.requests.length||new Set(step.requests).size!==step.requests.length||
          new Set(step.live).size!==step.live.length||
          step.requests.some(id=>!requests.has(id)||observed.has(id))||
          step.live.some(id=>!values.has(id)))algorithmError('live suspension interface');
        terminated=true;break;
      default:algorithmError('unknown step '+String(step.kind));
    }
  }
  if(!terminated)algorithmError('missing completion or suspension');
  return {inputs:inputs.size,values:values.size,requests:requests.size,steps:core.steps.length};
}

// Object-key order has no semantic authority; array/evaluation order does.
export function stableAlgorithmJSON(value){
  const seen=new Set();
  function order(node){
    if(node===null||typeof node==='string'||typeof node==='boolean')return node;
    if(typeof node==='number'&&Number.isFinite(node)&&!Object.is(node,-0))return node;
    if(typeof node!=='object'||seen.has(node))algorithmError('noncanonical JSON data');
    seen.add(node);
    let result;
    if(Array.isArray(node)){
      assertAlgorithmDataArray(node,'JSON array');
      result=node.map(order);
    }else{
      if(!plain(node))algorithmError('non-data JSON object');
      result=Object.fromEntries(Object.keys(node).sort().map(key=>[key,order(node[key])]));
    }
    seen.delete(node);return result;
  }
  return JSON.stringify(order(value));
}
export function canonicalAlgorithmString(core){validateAlgorithm(core);return stableAlgorithmJSON(core);}
export function algorithmDigest(core){return createHash('sha256').update(canonicalAlgorithmString(core)).digest('hex');}
