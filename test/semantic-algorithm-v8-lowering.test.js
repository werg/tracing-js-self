import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {lowerJavaScriptV8,tryLowerJavaScriptV8} from '../src/semantic/lower-v8.js';
import {evaluateAlgorithmV8,canonicalAlgorithmV8} from '../src/semantic/algorithm-v8.js';
import {encodeAlgorithmScalar as scalar} from '../src/semantic/operations.js';
import {compareObservableGraphs} from '../src/semantic/observables.js';
import {verifyOwnedSourceCase} from '../src/training/source-check.js';

const source=body=>'"use strict";'+body;
function graph(roots){
  const objects=[],seen=new Map();
  function visit(item){
    if(!item||typeof item!=='object')return scalar(item);
    if(seen.has(item))return ['ref',seen.get(item)];
    const id='o'+seen.size;seen.set(item,id);
    const node={id,kind:Array.isArray(item)?'array':'object',properties:[]};objects.push(node);
    for(const key of Object.keys(item))node.properties.push({key,value:visit(item[key])});
    if(Array.isArray(item))node.properties.push({key:'length',value:scalar(item.length)});
    return ['ref',id];
  }
  return {roots:roots.map(visit),objects};
}
function check(body,args,{owned=false,inputTypes=null}={}){
  const text=source(body),lowered=lowerJavaScriptV8({source:text,entry:'run',inputTypes});
  const actual=evaluateAlgorithmV8(lowered.core,null,{inputGraph:graph(args)});
  const nativeArgs=structuredClone(args),expectedValue=vm.runInNewContext(text+';run(...args)',{args:nativeArgs},{timeout:1000});
  const expected=graph([...nativeArgs,expectedValue]);
  assert(compareObservableGraphs(actual.graph,expected,{leftInputIds:actual.graph.roots.slice(0,args.length).filter(x=>x[0]==='ref').map(x=>x[1]),
    rightInputIds:expected.roots.slice(0,args.length).filter(x=>x[0]==='ref').map(x=>x[1])}).equal,body+' '+JSON.stringify(args));
  if(owned){const result=verifyOwnedSourceCase({source:text,entry:'run',args,maxSteps:25000,maxGenerated:2048});
    assert.equal(result.status,'locally_verified',body+' '+result.reason);}
  return lowered;
}

test('v8 generic fold callbacks and equivalent loops converge under their declared numeric domain',()=>{
  for(const [variants,cases] of [
    [[
      'function run(xs){return xs.reduce((s,x)=>s*x,1);}',
      'function run(xs){let s=1;for(const x of xs)s*=x;return s;}',
      'function run(xs){let s=1;for(let i=0;i<xs.length;i++)s=s*xs[i];return s;}'
    ],[[],[2,3,4],[-0,1],[1e100,1e100,1e100]]],
    [[
      'function run(xs){return xs.reduce((s,x)=>s-x,10);}',
      'function run(xs){let s=10;for(const x of xs)s-=x;return s;}',
      'function run(xs){let s=10;let i=0;while(i<xs.length){s-=xs[i];i++;}return s;}'
    ],[[],[2,3,4],[1e16,1,-1e16]]]
  ]){
    const cores=variants.map(body=>check(body,[cases[1]],{owned:true,inputTypes:['dense-number-array']}).core);
    assert.equal(new Set(cores.map(canonicalAlgorithmV8)).size,1);
    for(const body of variants)for(const xs of cases)check(body,[xs],{inputTypes:['dense-number-array']});
  }
});

