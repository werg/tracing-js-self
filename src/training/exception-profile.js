// Explicit exception observation contract. Native Error prototypes, stacks,
// causes, accessors and user extensions are not silently flattened into data.
import {types} from 'node:util';
import {describeGraph} from './graph.js';

export const DECLARED_EXCEPTION_PROFILE='declared-error/name-message/1';

export function describeCompletionGraph(args,value,kind){
  if(kind==='throw'&&types.isNativeError(value)&&!types.isProxy(value)){
    const prototype=Object.getPrototypeOf(value);
    const name=Object.getOwnPropertyDescriptor(prototype,'name')?.value;
    if(!['Error','TypeError','ReferenceError','RangeError','SyntaxError','URIError','EvalError'].includes(name))
      throw new TypeError('Unsupported exception boundary: custom Error prototype');
    const constructor=Object.getOwnPropertyDescriptor(prototype,'constructor')?.value;
    if(Object.getOwnPropertyDescriptor(constructor??{},'name')?.value!==name)
      throw new TypeError('Unsupported exception boundary: custom Error constructor');
    if(!Object.isExtensible(value))throw new TypeError('Unsupported exception boundary: frozen Error');
    for(const key of Reflect.ownKeys(value)){
      if(key!=='stack'&&key!=='message')
        throw new TypeError('Unsupported exception boundary: Error extensions');
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      // V8 may implement stack with an accessor. It is deliberately ignored
      // and never invoked; every observed message must be an own data field.
      if(key==='message'&&(!Object.hasOwn(descriptor,'value')||
        typeof descriptor.value!=='string'||descriptor.enumerable||
        !descriptor.writable||!descriptor.configurable))
        throw new TypeError('Unsupported exception boundary: Error message descriptor');
    }
    const message=Object.getOwnPropertyDescriptor(value,'message')?.value??'';
    return describeGraph([...args,{name,message}]);
  }
  return describeGraph([...args,value]);
}
