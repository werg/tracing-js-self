// Authored source-task families are fixed before any split is inspected. Every
// family remains in the recipe, including held-out ones; expression formatting,
// input variants, callback schedules, recovery and child wrappers inherit its
// identity. Sharing collection scaffolding does not manufacture new ancestry.
export const SEMANTIC_RECIPE_VERSION='semantic-source-recipe/4';
export const SEMANTIC_RECIPE_NAME='training-v4';

export const SEMANTIC_TASK_TEMPLATES=Object.freeze([
  {name:'rectangle-perimeter',expression:'(a+b)*2',answers:[22,14]},
  {name:'rectangular-capacity',expression:'a*b',answers:[24,10]},
  {name:'squared-distance',expression:'a*a+b*b',answers:[73,29]},
  {name:'absolute-distance',expression:'a>b?a-b:b-a',answers:[5,3]},
  {name:'weighted-average',expression:'(a*2+b*3)/5',answers:[5,3.2]},
  {name:'unit-conversion',expression:'a*1000/b',answers:[8000/3,2500]},
  {name:'triangular-series',expression:'a*(a+1)/2+b',answers:[39,17]},
  {name:'modular-clock',expression:'(a*60+b)%24',answers:[3,14]},
  {name:'flag-intersection',expression:'a&b',answers:[0,0]},
  {name:'flag-union',expression:'a|b',answers:[11,7]},
  {name:'inventory-shortfall',expression:'a>b?a-b:0',answers:[5,3]},
  {name:'capped-budget',expression:'a+b>10?10:a+b',answers:[10,7]},
  {name:'overtime-rate',expression:'a>6?6*b+(a-6)*b*2:a*b',answers:[30,10]},
  {name:'midpoint',expression:'(a+b)/2',answers:[5.5,3.5]},
  {name:'relative-growth',expression:'(a-b)/b',answers:[5/3,1.5]},
  {name:'parity-adjustment',expression:'a%2===0?a+b:a-b',answers:[11,3]}
].map(template=>Object.freeze({...template,answers:Object.freeze(template.answers)})));

const inputs=Object.freeze([[8,3],[5,2]].map(Object.freeze));
export function semanticRecipeFamilies({representation='explicit'}={}){
  if(!['explicit','compact'].includes(representation))throw new TypeError('Unknown recipe representation');
  return SEMANTIC_TASK_TEMPLATES.map(template=>{
    const family='semantic-recipe:'+template.name;
    const common={family,ancestorIds:['source-template:'+template.name],entry:'run',
      projectionOptions:{representation}};
    const source='"use strict";async function run(key,b){const a=await host.readAsync(key);'+
      'const answer='+template.expression+';host.store(key,answer);return answer;}';
    const calls=inputs.map(([a,b],index)=>({...common,id:template.name+'-call-'+index,
      source,args:[template.name,b],fixture:{calls:[
        {operation:'demo.readAsync',arguments:[template.name],result:a},
        {operation:'demo.store',arguments:[template.name,template.answers[index]]}
      ]}}));
    return {family,template:template.name,
      pure:{...common,id:template.name+'-pure',args:inputs[0],
        source:'"use strict";function run(a,b){return '+template.expression+';}',fixture:{calls:[]}},
      callbacks:{...common,id:template.name+'-callbacks-recovery',args:[template.name,inputs[0][1]],
        source:'"use strict";async function run(key,b){const a=await host.readAsync(key);'+
          'let answer='+template.expression+';await host.withCallback(key,function(delta){'+
          'answer=answer+delta;host.store(key,answer);});return answer;}',
        projectionOptions:{representation,checkpointAtFirstAwait:true},fixture:{calls:[
          {operation:'demo.readAsync',arguments:[template.name],result:inputs[0][0]},
          {operation:'demo.withCallback',arguments:[template.name,{callback:true}],callbacks:[
            {slot:1,arguments:[2]},{slot:1,arguments:[3]}]},
          {operation:'demo.store',arguments:[template.name,template.answers[0]+2]},
          {operation:'demo.store',arguments:[template.name,template.answers[0]+5]}
        ]}},
      repeated:{id:template.name+'-repeated',family,cases:calls}
    };
  });
}