test('v8 callback traversals cover mapping, filtering, search, quantifiers, index use and immutable helpers',()=>{
  const variants=[
    'function run(xs){return xs.map(x=>x*2+1);}',
    'function run(xs){return xs.filter(x=>x>2);}',
    'function run(xs){return xs.find(x=>x>2);}',
    'function run(xs){return xs.findIndex(x=>x>2);}',
    'function run(xs){return xs.some(x=>x>2);}',
    'function run(xs){return xs.every(x=>x>2);}',
    'function run(xs){return xs.map((x,i)=>x+i);}',
    'function twice(x){return x*2;}function run(xs){const factor=3;const f=x=>twice(x)+factor;return xs.map(f);}',
    'function run(xs){return xs.map(x=>x*2).filter(x=>x>2);}'
  ];
  for(const body of variants)for(const xs of [[],[2,3,4],[-0,1],[-3,-2,-1]])check(body,[xs],{owned:xs.length===3&&xs[0]===2&&!/\.(find|findIndex|every)\(/.test(body)&&!body.includes('function twice')});
});

test('v8 scalar branch joins and lazy assignments preserve both values and private state',()=>{
  const cases=[
    ['function run(p,x){let y=x;if(p)y=x+1;else y=x-1;return y*2;}',[[true,2],[false,2],[0,-0]]],
    ['function run(p,x){if(p){x+=1;return x;}x-=1;return x;}',[[true,2],[false,2]]],
    ['function run(p,x){let y=1;const z=p&&(y=3);return y+x;}',[[true,2],[false,2]]],
    ['function run(p,x){let y=1;const z=p?(y=3):(y=5);return y+x;}',[[true,2],[false,2]]],
    ['function run(x){x??=5;return x;}',[[null],[undefined],[0],[false]]],
    ['function run(x){x||=5;return x;}',[[null],[undefined],[0],[false],[7]]],
    ['function run(x){x&&=5;return x;}',[[null],[undefined],[0],[false],[7]]]
  ];
  for(const [body,args] of cases)for(const values of args)check(body,values,{owned:values===args[0]&&!body.includes('run({')&&!body.includes('b=(a=2)')&&!body.includes('o?.[++i]')&&!body.includes('o?.x.y')});
  const joined=lowerJavaScriptV8({source:source(cases[0][0]),entry:'run'}).core;
  const direct=lowerJavaScriptV8({source:source('function run(p,x){return (p?x+1:x-1)*2;}'),entry:'run'}).core;
  assert.deepEqual(joined,direct);
});

test('v8 defaults, bindings, ordinary properties, aliases and optional reads retain their distinctions',()=>{
  for(const [body,args] of [
    ['function run(x=5){return x;}',[[undefined],[null],[0],[7]]],
    ['function run(o){const {x=5,y}=o;return [x,y];}',[[{}],[{x:null,y:3}],[{x:0,y:4}]]],
    ['function run({x=5}){return x;}',[[{}],[{x:null}],[{x:0}]]],
    ['function run(xs){const [a=5,b]=xs;return [a,b];}',[[[]],[[undefined,2]],[[null,2]]]],
    ['function run(o){return o?.x;}',[[null],[undefined],[{x:3}]]],
    ['function run(o){return o?.x.y;}',[[null],[{x:{y:3}}]]],
    ['function run(o){let i=0;const x=o?.[++i];return i;}',[[null],[{1:3}]]],
    ['function run(a,b=(a=2)){return a;}',[[1,undefined],[1,5]]],
    ['function run(o){const alias=o;return [o,alias];}',[[{x:3}]]],
    ['function run(p){const o=p?{x:1}:{x:2};return [o,o];}',[[true],[false]]]
  ])for(const values of args)check(body,values,{owned:values===args[0]&&!body.includes('run({')&&!body.includes('b=(a=2)')&&!body.includes('o?.[++i]')&&!body.includes('o?.x.y')});
  const empty=lowerJavaScriptV8({source:source('function run(o){const {}=o;return 3;}'),entry:'run'}).core;
  assert.throws(()=>evaluateAlgorithmV8(empty,[['null']]),/identity/);
});

test('v8 search loops and multiple private accumulators preserve ordered results',()=>{
  const bodies=[
    'function run(xs){for(const x of xs){if(x>2)return x;}return undefined;}',
    'function run(xs){for(const x of xs){if(x>2)return true;}return false;}',
    'function run(xs){for(const x of xs){if(!(x>2))return false;}return true;}',
    'function run(xs){let sum=0;let count=0;for(const x of xs){sum+=x;count++;}return {sum,count};}',
    'function run(xs){let sum=0;for(const x of xs){if(x>0)sum+=x;}return sum;}',
    'function run(xs){let sum=0;let i=0;while(i<xs.length){sum+=xs[i];i++;}return i+sum;}',
    'function run(xs){return xs.reduce((s,x)=>({sum:s.sum+x,count:s.count+1}),{sum:0,count:0});}'
  ];
  for(const body of bodies)for(const xs of [[],[2,3,4],[-2,0,3]])check(body,[xs],{owned:xs[0]===2});
});

test('v8 source recognition refuses shared mutation, receivers, holes and unsupported completion',()=>{
  for(const body of [
    'function run(xs){let count=0;return xs.map(x=>{count++;return x;});}',
    'function run(xs){return xs.map(x=>{xs[0]=0;return x;});}',
    'function run(xs){return xs.reduce((a,b)=>a+b);}',
    'function run(xs){xs.map=()=>1;return xs.map(x=>x);}',
    'function run(){return [1,,3];}',
    'function run(x){const f=()=>x;return f;}',
    'function run(x){return this.x+x;}',
    'function run(xs){let s=0;for(const x of xs){try{s+=x;}finally{s++;}}return s;}'
  ])assert.equal(tryLowerJavaScriptV8({source:source(body),entry:'run'}).status,'refused',body);
});

test('v8 map, filter and scan builders converge across builtin, for-of, indexed and while idioms',()=>{
  const families=[
    [
      'function run(xs){return xs.map(x=>x*2);}',
      'function run(xs){const out=[];for(const x of xs)out.push(x*2);return out;}',
      'function run(xs){const out=[];for(let i=0;i<xs.length;i++){const x=xs[i];out.push(x*2);}return out;}',
      'function run(xs){const out=[];let i=0;while(i<xs.length){out.push(xs[i]*2);i++;}return out;}'
    ],[
      'function run(xs){return xs.filter(x=>x>2);}',
      'function run(xs){const out=[];for(const x of xs)if(x>2)out.push(x);return out;}',
      'function run(xs){const out=[];for(let i=0;i<xs.length;i++)if(xs[i]>2)out.push(xs[i]);return out;}',
      'function run(xs){const out=[];let i=0;while(i<xs.length){if(xs[i]>2)out.push(xs[i]);i++;}return out;}'
    ],[
      'function run(xs){let sum=0;const out=[];for(const x of xs){sum+=x;out.push(sum);}return out;}',
      'function run(xs){let sum=0;const out=[];for(let i=0;i<xs.length;i++){sum+=xs[i];out.push(sum);}return out;}',
      'function run(xs){let sum=0;const out=[];let i=0;while(i<xs.length){sum+=xs[i];out.push(sum);i++;}return out;}'
    ]
  ];
  for(const variants of families){
    const cores=variants.map(body=>check(body,[[2,3,4]],{owned:true,inputTypes:['dense-number-array']}).core);
    assert.equal(new Set(cores.map(canonicalAlgorithmV8)).size,1);
    for(const body of variants)for(const xs of [[],[-0],[1e16,1,-1e16]])check(body,[xs],{inputTypes:['dense-number-array']});
  }
  for(const xs of [[],[2,3],[-0]])check('function run(xs){let s=-0;const out=[];for(const x of xs){s+=x;out.push(s);}return [s,out];}',[xs]);
});

test('new traversal normalizations keep two executed distinguishing pairs per rule separate',()=>{
  const map='function run(xs){return xs.map(x=>x*2);}',filter='function run(xs){return xs.filter(x=>x>2);}',
    scan='function run(xs){let s=0;const out=[];for(const x of xs){s+=x;out.push(s);}return out;}';
  const pairs=[
    [map,'function run(xs){return xs.map((x,i)=>x*2+i);}'],
    [map,'function run(xs){const out=[];for(let i=xs.length-1;i>=0;i--)out.push(xs[i]*2);return out;}'],
    [filter,'function run(xs){return xs.map(x=>x>2);}'],
    [filter,'function run(xs){return xs.filter(x=>x>=2);}'],
    [scan,'function run(xs){let s=0;const out=[];for(const x of xs){out.push(s);s+=x;}return out;}'],
    [scan,'function run(xs){let s=0;const out=[];for(let i=xs.length-1;i>=0;i--){s+=xs[i];out.push(s);}return out;}']
  ];
  for(const [left,right] of pairs){
    const native=body=>JSON.stringify(vm.runInNewContext(source(body)+';run([2,3,4])',{}, {timeout:1000}));
    assert.notEqual(native(left),native(right));
    const a=tryLowerJavaScriptV8({source:source(left),entry:'run'}),b=tryLowerJavaScriptV8({source:source(right),entry:'run'});
    assert(a.status==='refused'||b.status==='refused'||canonicalAlgorithmV8(a.core)!==canonicalAlgorithmV8(b.core));
    for(const body of [left,right]){
      const checked=verifyOwnedSourceCase({source:source(body),entry:'run',args:[[2,3,4]],maxSteps:25000,maxGenerated:2048});
      assert.equal(checked.status,'locally_verified',body+' '+checked.reason);
    }
  }
});

test('builder normalization refuses earlier observers and escaping aliases',()=>{
  for(const body of [
    'function run(xs){const out=[];const alias=out;for(const x of xs)out.push(x*2);return [out,alias];}',
    'function run(xs){const out=[];const n=out.length;for(const x of xs)out.push(x*2);return [out,n];}',
    'function run(xs){const out=[];function size(){return out.length;}for(const x of xs)out.push(x*2);return size();}',
    'function run(xs){const out=[];for(const x of xs)out.push(out.length);return out;}'
  ])assert.equal(tryLowerJavaScriptV8({source:source(body),entry:'run'}).status,'refused',body);
});

test('dense array rest bindings and lazy defaults preserve source order and allocate a distinct tail',()=>{
  for(const [body,cases] of [
    ['function run(xs){const [x=3,...rest]=xs;return [x,rest,rest===xs];}',[[[]],[[undefined,2,3]],[[null,2]]]],
    ['function run(xs){let x=0,rest=[];[x,...rest]=xs;return [x,rest];}',[[[2,3,4]],[[]]]],
    ['function run(o){let n=0;const {x=(++n),y=(++n)}=o;return [x,y,n];}',[[{}],[{x:5}],[{y:7}],[{x:0,y:null}]]],
    ['function run(p,x){let a=x,b=2;if(p){a+=b;b=a*2;}else{b+=a;a=b-1;}return [a,b];}',[[true,3],[false,3]]],
    ['function run(x){let y=3;x&&=(y++);return [x,y];}',[[0],[2]]]
  ])for(const args of cases)check(body,args);
});

test('function-valued defaults and callback results refuse the pure core without crashing region discovery',()=>{
  for(const body of [
    'function run(f=()=>n,n=7){return f();}',
    'function run(o){const {f=()=>3}=o;return f();}',
    'function run(xs){return xs.map(x=>()=>x);}',
    'function run(xs){return xs.reduce((x,y)=>x,()=>1);}',
    'function run(){const f=()=>1;return f.map(x=>x);}'
  ]){
    const result=tryLowerJavaScriptV8({source:source(body),entry:'run'});
    assert.equal(result.status,'refused',body);assert.match(result.reason,/scalar\/data|function identity/);
    assert.equal(result.disposition,'detailed-fallback');
  }
});

test('pure source/resource guard failures are explicit dispositions',()=>{
  const explosive='function run(x){'+Array.from({length:14},()=> 'x=x+x;').join('')+'return x;}';
  const compact=lowerJavaScriptV8({source:source(explosive),entry:'run'});
  assert.equal(compact.core.steps[0].term.op,'let','reused expressions retain bounded named intermediates');
  assert.deepEqual(evaluateAlgorithmV8(compact.core,[scalar(1)]).completion.value,scalar(16384));
  const result=tryLowerJavaScriptV8({source:source(explosive),entry:'run',maxOperations:1});
  assert.equal(result.status,'refused');assert.match(result.category,/resource_limited/);
  assert.equal(tryLowerJavaScriptV8({source:source('function run(x){return x;}'),entry:'run',maxHelperDepth:0}).status,'refused');
});
