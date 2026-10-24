// Browser-safe, bounded owned VM entry; no native Node host adapters or
// callable-folder natlang bridge. Archives require independent Node auditing.
import {createRuntime as createOwnedRuntime} from './runtime.js';
export {encode,decode} from './values.js';
export {causalPrefix} from './causal.js';

export function createRuntime(options={}) {
  if(!options || typeof options!=='object' || Array.isArray(options))
    throw new TypeError('Browser runtime options must be a record');
  // Configuration is a host boundary: never invoke accessors while reading it.
  // Reject inherited values too, so prototypes cannot silently grant options.
  if(Object.getPrototypeOf(options)!==Object.prototype &&
     Object.getPrototypeOf(options)!==null)
    throw new TypeError('Browser runtime options must be a plain record');
  const settings=Object.create(null);
  for(const key of Reflect.ownKeys(options)) {
    if(!['maxSteps','randomSeed'].includes(key))
      throw new TypeError('Unsupported browser runtime option: '+String(key));
    const descriptor=Object.getOwnPropertyDescriptor(options,key);
    if(!descriptor || !Object.hasOwn(descriptor,'value'))
      throw new TypeError('Browser runtime options must be own data properties');
    settings[key]=descriptor.value;
  }
  const {maxSteps=100000,randomSeed=null}=settings;
  if(!Number.isSafeInteger(maxSteps)||maxSteps<1||maxSteps>100000)
    throw new RangeError('Browser step budget must be from 1 to 100000');
  const runtime=createOwnedRuntime({maxSteps,randomSeed});
  // Block the mutable host-adapter escape hatch on the generic Runtime class.
  Object.defineProperty(runtime,'adapters',{
    value:Object.freeze(Object.create(null)),
    writable:false,enumerable:true,configurable:false
  });
  return runtime;
}
