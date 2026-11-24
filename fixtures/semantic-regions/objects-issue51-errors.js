// Engine diagnostics are derived from owned values without guest coercion.
export const issue51ErrorFixtures=Object.freeze([
  {id:'issue51-invalid-in-message-object-no-conversion',family:'issue51-intrinsic-error',
    source:'"use strict";function run(x){const events=[];const key={[Symbol.toPrimitive](){events.push("coerce");return "x";}};try{key in null;}catch(error){return [error.name,error.message,events];}}',entry:'run',args:[4]},
  {id:'issue51-invalid-in-message-symbol',family:'issue51-intrinsic-error',
    source:'"use strict";function run(x){const key=Symbol("key");try{key in Symbol.iterator;}catch(error){return error.message;}}',entry:'run',args:[4]},
  {id:'issue51-invalid-in-message-negative-zero',family:'issue51-intrinsic-error',
    source:'"use strict";function run(x){try{-0 in false;}catch(error){return error.message;}}',entry:'run',args:[4]},
  {id:'issue51-invalid-in-message-null-prototype',family:'issue51-intrinsic-error',
    source:'"use strict";function run(x){const key=Object.create(null);try{key in undefined;}catch(error){return error.message;}}',entry:'run',args:[4]}
].map(Object.freeze));
