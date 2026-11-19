// Versioned source families. All relatives share a family identity for dataset
// splitting; syntax holdouts are not advertised as new algorithm holdouts.
const source=body=>'"use strict";'+body;
const variant=(id,body)=>({id,entry:'run',source:source(body)});

export const SEMANTIC_EQUIVALENCE_FAMILIES=Object.freeze([
  {id:'pairwise-arithmetic/1',domain:'Four binary64 numbers; retain the original operation tree.',
    inputTypes:['number','number','number','number'],
    description:'Add the first pair and second pair, multiply those results, then add one.',
    variants:[
      variant('expression','function run(a,b,c,d){return (a+b)*(c+d)+1;}'),
      variant('renamed','function run(w,x,y,z){return (w+x)*(y+z)+1;}'),
      variant('temporaries','function run(a,b,c,d){const left=a+b;const right=c+d;const product=left*right;return product+1;}'),
      variant('helpers','function pair(x,y){return x+y;}function multiply(x,y){return x*y;}function run(a,b,c,d){return multiply(pair(a,b),pair(c,d))+1;}')
    ],cases:[[1,2,3,4],[0,-0,0,-0],[1e16,1,-1e16,1],[NaN,1,2,3],[Infinity,0,1,-1]]},
  {id:'ordered-numeric-sum/1',domain:'One ordinary dense array of at most 128 finite binary64 numbers; no custom properties or iterator.',
    inputTypes:['dense-number-array'],
    description:'Starting at positive zero, add every number in ascending array order.',
    variants:[
      variant('indexed-for','function run(xs){let total=0;for(let i=0;i<xs.length;i++){total+=xs[i];}return total;}'),
      variant('while','function run(values){let answer=0;let index=0;while(index<values.length){answer=answer+values[index];index++;}return answer;}'),
      variant('for-of','function run(numbers){let sum=0;for(const number of numbers){sum+=number;}return sum;}'),
      variant('temporary-step','function run(xs){const values=xs;let answer=0;for(let position=0;position<values.length;position+=1){const item=values[position];const next=answer+item;answer=next;}const result=answer;return result;}'),
      variant('helper-step','function add(left,right){const next=left+right;return next;}function run(values){let sum=0;for(const item of values){sum=add(sum,item);}return sum;}'),
      variant('helper-traversal','function sum(values){let result=0;for(let i=0;i<values.length;++i){result+=values[i];}return result;}function run(numbers){return sum(numbers);}')
    ],cases:[[[]],[[7]],[[-0]],[[2,3,4]],[[1e16,1,-1e16]],[[1e16,-1e16,1]],[[Number.MAX_VALUE,Number.MAX_VALUE]],[[Number.MIN_VALUE,-Number.MIN_VALUE,-0]]]},
  {id:'private-object-increment/1',domain:'No inputs; fresh ordinary private data with no escape, hooks, or retained observer.',inputTypes:[],
    description:'Add one to two and return the result; the temporary storage object is private.',
    variants:[
      variant('scalar','function run(){return 2+1;}'),
      variant('temporary','function run(){const previous=2;const next=previous+1;return next;}'),
      variant('object-alias','function run(){const box={n:2};const alias=box;alias.n=alias.n+1;return box.n;}'),
      variant('object-compound','function run(){const storage={value:2};storage.value+=1;return storage.value;}')
    ],cases:[[]]},
  {id:'pure-selection/1',domain:'Three primitive scalar inputs; preserve the predicate and lazy alternatives.',inputTypes:['scalar','scalar','scalar'],
    description:'Return the second input when the first input is truthy, otherwise return the third.',
    variants:[
      variant('ternary','function run(test,left,right){return test?left:right;}'),
      variant('if-else','function run(condition,yes,no){if(condition){return yes;}else{return no;}}'),
      variant('early-return','function run(condition,yes,no){if(condition)return yes;return no;}')
    ],cases:[[true,1,2],[false,1,2],[0,'yes','no'],['',undefined,null],['truthy',-0,0]]}
]);