// Bounded loop/array algorithms are authored as program bodies. The fixture
// oracle below runs these declarations only to construct external observations;
// source labels still come from the normal independent admission pipeline.
export const BENCHMARK_RECIPE_NAME='benchmark-v1';
export const BENCHMARK_RECIPE_VERSION='semantic-source-benchmark/1';
export const BENCHMARK_ALGORITHMS=Object.freeze([
 {name:'euclidean-gcd',body:'let x=a;let y=b;while(y!==0){const r=x%y;x=y;y=r;}return x;',inputs:[[48,18],[84,30]]},
 {name:'least-common-multiple',body:'let x=a;let y=b;let p=x*y;while(y!==0){const r=x%y;x=y;y=r;}return p/x;',inputs:[[12,18],[15,20]]},
 {name:'factorial-iterative',body:'let n=a;let out=1;while(n>1){out=out*n;n=n-1;}return out+b;',inputs:[[6,1],[5,2]]},
 {name:'fibonacci-iterative',body:'let n=a;let x=0;let y=1;while(n>0){const z=x+y;x=y;y=z;n=n-1;}return x+b;',inputs:[[8,1],[7,2]]},
 {name:'power-squaring',body:'let base=a;let exp=b;let out=1;while(exp>0){if(exp%2===1)out=out*base;base=base*base;exp=exp>>1;}return out;',inputs:[[3,5],[2,7]]},
 {name:'sum-digits',body:'let n=a;let total=0;while(n>0){total=total+n%10;n=Math.floor(n/10);}return total+b;',inputs:[[472,2],[583,1]]},
 {name:'count-digits',body:'let n=a;let count=0;while(n>0){count=count+1;n=Math.floor(n/10);}return count+b;',inputs:[[472,1],[583,2]]},
 {name:'reverse-digits',body:'let n=a;let out=0;while(n>0){out=out*10+n%10;n=Math.floor(n/10);}return out+b;',inputs:[[472,3],[583,4]]},
 {name:'population-count',body:'let n=a;let count=0;while(n!==0){count=count+(n&1);n=n>>>1;}return count+b;',inputs:[[45,1],[29,2]]},
 {name:'trailing-zero-count',body:'let n=a;let count=0;while(n>0&&n%2===0){count=count+1;n=n/2;}return count+b;',inputs:[[40,1],[24,2]]},
 {name:'hamming-distance',body:'let n=a^b;let count=0;while(n!==0){count=count+(n&1);n=n>>>1;}return count;',inputs:[[45,27],[31,7]]},
 {name:'gray-code',body:'return (a^(a>>1))+b;',inputs:[[13,2],[21,1]]},
 {name:'integer-square-root',body:'let x=0;while((x+1)*(x+1)<=a){x=x+1;}return x+b;',inputs:[[99,2],[80,1]]},
 {name:'repeated-subtraction-division',body:'let n=a;let q=0;while(n>=b){n=n-b;q=q+1;}return q*10+n;',inputs:[[47,6],[38,5]]},
 {name:'modular-exponentiation',body:'let base=a;let exp=b;let out=1;while(exp>0){if(exp%2===1)out=(out*base)%97;base=(base*base)%97;exp=exp>>1;}return out;',inputs:[[7,13],[5,11]]},
 {name:'prime-count-to-bound',body:'let n=a;let count=0;let x=2;while(x<=n){let prime=true;let d=2;while(d*d<=x){if(x%d===0)prime=false;d=d+1;}if(prime)count=count+1;x=x+1;}return count+b;',inputs:[[6,1],[7,2]]},
 {name:'array-sum',body:'let i=0;let total=0;while(i<a.length){total=total+a[i];i=i+1;}return total+b;',inputs:[[[2,5,1,4],3],[[3,1,6],2]]},
 {name:'array-minimum',body:'let i=1;let low=a[0];while(i<a.length){if(a[i]<low)low=a[i];i=i+1;}return low+b;',inputs:[[[7,2,9,4],1],[[8,3,6],2]]},
 {name:'array-argmax',body:'let i=1;let best=0;while(i<a.length){if(a[i]>a[best])best=i;i=i+1;}return best+b;',inputs:[[[7,2,9,4],1],[[8,3,6],2]]},
 {name:'array-dot-product',body:'let i=0;let total=0;while(i<a.length){total=total+a[i]*b[i];i=i+1;}return total;',inputs:[[[2,3,1],[4,2,5]],[[1,4,2],[3,2,6]]]},
 {name:'count-in-range',body:'let i=0;let count=0;while(i<a.length){if(a[i]>=b[0]&&a[i]<=b[1])count=count+1;i=i+1;}return count;',inputs:[[[1,5,3,8,4],[3,6]],[[2,7,4],[2,5]]]},
 {name:'longest-equal-run',body:'let i=1;let run=1;let best=a.length===0?0:1;while(i<a.length){if(a[i]===a[i-1])run=run+1;else run=1;if(run>best)best=run;i=i+1;}return best+b;',inputs:[[[2,2,2,1,1],1],[[3,3,4],2]]},
 {name:'array-palindrome',body:'let i=0;let ok=1;while(i<a.length/2){if(a[i]!==a[a.length-1-i])ok=0;i=i+1;}return ok+b;',inputs:[[[1,2,3,2,1],2],[[4,5,5,4],1]]},
 {name:'binary-search-index',body:'let lo=0;let hi=a.length-1;let found=-1;while(lo<=hi){let mid=Math.floor((lo+hi)/2);if(a[mid]===b)found=mid;if(a[mid]<b)lo=mid+1;else hi=mid-1;}return found;',inputs:[[[1,3,5,7,9],7],[[2,4,6,8],5]]},
 {name:'inversion-count',body:'let i=0;let count=0;while(i<a.length){let j=i+1;while(j<a.length){if(a[i]>a[j])count=count+1;j=j+1;}i=i+1;}return count+b;',inputs:[[[4,1,3,2],1],[[5,2,1],2]]},
 {name:'kadane-maximum-subarray',body:'let i=0;let ending=0;let best=a[0];while(i<a.length){if(ending<0)ending=0;ending=ending+a[i];if(ending>best)best=ending;i=i+1;}return best+b;',inputs:[[[-2,3,-1,4,-5],2],[[-3,4,-2,5],1]]},
 {name:'single-transaction-profit',body:'let i=1;let low=a[0];let best=0;while(i<a.length){if(a[i]-low>best)best=a[i]-low;if(a[i]<low)low=a[i];i=i+1;}return best+b;',inputs:[[[7,1,5,3,6,4],1],[[5,2,8,1],2]]}
 ,{name:'array-maximum',body:'let i=1;let high=a[0];while(i<a.length){if(a[i]>high)high=a[i];i=i+1;}return high+b;',inputs:[[[4,9,2,7],1],[[3,8,1],2]]}
 ,{name:'second-largest-distinct',body:'let i=0;let high=-1000000;let second=-1000000;while(i<a.length){if(a[i]>high){second=high;high=a[i];}else if(a[i]>second&&a[i]!==high)second=a[i];i=i+1;}return second+b;',inputs:[[[4,9,2,7],1],[[3,8,1],2]]}
 ,{name:'count-positive',body:'let i=0;let count=0;while(i<a.length){if(a[i]>0)count=count+1;i=i+1;}return count+b;',inputs:[[[-2,3,0,5],1],[[-1,4,6],2]]}
 ,{name:'count-negative',body:'let i=0;let count=0;while(i<a.length){if(a[i]<0)count=count+1;i=i+1;}return count+b;',inputs:[[[-2,3,0,-5],1],[[-1,4,-6],2]]}
 ,{name:'array-mean-scaled',body:'let i=0;let total=0;while(i<a.length){total=total+a[i];i=i+1;}return total*10/a.length+b;',inputs:[[[2,4,6],1],[[3,6,9,12],2]]}
 ,{name:'running-prefix-checksum',body:'let i=0;let total=0;let checksum=0;while(i<a.length){total=total+a[i];checksum=checksum+total;i=i+1;}return checksum+b;',inputs:[[[2,3,1],1],[[4,1,2],2]]}
 ,{name:'is-nondecreasing',body:'let i=1;let ok=1;while(i<a.length){if(a[i]<a[i-1])ok=0;i=i+1;}return ok+b;',inputs:[[[1,2,2,5],1],[[1,4,3],2]]}
 ,{name:'first-match-index',body:'let i=0;let found=-1;while(i<a.length){if(a[i]===b&&found===-1)found=i;i=i+1;}return found;',inputs:[[[3,5,2,5],5],[[4,1,4],1]]}
 ,{name:'last-match-index',body:'let i=0;let found=-1;while(i<a.length){if(a[i]===b)found=i;i=i+1;}return found;',inputs:[[[3,5,2,5],5],[[4,1,4],4]]}
 ,{name:'array-rotate-left-checksum',body:'let i=1;let total=0;while(i<a.length){total=total+a[i]*i;i=i+1;}if(a.length>0)total=total+a[0]*a.length;return total+b;',inputs:[[[2,4,1],1],[[3,5,2,1],2]]}
 ,{name:'alternating-array-sum',body:'let i=0;let total=0;while(i<a.length){if(i%2===0)total=total+a[i];else total=total-a[i];i=i+1;}return total+b;',inputs:[[[2,4,1,3],1],[[5,2,6],2]]}
 ,{name:'count-equal-pairs',body:'let i=0;let count=0;while(i<a.length){let j=i+1;while(j<a.length){if(a[i]===a[j])count=count+1;j=j+1;}i=i+1;}return count+b;',inputs:[[[1,2,1,1],1],[[3,3,4],2]]}
 ,{name:'array-unique-adjacent-count',body:'let i=0;let count=0;while(i<a.length){if(i===0||a[i]!==a[i-1])count=count+1;i=i+1;}return count+b;',inputs:[[[1,1,2,3,3],1],[[4,4,4],2]]}
 ,{name:'weighted-index-sum',body:'let i=0;let total=0;while(i<a.length){total=total+a[i]*(i+1);i=i+1;}return total+b;',inputs:[[[2,4,1],1],[[3,5,2],2]]}
 ,{name:'subarray-target-count',body:'let i=0;let count=0;while(i<a.length){let total=0;let j=i;while(j<a.length){total=total+a[j];if(total===b)count=count+1;j=j+1;}i=i+1;}return count;',inputs:[[[1,2,1,2],3],[[2,2,2],4]]}
].map(item=>Object.freeze({...item,inputs:Object.freeze(item.inputs.map(Object.freeze))})));

