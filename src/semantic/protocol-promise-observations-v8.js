// Independent Promise identity and observable metadata. Internal settlement is
// checked by actual execution, call/completion order and the scheduler consumer;
// it is not invented as a descriptor visible to a JavaScript observer.
import {types} from 'node:util';
const profile='owned-promise-source/1';
export function createPromiseObservationAdapterV8({side}={}){
  let prototype=null,intrinsicThen=null,prototypeParent=null;
  return {id:profile,initializeRealm(evaluate){prototype=evaluate('Promise.prototype');
    intrinsicThen=Object.getOwnPropertyDescriptor(prototype,'then');prototypeParent=Object.getPrototypeOf(prototype);},
    metadataAdapter:{
      ownedType(value){return value[0]==='promise'?'reference':null;},
      ownedNode(value,ctx){
        if(value[0]!=='promise')return null;
        if(!ctx.state.promises[value[1]])ctx.fail('unallocated owned Promise identity');
        return {kind:'promise',prototype:'Promise.prototype',extensible:true,properties:[]};
      },
      nativeNode(value,ctx){
        if(!types.isPromise(value))return null;
        const then=prototype&&Object.getOwnPropertyDescriptor(prototype,'then');
        if(!prototype||Object.getPrototypeOf(value)!==prototype||
          Reflect.ownKeys(Object.getOwnPropertyDescriptors(value)).length||!Object.isExtensible(value)||
          Object.getPrototypeOf(prototype)!==prototypeParent||!then||!intrinsicThen||
          then.value!==intrinsicThen.value||then.get!==undefined||then.set!==undefined||
          then.writable!==intrinsicThen.writable||then.enumerable!==intrinsicThen.enumerable||then.configurable!==intrinsicThen.configurable)
          ctx.fail('Promise subclass or modified own state requires its declared profile');
        return {kind:'promise',prototype:'Promise.prototype',extensible:true,properties:[]};
      }
    }
  };
}
