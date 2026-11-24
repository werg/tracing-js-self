// Original-source reflection cases; inputs stay frozen once admitted.
export const issue51ProxyReflectionFixtures=Object.freeze([
  {
    "id": "issue51-proxy-get-prototype-alias",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const target={};const proto={x:1};const proxy=new Proxy(target,{getPrototypeOf(t){return proto;}});return Object.getPrototypeOf(proxy)===proto;}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-extensible-live-target",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const target={};const proxy=new Proxy(target,{isExtensible(t){Object.preventExtensions(t);return 0;}});return [Object.isExtensible(proxy),Object.isExtensible(target)];}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-prevent-extensions-mutation",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const target={};const proxy=new Proxy(target,{preventExtensions(t){Object.preventExtensions(t);return 1;}});return [Object.preventExtensions(proxy)===proxy,Object.isExtensible(target)];}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-set-prototype-mutation",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const target={};const proto={x:1};const proxy=new Proxy(target,{setPrototypeOf(t,p){Object.setPrototypeOf(t,p);return true;}});return [Object.setPrototypeOf(proxy,proto)===proxy,Object.getPrototypeOf(target)===proto];}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-transparent-prototype-extensibility",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const proxy=new Proxy({},{});const proto={};Object.setPrototypeOf(proxy,proto);Object.preventExtensions(proxy);return [Object.getPrototypeOf(proxy)===proto,Object.isExtensible(proxy)];}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-isextensible-invariant-fault",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const proxy=new Proxy({}, {isExtensible(t){return false;}});try{return Object.isExtensible(proxy);}catch(error){return [error.name,error.message];}}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-reflect-false-mutators",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const proxy=new Proxy({}, {preventExtensions(){return false;},setPrototypeOf(){return false;}});return [Reflect.preventExtensions(proxy),Reflect.setPrototypeOf(proxy,null)];}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-get-prototype-invalid-result",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){let calls=0;const proxy=new Proxy({}, {getPrototypeOf(){calls++;return x;}});try{Object.getPrototypeOf(proxy);}catch(error){return [calls,error.message];}}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-get-prototype-frozen-mutation",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const target={};const proto={};const proxy=new Proxy(target,{getPrototypeOf(t){Object.setPrototypeOf(t,proto);Object.preventExtensions(t);return proto;}});return Object.getPrototypeOf(proxy)===proto;}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-prevent-extensions-invariant-fault",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){let calls=0;const proxy=new Proxy({}, {preventExtensions(){calls++;return true;}});try{Object.preventExtensions(proxy);}catch(error){return [calls,error.message];}}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-set-prototype-object-false",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const proxy=new Proxy({}, {setPrototypeOf(){return false;}});try{Object.setPrototypeOf(proxy,null);}catch(error){return error.message;}}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-reflection-trap-retained-selection",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){let calls=0;const handler={isExtensible(t){calls++;handler.isExtensible=null;return Object.isExtensible(t);}};const proxy=new Proxy({},handler);return [Object.isExtensible(proxy),Object.isExtensible(proxy),calls];}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-descriptor-result",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const target={x:1};const proxy=new Proxy(target,{getOwnPropertyDescriptor(t,k){return {value:t[k]+1,writable:true,enumerable:true,configurable:true};}});const d=Object.getOwnPropertyDescriptor(proxy,\"x\");return [d.value,d.writable,d.enumerable,d.configurable];}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-ownkeys-symbol-order",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const symbol=Symbol(\"key\");const target={a:1,b:2,[symbol]:3};const proxy=new Proxy(target,{ownKeys(t){return [symbol,\"b\",\"a\"];}});const keys=Reflect.ownKeys(proxy);return [keys[0]===symbol,keys[1],keys[2]];}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-descriptor-live-invariant",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const target={x:1};const proxy=new Proxy(target,{getOwnPropertyDescriptor(t,k){Object.defineProperty(t,k,{value:2,writable:false,configurable:false});return {value:2};}});return Object.getOwnPropertyDescriptor(proxy,\"x\").value;}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-descriptor-hide-fixed",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const target={};Object.defineProperty(target,\"x\",{value:1});const proxy=new Proxy(target,{getOwnPropertyDescriptor(){return undefined;}});try{Object.getOwnPropertyDescriptor(proxy,\"x\");}catch(error){return error.message;}}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-ownkeys-missing-fixed",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const target={};Object.defineProperty(target,\"x\",{value:1});const proxy=new Proxy(target,{ownKeys(){return [];}});try{Reflect.ownKeys(proxy);}catch(error){return error.message;}}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-descriptor-ownkeys-forward",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const proxy=new Proxy({x:1},{});return [Reflect.ownKeys(proxy),Object.getOwnPropertyDescriptor(proxy,\"x\").value,Object.getOwnPropertyDescriptor(proxy,\"missing\")];}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-ownkeys-arraylike",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const proxy=new Proxy({a:1,b:2},{ownKeys(){return {0:\"b\",1:\"a\",length:2};}});return Reflect.ownKeys(proxy);}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-ownkeys-duplicate",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const proxy=new Proxy({}, {ownKeys(){return [\"x\",\"x\"];}});try{Reflect.ownKeys(proxy);}catch(error){return error.message;}}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-ownkeys-nonextensible-extra",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const target={};Object.preventExtensions(target);const proxy=new Proxy(target,{ownKeys(){return [\"x\"];}});try{Reflect.ownKeys(proxy);}catch(error){return error.message;}}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-descriptor-invented-fixed",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const proxy=new Proxy({}, {getOwnPropertyDescriptor(){return {value:x};}});try{Object.getOwnPropertyDescriptor(proxy,\"x\");}catch(error){return error.message;}}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-descriptor-accessor-result",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){function getter(){return 3;}const proxy=new Proxy({}, {getOwnPropertyDescriptor(){return {get:getter,enumerable:true,configurable:true};}});const d=Object.getOwnPropertyDescriptor(proxy,\"x\");return [d.get===getter,d.set===undefined,d.enumerable,d.configurable];}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-definition-from-descriptor",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const target={};let seen=[];const proxy=new Proxy(target,{defineProperty(t,k,d){seen=[k,Object.keys(d),d.value];Object.defineProperty(t,k,d);return 1;}});const result=Object.defineProperty(proxy,\"x\",{value:7,writable:true,configurable:true});return [result===proxy,target.x,seen];}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-definition-reflect-false",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const proxy=new Proxy({}, {defineProperty(){return false;}});return Reflect.defineProperty(proxy,\"x\",{value:1});}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-definition-object-false",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const proxy=new Proxy({}, {defineProperty(){return false;}});try{Object.defineProperty(proxy,\"x\",{value:1});}catch(error){return error.message;}}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-definition-nonextensible-fault",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const target={};Object.preventExtensions(target);const proxy=new Proxy(target,{defineProperty(){return true;}});try{Reflect.defineProperty(proxy,\"x\",{value:1});}catch(error){return error.message;}}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-definition-copy-mutation",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const target={};Object.defineProperty(target,\"x\",{value:1,writable:true});const proxy=new Proxy(target,{defineProperty(t,k,d){d.writable=true;return true;}});try{Reflect.defineProperty(proxy,\"x\",{writable:false});}catch(error){return error.message;}}",
    "entry": "run",
    "args": [
      4
    ]
  },
  {
    "id": "issue51-proxy-definition-forward-omitted-fields",
    "family": "issue51-proxy-reflection",
    "source": "\"use strict\";function run(x){const target={x:1};const proxy=new Proxy(target,{});Object.defineProperty(proxy,\"x\",{enumerable:false});return [target.x,Object.keys(target),Reflect.defineProperty(proxy,\"y\",{value:3}),target.y];}",
    "entry": "run",
    "args": [
      4
    ]
  }
].map(Object.freeze));
