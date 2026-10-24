// Permanent owned sources for semantic completion and observable-boundary
// differential regression. Arguments are constructors, not JSON snapshots:
// aliases, holes and null prototypes must remain representable.
export const semanticBoundaryCases=Object.freeze([
  {
    name:'arithmetic',family:'scalar-arithmetic',
    source:'"use strict";function run(x){return x*2+1;}',
    args:()=>[7],expected:15
  },
  {
    name:'sum-uncaptured-loop',family:'uncaptured-loop',
    source:'"use strict";function run(a){let sum=0;for(let i=0;i<a.length;i++)sum+=a[i];return sum;}',
    args:()=>[[2,3,4]],expected:9
  },
  {
    name:'return-through-finally',family:'finalizer',
    source:'"use strict";function run(o){try{return o.n;}finally{o.n+=3;}}',
    args:()=>[{n:2}],expected:2,expectedArgument:{n:5}
  },
  {
    name:'return-replaced-by-finally',family:'finalizer',
    source:'"use strict";function run(o){try{return o.n;}finally{o.n+=3;return o.n;}}',
    args:()=>[{n:2}],expected:5,expectedArgument:{n:5}
  },
  {
    name:'throw-caught-finally',family:'catch-finally',
    source:'"use strict";function run(o){try{throw 7;}catch(e){o.n+=e;}finally{o.n+=1;}return o.n;}',
    args:()=>[{n:2}],expected:10,expectedArgument:{n:10}
  },
  {
    name:'alias-state',family:'aliasing',
    source:'"use strict";function run(o){const x=o;o.n+=3;return [o,x];}',
    args:()=>[{n:4}],expectedArgument:{n:7}
  },
  {
    name:'getter-with-side-effects',family:'accessor',
    source:'"use strict";function run(){let n=0;const o={get x(){n++;return n;}};return o.x+o.x+n;}',
    args:()=>[],expected:5
  },
  {
    name:'sparse-hole',family:'sparse-data',
    source:'"use strict";function run(a){return [a.length,Object.hasOwn(a,"0"),Object.hasOwn(a,"1"),a[1]===undefined];}',
    args:()=>{const a=new Array(2);a[1]=undefined;return [a];},
    expected:[2,false,true,true]
  },
  {
    name:'null-prototype',family:'null-prototype-data',
    source:'"use strict";function run(o){o.n+=1;return o;}',
    args:()=>{const o=Object.create(null);o.n=4;return [o];},
    expectedArgument:{n:5}
  },
  {
    name:'map-mutation-next-input',family:'callback-effect',
    source:'"use strict";function run(a){return a.map((x,i)=>{if(i===0)a[1]=50;return x;});}',
    args:()=>[[1,2,3]],expected:[1,50,3],expectedArgument:[1,50,3]
  }
]);
