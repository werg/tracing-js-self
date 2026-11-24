// Engine diagnostics are derived from owned values without guest coercion.
export const issue51ErrorFixtures=Object.freeze([
  {id:'issue51-invalid-in-message-object-no-conversion',family:'issue51-intrinsic-error',
    source:'"use strict";function run(x){const events=[];const key={[Symbol.toPrimitive](){events.push("coerce");return "x";}};try{key in null;}catch(error){return [error.name,error.message,events];}}',entry:'run',args:[4]},
  {id:'issue51-invalid-in-message-symbol',family:'issue51-intrinsic-error',
    source:'"use strict";function run(x){const key=Symbol("key");try{key in Symbol.iterator;}catch(error){return error.message;}}',entry:'run',args:[4]},
  {id:'issue51-invalid-in-message-negative-zero',family:'issue51-intrinsic-error',
    source:'"use strict";function run(x){try{-0 in false;}catch(error){return error.message;}}',entry:'run',args:[4]},
  {id:'issue51-invalid-in-message-null-prototype',family:'issue51-intrinsic-error',
    source:'"use strict";function run(x){const key=Object.create(null);try{key in undefined;}catch(error){return error.message;}}',entry:'run',args:[4]},
  {"id":"issue51-error-own-message-descriptor","family":"issue51-intrinsic-error","source":"\"use strict\";function run(x){try{\"x\" in null;}catch(error){const descriptor=Object.getOwnPropertyDescriptor(error,\"message\");return [Object.hasOwn(error,\"name\"),descriptor.enumerable,descriptor.writable,descriptor.configurable,error.name,Object.keys(error)];}}","entry":"run","args":[4]},
  {"id":"issue51-error-prototype-identities","family":"issue51-intrinsic-error","source":"\"use strict\";function run(x){try{\"x\" in null;}catch(error){return [Object.getPrototypeOf(error)===TypeError.prototype,error.constructor===TypeError,Object.getPrototypeOf(TypeError.prototype)===Error.prototype];}}","entry":"run","args":[4]},
  {"id":"issue51-error-instance-prototype-mutation","family":"issue51-intrinsic-error","source":"\"use strict\";function run(x){try{\"x\" in null;}catch(error){const parent={name:\"changed\",message:\"inherited\"};Object.setPrototypeOf(error,parent);delete error.message;error.extra=x;return [error.name,error.message,error.extra,Object.keys(error)];}}","entry":"run","args":[4]},
  {"id":"issue51-error-inherited-prototype-mutation","family":"issue51-intrinsic-error","source":"\"use strict\";function run(x){try{\"x\" in null;}catch(error){TypeError.prototype.name=\"later\";return [error.name,Object.hasOwn(error,\"name\")];}}","entry":"run","args":[4]},
  {"id":"issue51-error-accessor-receiver","family":"issue51-intrinsic-error","source":"\"use strict\";function run(x){try{\"x\" in null;}catch(error){let calls=0;Object.defineProperty(error,\"answer\",{get(){calls++;return this.message;},enumerable:true});return [error.answer,calls,Object.keys(error)];}}","entry":"run","args":[4]}
].map(Object.freeze));
