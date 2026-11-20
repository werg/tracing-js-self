// Frozen breadth population. Variant counts are not independent semantic-family
// counts. Every near miss is executable by the independent source reference.
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const src=body=>'"use strict";'+body;
const fn=(params,body)=>src('function run('+params+'){'+body+'}');
const negative=(label,source,args,distinction)=>({label,source,args,distinction});
const F=(id,domain,meaning,variants,inputs,negatives)=>({id,family:'expansion:'+id,
  sourceProfile:'training-js/1',domain,meaning,entry:'run',
  variants:variants.map((source,index)=>({id:id+'-idiom-'+index,source:source.startsWith('"use strict";')?source:src(source)})),
  inputs,negatives});
const primitive=[[undefined],[null],[false],[0],[""],[7],[-0],["hello"]];
const arrays=[[],[0],[1],[-1,2],[1,2,3],[1e16,-1e16,1],[-0,0],[3,-2,4,0]].map(xs=>[xs]);
const pairs=[[0,7],[false,8],[null,9],[undefined,3],[1,4],["",5],["x",0],[-2,6]];
const numbers=[-3,-1,0,1,2,7,10,100].map(x=>[x]);
export const LANGUAGE_EXPANSION_FAMILIES=freeze([
F('nullish-default','Primitive input; lazy fallback only for null or undefined',
  'Keep x unless it is null or undefined; otherwise use 10.',[
  fn('x','return x??10;'),fn('x','if(x===null||x===undefined)return 10;return x;'),
  fn('x','let value=x;if(value===null||value===undefined)value=10;return value;')],primitive,[
  negative('falsy-is-not-nullish',fn('x','return x||10;'),[0],'Zero must be retained.'),
  negative('null-is-not-undefined',fn('x','return x===undefined?10:x;'),[null],'Null activates nullish fallback.')]),
F('undefined-default','Primitive input; fallback only for undefined',
  'Use 10 only when x is undefined; keep null, false and zero.',[
  fn('x=10','return x;'),fn('x','return x===undefined?10:x;'),
  fn('x','const {value=10}={value:x};return value;')],primitive,[
  negative('nullish-is-not-default',fn('x','return x??10;'),[null],'Null does not activate a binding default.'),
  negative('falsy-is-not-default',fn('x','return x||10;'),[false],'False does not activate a binding default.')]),
F('logical-conjunction','Primitive operands; lazy truthiness selection',
  'Return x when x is falsy; otherwise return y.',[
  fn('x,y','return x&&y;'),fn('x,y','if(x)return y;return x;'),
  fn('x,y','let result=x;if(result)result=y;return result;')],pairs,[
  negative('or-is-not-and',fn('x,y','return x||y;'),[0,7],'The truthy arm is different.'),
  negative('right-is-not-unconditional',fn('x,y','return y;'),[false,8],'The right operand is skipped for false.')]),
F('logical-disjunction','Primitive operands; lazy falsy fallback',
  'Return x when x is truthy; otherwise return y.',[
  fn('x,y','return x||y;'),fn('x,y','if(x)return x;return y;'),
  fn('x,y','let result=x;if(!result)result=y;return result;')],pairs,[
  negative('nullish-is-not-falsy',fn('x,y','return x??y;'),[0,7],'Zero activates falsy fallback.'),
  negative('and-is-not-or',fn('x,y','return x&&y;'),[1,4],'A truthy left operand is retained.')]),
F('optional-data-property','Ordinary object or nullish input; own ordinary n field',
  'Read object.n when object is not null or undefined; otherwise produce undefined.',[
  fn('object','return object?.n;'),fn('object','return object===null||object===undefined?undefined:object.n;'),
  fn('object','if(object===null||object===undefined)return undefined;return object.n;')],
  [[null],[undefined],[{}],[{n:0}],[{n:false}],[{n:null}],[{n:7}],[{n:"x"}]],[
  negative('nullish-read-must-skip',fn('object','return object.n;'),[null],'Null access would throw.'),
  negative('missing-is-not-defaulted',fn('object','return object?.n??10;'),[{}],'A missing property produces undefined, not 10.')]),
F('object-binding-default','Ordinary data object with numeric x and primitive y',
  'Bind x and y from the object, using y=2 only if y is undefined; return x+y with JavaScript addition.',[
  fn('{x,y=2}','return x+y;'),fn('object','const {x,y=2}=object;return x+y;'),
  fn('object','const x=object.x;const y=object.y===undefined?2:object.y;return x+y;')],
  [[{x:1}],[{x:1,y:0}],[{x:1,y:null}],[{x:2,y:3}],[{x:-1,y:2}],[{x:0,y:7}],[{x:4,y:false}],[{x:4,y:"x"}]],[
  negative('nullish-binding-differs',fn('object','return object.x+(object.y??2);'),[{x:1,y:null}],'Binding defaults preserve null.'),
  negative('falsy-binding-differs',fn('object','return object.x+(object.y||2);'),[{x:1,y:0}],'Binding defaults preserve zero.')]),
F('ordered-product','Dense ordinary numeric array; ascending binary64 multiplication from 1',
  'Starting at 1, multiply each array element in ascending order.',[
  fn('xs','return xs.reduce((acc,x)=>acc*x,1);'),fn('xs','let acc=1;for(let i=0;i<xs.length;i++)acc*=xs[i];return acc;'),
  fn('xs','let acc=1;for(const x of xs)acc=acc*x;return acc;')],arrays,[
  negative('initial-state-matters',fn('xs','return xs.reduce((acc,x)=>acc*x,0);'),[[]],'Empty input returns the initial state.'),
  negative('sum-is-not-product',fn('xs','return xs.reduce((acc,x)=>acc+x,1);'),[[2,4]],'The step operation remains multiplication.')]),
F('array-map-affine','Dense ordinary numeric array; pure one-argument callback',
  'Visit items in order and return a fresh array containing x*2+1 for each item.',[
  fn('xs','return xs.map(x=>x*2+1);'),fn('xs','const out=[];for(let i=0;i<xs.length;i++)out.push(xs[i]*2+1);return out;'),
  fn('xs','const out=[];let i=0;while(i<xs.length){out.push(xs[i]*2+1);i++;}return out;')],arrays,[
  negative('map-preserves-order',fn('xs','return xs.map(x=>x*2+1).reverse();'),[[1,2]],'Reversing output changes traversal result order.'),
  negative('index-is-not-constant',fn('xs','return xs.map((x,i)=>x*2+i);'),[[1,2]],'Index-dependent callbacks are a distinct step.')]),
F('array-filter-positive','Dense ordinary numeric array; pure predicate',
  'Keep each item greater than zero, preserving item order.',[
  fn('xs','return xs.filter(x=>x>0);'),fn('xs','const out=[];for(const x of xs)if(x>0)out.push(x);return out;'),
  fn('xs','const out=[];for(let i=0;i<xs.length;i++){const x=xs[i];if(x>0)out[out.length]=x;}return out;')],arrays,[
  negative('zero-is-not-positive',fn('xs','return xs.filter(x=>x>=0);'),[[0,1]],'Zero fails the strict predicate.'),
  negative('truthy-is-not-positive',fn('xs','return xs.filter(x=>x);'),[[-1,1]],'Negative nonzero values are truthy but not positive.')]),
F('first-positive-value','Dense ordinary numeric array; stop at first positive value',
  'Return the first item greater than zero, or undefined if none exists.',[
  fn('xs','return xs.find(x=>x>0);'),fn('xs','for(const x of xs)if(x>0)return x;return undefined;'),
  fn('xs','let i=0;while(i<xs.length){if(xs[i]>0)return xs[i];i++;}return undefined;')],arrays,[
  negative('last-is-not-first',fn('xs','let result;for(const x of xs)if(x>0)result=x;return result;'),[[1,2]],'Search stops at the first match.'),
  negative('index-is-not-value',fn('xs','return xs.findIndex(x=>x>0);'),[[-1,8]],'The selected value differs from its index.')]),
F('first-positive-index','Dense ordinary numeric array; ascending index search',
  'Return the index of the first positive item, or -1 if none exists.',[
  fn('xs','return xs.findIndex(x=>x>0);'),fn('xs','for(let i=0;i<xs.length;i++)if(xs[i]>0)return i;return -1;'),
  fn('xs','let i=0;while(i<xs.length){if(xs[i]>0)return i;i++;}return -1;')],arrays,[
  negative('no-match-sentinel',fn('xs','for(let i=0;i<xs.length;i++)if(xs[i]>0)return i;return undefined;'),[[]],'No match uses the exact -1 sentinel.'),
  negative('truthy-search-differs',fn('xs','return xs.findIndex(x=>x);'),[[-2,3]],'Negative truthy items are not positive matches.')]),
F('any-positive','Dense ordinary numeric array; stop at first successful predicate',
  'Return whether at least one item is greater than zero; an empty array yields false.',[
  fn('xs','return xs.some(x=>x>0);'),fn('xs','for(const x of xs)if(x>0)return true;return false;'),
  fn('xs','let i=0;while(i<xs.length){if(xs[i]>0)return true;i++;}return false;')],arrays,[
  negative('all-is-not-any',fn('xs','return xs.every(x=>x>0);'),[[-1,2]],'One matching item is enough.'),
  negative('zero-does-not-match',fn('xs','return xs.some(x=>x>=0);'),[[0]],'Zero fails the strict predicate.')]),
F('all-positive','Dense ordinary numeric array; stop at first failing predicate',
  'Return whether every item is greater than zero; an empty array yields true.',[
  fn('xs','return xs.every(x=>x>0);'),fn('xs','for(const x of xs)if(!(x>0))return false;return true;'),
  fn('xs','let i=0;while(i<xs.length){if(!(xs[i]>0))return false;i++;}return true;')],arrays,[
  negative('empty-universal-is-true',fn('xs','return xs.length>0&&xs.every(x=>x>0);'),[[]],'The empty universal has no failing item.'),
  negative('zero-fails-universal',fn('xs','return xs.every(x=>x>=0);'),[[0]],'Zero is not positive.')]),
F('count-positive','Dense ordinary numeric array; ordered scalar count',
  'Count items greater than zero, starting at 0.',[
  fn('xs','return xs.reduce((count,x)=>count+(x>0?1:0),0);'),fn('xs','let count=0;for(const x of xs)if(x>0)count++;return count;'),
  fn('xs','let count=0;for(let i=0;i<xs.length;i++){if(xs[i]>0)count=count+1;}return count;')],arrays,[
  negative('count-is-not-sum',fn('xs','return xs.reduce((count,x)=>count+(x>0?x:0),0);'),[[2,3]],'Each match contributes one, not its value.'),
  negative('count-strict-predicate',fn('xs','return xs.reduce((count,x)=>count+(x>=0?1:0),0);'),[[0]],'Zero contributes nothing.')]),
F('multiple-accumulators','Dense ordinary numeric array; ordered sum and count',
  'Return [sum,count], adding Numbers in ascending order from 0 and counting every item.',[
  fn('xs','return xs.reduce((state,x)=>[state[0]+x,state[1]+1],[0,0]);'),
  fn('xs','let total=0,count=0;for(const x of xs){total+=x;count++;}return [total,count];'),
  fn('xs','let total=0,count=0,i=0;while(i<xs.length){total=total+xs[i];count=count+1;i++;}return [total,count];')],arrays,[
  negative('count-all-not-positive',fn('xs','return [xs.reduce((a,x)=>a+x,0),xs.filter(x=>x>0).length];'),[[-1,1]],'Every item increments the second state component.'),
  negative('ordered-number-rounding',fn('xs','let total=0;for(let i=xs.length-1;i>=0;i--)total+=xs[i];return [total,xs.length];'),[[1e16,-1e16,1]],'Reverse binary64 accumulation changes the sum.')]),
F('inclusive-scan','Dense ordinary numeric array; ascending binary64 partial sums',
  'Return every running sum after adding each item, starting from 0.',[
  fn('xs','let sum=0;return xs.map(x=>sum+=x);'),fn('xs','let sum=0;const out=[];for(const x of xs){sum+=x;out.push(sum);}return out;'),
  fn('xs','const out=[];let i=0,sum=0;while(i<xs.length){sum=sum+xs[i];out[i]=sum;i++;}return out;')],arrays,[
  negative('exclusive-is-not-inclusive',fn('xs','let sum=0;return xs.map(x=>{const before=sum;sum+=x;return before;});'),[[2,3]],'Each output includes its current item.'),
  negative('scan-is-not-final-sum',fn('xs','return [xs.reduce((a,x)=>a+x,0)];'),[[1,2,3]],'The intermediate prefix values remain visible.')]),
F('visible-object-write','Ordinary mutable object with Number n; preserve input identity',
  'Add delta to object.n, mutate that same object, and return the object.',[
  fn('object,delta','object.n+=delta;return object;'),fn('object,delta','const alias=object;alias.n=alias.n+delta;return object;'),
  fn('object,delta','const before=object.n;object.n=before+delta;return object;')],
  numbers.map(([n])=>[{n},2]),[
  negative('copy-is-not-input-mutation',fn('object,delta','return {n:object.n+delta};'),[{n:1},2],'A fresh equal object does not mutate the input or preserve its alias.'),
  negative('unchanged-is-not-write',fn('object,delta','return object;'),[{n:1},2],'The visible input field must change.')]),
F('shared-postfix-capture','Private captured Number cell; two sequential postfix calls',
  'Create one shared count cell initialized to x. Call the same postfix increment closure twice; return [first,second,finalCount].',[
  fn('x','let count=x;const inc=()=>count++;return [inc(),inc(),count];'),
  fn('x','let count=x;function inc(){return count++;}const a=inc(),b=inc();return [a,b,count];'),
  fn('x','let count=x;const inc=function(){const before=count;count=count+1;return before;};return [inc(),inc(),count];')],numbers,[
  negative('prefix-result-differs',fn('x','let count=x;const inc=()=>++count;return [inc(),inc(),count];'),[0],'Postfix yields the prior value despite the same write.'),
  negative('fresh-cell-per-call-differs',fn('x','const inc=()=>{let count=x;return count++;};return [inc(),inc(),x];'),[0],'Calls must share a retained cell.')]),
F('method-receiver','Private ordinary object with Number n and ordinary method',
  'Invoke the read method with the object as its receiver, returning its n plus 2.',[
  fn('x','const object={n:x,read:function(d){return this.n+d;}};return object.read(2);'),
  fn('x','const object={n:x,read:function(d){return this.n+d;}};return object.read.call(object,2);'),
  fn('x','const object={n:x,read:function(d){return this.n+d;}};return Reflect.apply(object.read,object,[2]);')],numbers,[
  negative('unbound-call-loses-receiver',fn('x','const object={n:x,read:function(d){return this.n+d;}};const f=object.read;return f(2);'),[3],'An unbound strict function has undefined this.'),
  negative('receiver-identity-matters',fn('x','const object={n:x,read:function(d){return this.n+d;}};return object.read.call({n:100},2);'),[3],'The receiver determines which field is read.')]),
F('cleanup-pending-return','Dense mutable log array; synchronous finally',
  'Return x after appending "cleanup" to the original log during finally.',[
  fn('x,log','try{return x;}finally{log.push("cleanup");}'),
  fn('x,log','try{const value=x;return value;}finally{log[log.length]="cleanup";}'),
  fn('x,log','try{if(true)return x;}finally{const message="cleanup";log.push(message);}')],numbers.map(([x])=>[x,[]]),[
  negative('finally-can-replace-return',fn('x,log','try{return x;}finally{log.push("cleanup");return 99;}'),[3,[]],'A return in cleanup replaces the pending return.'),
  negative('cleanup-is-observable',fn('x,log','return x;'),[3,[]],'Skipping the log mutation changes visible state.')]),
F('getter-captured-write','Private getter increments one captured count cell',
  'Read a getter exactly once. It increments reads and returns x; return [value,reads].',[
  fn('x','let reads=0;const object={get n(){reads++;return x;}};const value=object.n;return [value,reads];'),
  fn('x','let reads=0;const object={};Object.defineProperty(object,"n",{get:function(){reads++;return x;}});const value=object.n;return [value,reads];'),
  fn('x','let reads=0;const proto={get n(){reads++;return x;}};const object=Object.create(proto);const value=object.n;return [value,reads];')],numbers,[
  negative('validation-must-not-reread',fn('x','let reads=0;const object={get n(){reads++;return x;}};object.n;return [object.n,reads];'),[3],'Reading twice invokes the getter twice.'),
  negative('get-is-not-data-projection',fn('x','let reads=0;const object={n:x};return [object.n,reads];'),[3],'Plain data access loses the getter write.')]),
F('enumeration-own-keys','Ordinary objects with own enumerable a and inherited enumerable p',
  'Create an object with own key a and inherited key p; return only its own enumerable key names.',[
  fn('x','const object=Object.create({p:x});object.a=x;return Object.keys(object);'),
  fn('x','const object=Object.create({p:x});object.a=x;const keys=[];for(const key in object)if(Object.hasOwn(object,key))keys.push(key);return keys;'),
  fn('x','const object=Object.create({p:x});object.a=x;return Object.entries(object).map(pair=>pair[0]);')],numbers,[
  negative('inherited-enumeration-differs',fn('x','const object=Object.create({p:x});object.a=x;const keys=[];for(const key in object)keys.push(key);return keys;'),[1],'for-in also visits inherited enumerable keys.'),
  negative('values-are-not-keys',fn('x','const object=Object.create({p:x});object.a=x;return Object.values(object);'),[1],'Enumeration returns key names, not property values.')]),
F('typed-bigint-increment','BigInt input; exact BigInt addition',
  'Add 1n to the BigInt x without converting it to Number.',[
  fn('x','return x+1n;'),fn('x','let value=x;value++;return value;'),
  fn('x','let value=x;value+=1n;return value;')],[0n,1n,-1n,7n,-5n,9007199254740993n,2n**80n,-(2n**80n)].map(x=>[x]),[
  negative('number-rounding-is-not-bigint',fn('x','return BigInt(Number(x)+1);'),[9007199254740993n],'Number conversion loses exact integer information.'),
  negative('mixed-numeric-types-throw',fn('x','return x+1;'),[1n],'BigInt and Number addition must not be merged.')]),
F('generator-yield-versus-return','Bounded generator; one yield then terminal return',
  'Resume a generator that yields x and then returns x+1 twice; retain value and done for each result.',[
  fn('x','function* values(){yield x;return x+1;}const g=values();const a=g.next(),b=g.next();return [a.value,a.done,b.value,b.done];'),
  fn('x','const values=function*(){yield x;return x+1;};const g=values();const a=g.next(),b=g.next();return [a.value,a.done,b.value,b.done];'),
  fn('x','function* inner(){yield x;return x+1;}function* values(){return yield* inner();}const g=values();const a=g.next(),b=g.next();return [a.value,a.done,b.value,b.done];')],numbers,[
  negative('yield-is-not-terminal-return',fn('x','function* values(){yield x;yield x+1;}const g=values();const a=g.next(),b=g.next();return [a.value,a.done,b.value,b.done];'),[1],'Yielding the second value keeps the generator unfinished.'),
  negative('return-is-not-yield',fn('x','function* values(){return x;}const g=values();const a=g.next(),b=g.next();return [a.value,a.done,b.value,b.done];'),[1],'A terminal return does not produce a yielded item.')]),
F('class-instance-state','Ordinary construction; receiver method increments a public field',
  'Construct an instance with n=x. Its method increments n and returns the new value; return [methodResult,instance.n].',[
  fn('x','class Counter{constructor(n){this.n=n;}inc(){return ++this.n;}}const object=new Counter(x);return [object.inc(),object.n];'),
  fn('x','function Counter(n){this.n=n;}Counter.prototype.inc=function(){return ++this.n;};const object=new Counter(x);return [object.inc(),object.n];'),
  fn('x','class Counter{n=0;constructor(n){this.n=n;}inc(){this.n=this.n+1;return this.n;}}const object=new Counter(x);return [object.inc(),object.n];')],numbers,[
  negative('constructor-initialization-order',fn('x','class Counter{constructor(n){this.n=0;}inc(){return ++this.n;}}const object=new Counter(x);return [object.inc(),object.n];'),[7],'The constructor must initialize from its argument.'),
  negative('method-postfix-result-differs',fn('x','class Counter{constructor(n){this.n=n;}inc(){return this.n++;}}const object=new Counter(x);return [object.inc(),object.n];'),[7],'Prefix and postfix share mutation but differ in returned value.')]),
F('symbol-identity','Fresh local symbols; descriptions are not identities',
  'Create two fresh Symbols with the same description. Test their equality and read each distinct symbol-keyed field.',[
  fn('x','const a=Symbol(x),b=Symbol(x);const object={[a]:1,[b]:2};return [a===b,object[a],object[b]];'),
  fn('x','const a=Symbol(x);const b=Symbol(x);const object={};object[a]=1;object[b]=2;return [a===b,object[a],object[b]];'),
  fn('x','const a=Symbol(x),b=Symbol(x);const object={};Object.defineProperty(object,a,{value:1});Object.defineProperty(object,b,{value:2});return [a===b,object[a],object[b]];')],numbers,[
  negative('descriptions-are-not-identities',fn('x','const a=String(x),b=String(x);const object={[a]:1,[b]:2};return [a===b,object[a],object[b]];'),[3],'Stringifying descriptions collapses distinct symbols.'),
  negative('global-symbols-have-different-sharing',fn('x','const a=Symbol.for(String(x)),b=Symbol.for(String(x));const object={[a]:1,[b]:2};return [a===b,object[a],object[b]];'),[3],'The global registry reuses an identity whereas Symbol creates fresh ones.')])
]);