function evaluateBenchmarkBody(body,a,b){return Function('a','b','"use strict";'+body)(a,b);}
export function benchmarkFamiliesV1({representation='explicit'}={}){
  if(!['explicit','compact'].includes(representation))throw new TypeError('Unknown recipe representation');
  return BENCHMARK_ALGORITHMS.map(({name,body,inputs})=>{
    const family='semantic-benchmark-v1:'+name,ancestorIds=['source-algorithm-v1:'+name];
    const common={family,ancestorIds,entry:'run',projectionOptions:{representation}};
    const source='"use strict";function compute(a,b){'+body+'}async function run(key,pair){const observed=await host.readAsync(key);const a=pair.a;const b=pair.b;const answer=compute(a,b)+observed;host.store(key,answer);return answer;}';
    const calls=inputs.map(([a,b],i)=>({id:name+'-call-'+i,family,ancestorIds,entry:'run',
      source,args:[name,{a,b}],projectionOptions:{representation},fixture:{calls:[
        {operation:'demo.readAsync',arguments:[name],result:0},
        {operation:'demo.store',arguments:[name,evaluateBenchmarkBody(body,a,b)]}]}}));
    const base=evaluateBenchmarkBody(body,...inputs[0]);
    return {family,template:name,
      pure:{...common,id:name+'-pure',args:inputs[0],source:'"use strict";function run(a,b){'+body+'}',fixture:{calls:[]}},
      callbacks:{...common,id:name+'-callbacks-recovery',args:[name,{a:inputs[0][0],b:inputs[0][1]}],
        source:'"use strict";function compute(a,b){'+body+'}async function run(key,pair){const observed=await host.readAsync(key);const a=pair.a;const b=pair.b;let answer=compute(a,b)+observed;await host.withCallback(key,function(delta){answer=answer+delta;host.store(key,answer);});return answer;}',
        projectionOptions:{representation,checkpointAtFirstAwait:true},fixture:{calls:[
          {operation:'demo.readAsync',arguments:[name],result:0},
          {operation:'demo.withCallback',arguments:[name,{callback:true}],callbacks:[{slot:1,arguments:[2]},{slot:1,arguments:[3]}]},
          {operation:'demo.store',arguments:[name,base+2]},{operation:'demo.store',arguments:[name,base+5]}]}},
      repeated:{id:name+'-repeated',family,cases:calls}};
  });
}
