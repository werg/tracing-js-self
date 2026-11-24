// Deterministic descriptor/list algorithms over owned tagged values only.
// Reads may refuse until an accessor/Proxy continuation is explicitly owned.
const own=(o,k)=>Object.hasOwn(o,k);
export function compatibleProxyDescriptor(current,descriptor,extensible,eq){
  if(!current)return extensible;
  if(current.configurable)return true;
  if(descriptor.configurable||descriptor.enumerable!==current.enumerable||descriptor.kind!==current.kind)return false;
  if(current.kind==='accessor')return eq(current.get,descriptor.get)&&eq(current.set,descriptor.set);
  return current.writable||!descriptor.writable&&eq(current.value,descriptor.value);
}
export function readProxyDescriptor(value,api){
  const descriptor={};
  for(const field of ['enumerable','configurable','value','writable','get','set']){
    const selected=api.read(value,['str',field]);if(!selected.present)continue;
    const input=selected.value;
    if(['get','set'].includes(field)&&input[0]!=='undefined'&&!api.callable(input))
      throw new TypeError('Proxy descriptor accessor value requires its intrinsic invalid-callable fault');
    descriptor[field]=['enumerable','configurable','writable'].includes(field)?api.truthy(input):input;
  }
  const accessor=own(descriptor,'get')||own(descriptor,'set'),data=own(descriptor,'value')||own(descriptor,'writable');
  if(accessor&&data)throw new TypeError('Proxy descriptor mixed data/accessor requires its intrinsic fault');
  return accessor?{kind:'accessor',get:descriptor.get??['undefined'],set:descriptor.set??['undefined'],
    enumerable:descriptor.enumerable??false,configurable:descriptor.configurable??false}:
    {kind:'data',value:descriptor.value??['undefined'],writable:descriptor.writable??false,
      enumerable:descriptor.enumerable??false,configurable:descriptor.configurable??false};
}
export function proxyDescriptorFields(descriptor){
  return descriptor.kind==='accessor'?
    [['get',descriptor.get],['set',descriptor.set],['enumerable',['bool',descriptor.enumerable]],['configurable',['bool',descriptor.configurable]]]:
    [['value',descriptor.value],['writable',['bool',descriptor.writable]],['enumerable',['bool',descriptor.enumerable]],['configurable',['bool',descriptor.configurable]]];
}
export function proxyDescriptorTrapResult(returned,key,api){
  const display=api.display(key),prefix="'getOwnPropertyDescriptor' on proxy: ";
  if(!['ref','undefined','intrinsic'].includes(returned[0]))
    return {fault:prefix+"trap returned neither object nor undefined for property '"+display+"'"};
  const current=api.ownDescriptor(key);
  if(returned[0]==='undefined'){
    if(!current)return {value:['undefined']};
    if(!current.configurable)return {fault:prefix+"trap returned undefined for property '"+display+"' which is non-configurable in the proxy target"};
    if(!api.extensible())return {fault:prefix+"trap returned undefined for property '"+display+"' which exists in the non-extensible proxy target"};
    return {value:['undefined']};
  }
  const extensible=api.extensible(),descriptor=readProxyDescriptor(returned,api);
  if(!compatibleProxyDescriptor(current,descriptor,extensible,api.eq))
    return {fault:prefix+"trap returned descriptor for property '"+display+"' that is incompatible with the existing property in the proxy target"};
  if(!descriptor.configurable){
    if(!current||current.configurable)
      return {fault:prefix+"trap reported non-configurability for property '"+display+"' which is either non-existent or configurable in the proxy target"};
    if(descriptor.kind==='data'&&!descriptor.writable&&current.writable)
      return {fault:prefix+"trap reported non-configurable and non-writable for property '"+display+"' which is non-configurable, writable in the proxy target"};
  }
  return {descriptor};
}
function lengthValue(value){
  if(['ref','intrinsic','symbol'].includes(value[0]))throw new TypeError('Proxy ownKeys length conversion requires its explicit continuation');
  const number=value[0]==='undefined'?NaN:value[0]==='null'?0:value[0]==='bool'?Number(value[1]):
    value[0]==='bigint'?NaN:Number(value[1]);
  if(value[0]==='bigint')throw new TypeError('Proxy ownKeys BigInt length requires its intrinsic fault');
  const length=Number.isNaN(number)||number<=0?0:Math.min(Math.floor(number),9007199254740991);
  if(length>4096)throw new TypeError('Proxy ownKeys list exceeds bounded profile');return length;
}
function invalidKey(value){
  if(!['undefined','null','num','str','bool','bigint'].includes(value[0]))
    throw new TypeError('Proxy ownKeys invalid object key diagnostic requires explicit fault profile');
  return (['undefined','null'].includes(value[0])?value[0]:String(value[1]))+' is not a valid property name';
}
export function proxyOwnKeysTrapResult(returned,api){
  if(!['ref','intrinsic'].includes(returned[0]))return {fault:'CreateListFromArrayLike called on non-object'};
  const length=lengthValue(api.read(returned,['str','length']).value),keys=[];
  for(let index=0;index<length;index++){
    const value=api.read(returned,['str',String(index)]).value;
    if(!['str','symbol'].includes(value[0]))return {fault:invalidKey(value)};keys.push(value);
  }
  if(keys.some((key,index)=>keys.slice(0,index).some(other=>api.eq(key,other))))
    return {fault:"'ownKeys' on proxy: trap returned duplicate entries"};
  const extensible=api.extensible(),targetKeys=api.keys(),nonconfigurable=[],configurable=[];
  for(const key of targetKeys)(api.ownDescriptor(key)?.configurable===false?nonconfigurable:configurable).push(key);
  const unchecked=keys.slice();
  for(const key of [...nonconfigurable,...(extensible?[]:configurable)]){
    const index=unchecked.findIndex(other=>api.eq(key,other));
    if(index<0)return {fault:"'ownKeys' on proxy: trap result did not include '"+api.display(key)+"'"};
    unchecked.splice(index,1);
  }
  if(!extensible&&unchecked.length)return {fault:"'ownKeys' on proxy: trap returned extra keys but proxy target is non-extensible"};
  return {keys};
}