export const LANGUAGE_EXPANSION_INTERACTIONS=freeze([
  {id:'destructure-getter-computed-key',source:fn('x','let reads=0;const object={get value(){reads++;return x;}};const key="value";const {[key]:value}=object;return [value,reads];'),args:[7]},
  {id:'iteration-break-finally',source:fn('xs','const log=[];try{for(const x of xs){log.push(x);if(x>0)break;}}finally{log.push("finally");}return log;'),args:[[-1,2,3]]},
  {id:'generator-delegation-close',source:fn('x','const log=[];function* inner(){try{yield x;yield x+1;}finally{log.push("close");}}function* outer(){yield* inner();}const g=outer();const first=g.next();g.return(9);return [first.value,log];'),args:[1]},
  {id:'capture-async-callback',source:src('async function run(){let count=0;queueMicrotask(()=>count++);await Promise.resolve();return count;}'),args:[]},
  {id:'class-private-coercion',source:fn('x','class Counter{#n;constructor(n){this.#n=n;}[Symbol.toPrimitive](){return ++this.#n;}}const value=new Counter(x);return [Number(value),Number(value)];'),args:[2]},
  {id:'live-module-synchronous-cycle',sourceProfile:'evaluated-module/1',modules:{
    '/a.js':'import {read} from "./b.js";export let count=1;export function run(){count++;return read();}',
    '/b.js':'import {count} from "./a.js";export function read(){return count;}'},moduleEntry:'/a.js',exportName:'run',args:[]},
  {id:'live-module-top-level-await',sourceProfile:'evaluated-module/1',modules:{
    '/a.js':'export let count=1;await Promise.resolve();count++;',
    '/b.js':'import {count} from "./a.js";export function run(){return count;}'},moduleEntry:'/b.js',exportName:'run',args:[]},
  {id:'typed-views-shared-backing',source:fn('x','const buffer=new ArrayBuffer(4);const a=new Uint8Array(buffer);const b=new DataView(buffer);a[0]=x;b.setUint8(1,x+1);return [a[0],a[1],b.getUint8(0)];'),args:[7]},
  {id:'regexp-last-index-replacement-callback',source:fn('text','const pattern=/a/g;pattern.lastIndex=2;let calls=0;const result=text.replace(pattern,()=>String(++calls));return [result,calls,pattern.lastIndex];'),args:['ababa']},
  {id:'getter-throw-cleanup',source:fn('x','const log=[];const object={get value(){log.push("get");throw x;}};try{return object.value;}catch(error){log.push(error);}finally{log.push("finally");}return log;'),args:[3]},
  {id:'optional-receiver-lazy-arguments',source:fn('enabled','let calls=0;const object=enabled?{n:7,read:function(x){return this.n+x;}}:null;const result=object?.read(++calls);return [result,calls];'),args:[false]},
  {id:'closure-alias-mutation',source:fn('object','const alias=object;const inc=()=>++alias.n;const a=inc();const b=inc();return [object,alias,a,b];'),args:[{n:1}]},
  {id:'parameter-default-closure-tdz',source:src('function run(read=()=>later,later=7){return read();}'),args:[]},
  {id:'promise-join-rejection-finally',source:src('async function run(){let cleaned=0;try{await Promise.all([Promise.resolve(1),Promise.reject(2)]);}catch(error){return [error,cleaned];}finally{cleaned++;}}'),args:[]}
].map(row=>({sourceProfile:'training-js/1',entry:'run',fixture:{calls:[]},...row,family:'interaction:'+row.id})));

export const LANGUAGE_EXPANSION_BENCHMARK=freeze({schema:'semantic-expansion-benchmark/1',id:'language-expansion-v1',
  sourceProfile:'training-js/1; separately declared module adapters',semanticReference:'ECMAScript 2026',
  families:LANGUAGE_EXPANSION_FAMILIES,interactions:LANGUAGE_EXPANSION_INTERACTIONS,
  policy:{frozenBeforeResults:true,minimumNewFamilies:20,minimumInteractionGroups:12,
    sourceIdiomsPerFamily:3,distinguishingPairsPerFamily:2,unchangedGallery:'semantic-trace-gallery',
    counting:'A family is counted once; spelling and input variants are not separate family successes.'}});
