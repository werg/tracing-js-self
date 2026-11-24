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
  }
].map(Object.freeze));