export const SEMANTIC_EQUIVALENCE_NEGATIVES=Object.freeze([
  {id:'different-tree-same-sample',left:source('function run(a,b){return a+b;}'),
    right:source('function run(a,b){return a*b;}'),entry:'run',args:[2,2],expect:'distinct',
    reason:'A coincident answer does not establish the same computation.'},
  {id:'floating-point-reassociation',left:source('function run(a,b,c){return (a+b)+c;}'),
    right:source('function run(a,b,c){return a+(b+c);}'),entry:'run',args:[1e16,-1e16,1],expect:'distinct',
    reason:'Binary64 addition may not be reassociated.'},
  {id:'reverse-traversal',source:source('function run(xs){let s=0;for(let i=xs.length-1;i>=0;i--){s+=xs[i];}return s;}'),expect:'refused'},
  {id:'loop-input-mutation',source:source('function run(xs){let s=0;for(let i=0;i<xs.length;i++){s+=xs[i];xs[i]=0;}return s;}'),expect:'refused'},
  {id:'loop-extra-index-update',source:source('function run(xs){let s=0;for(let i=0;i<xs.length;i++){s+=xs[i];i++;}return s;}'),expect:'refused'},
  {id:'loop-reset-accumulator',source:source('function run(xs){let s=0;for(const x of xs){s=0;s+=x;}return s;}'),expect:'refused'},
  {id:'loop-wrong-accumulator',source:source('function run(xs){let s=0;let z=0;for(const x of xs){s=z+x;}return s;}'),expect:'refused'},
  {id:'reduce-without-initial',source:source('function run(xs){return xs.reduce((a,b)=>a+b);}'),expect:'refused'},
  {id:'returned-private-object',source:source('function run(){const box={n:2};box.n++;return box;}'),expect:'refused'},
  {id:'input-object-write',source:source('function run(box){box.n++;return box.n;}'),expect:'refused'},
  {id:'effect-exposed-object',source:source('function run(){const box={n:2};host.store("box",box);return box.n;}'),expect:'refused'},
  {id:'captured-private-object',source:source('function run(){const box={n:2};return ()=>box.n;}'),expect:'refused'},
  {id:'getter-hook',source:source('function run(){const box={get n(){return 2;}};return box.n+1;}'),expect:'refused'},
  {id:'inherited-property',source:source('function run(){const box={};return box.toString;}'),expect:'refused'},
  {id:'throwing-dead-work',source:source('function run(){const unused=1n/0n;return 3;}'),expect:'refused'},
  {id:'rng-dead-work',source:source('function run(){const unused=Math.random();return 3;}'),expect:'refused'},
  {id:'recursive-dead-work',source:source('function forever(){return forever();}function run(){forever();return 3;}'),expect:'refused'},
  {id:'shadowed-helper',source:source('function add(a,b){return a+b;}function run(add){return add(1,2);}'),expect:'refused'},
  {id:'helper-capture',source:source('function helper(x){return x+captured;}function run(x){const captured=1;return helper(x);}'),expect:'refused'},
  {id:'lexical-temporal-dead-zone',source:source('function run(){const x=1;{const x=x+1;return x;}}'),expect:'refused'},
  {id:'helper-temporal-dead-zone',source:source('function helper(){return 1;}function run(){const value=helper();const helper=2;return value;}'),expect:'refused'},
  {id:'block-temporal-dead-zone',source:source('function run(x){{const y=x;let x=2;return y;}}'),expect:'refused'},
  {id:'unreachable-lexical-shadow',source:source('function run(x){{return x;let x=2;}}'),expect:'refused'},
  {id:'lazy-private-write',source:source('function run(test,x){return test?(x=1):x;}'),expect:'refused'},
  {id:'short-circuit-private-write',source:source('function run(test,x){const y=test&&(x=1);return x;}'),expect:'refused'},
  {id:'selection-state-join',source:source('function run(test){let x=0;if(test){{x=1;return x;}}else{return x;}}'),expect:'refused'},
  {id:'changed-effect',source:source('function run(){host.store("counter",3);return 3;}'),expect:'refused'},
  {id:'finally-cleanup',source:source('function run(){try{return 3;}finally{host.store("cleanup",1);}}'),expect:'refused'}
]);
