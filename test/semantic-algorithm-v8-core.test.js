import test from 'node:test';
import assert from 'node:assert/strict';
import {ALGORITHM_V8_SCHEMA,ALGORITHM_V8_PROFILE,validateAlgorithmV8,validateTermV8,
  evaluateAlgorithmV8,evaluateTermV8,checkAlgorithmV8Claims} from '../src/semantic/algorithm-v8.js';
import {encodeAlgorithmScalar as scalar} from '../src/semantic/operations.js';
import {validateAlgorithm} from '../src/semantic/ir.js';

const lit=x=>({op:'literal',value:scalar(x)}),bound=(index,depth=0)=>({op:'bound',depth,index}),
  op=(name,...args)=>({op:name,args}),input={op:'input',id:'a0'},
  traversal=(mode,body,initial=null)=>({op:'traverse',mode,input,initial,
    callback:{arity:['fold','scan'].includes(mode)?4:3,body},profile:'dense-primitive-array/1',order:'ascending'}),
  core=term=>({schema:ALGORITHM_V8_SCHEMA,profile:ALGORITHM_V8_PROFILE,inputs:[{id:'a0',type:'dense-number-array'}],
    steps:[{kind:'compute',id:'v0',term},{kind:'return',value:{op:'ref',id:'v0'}}]});
function graph(xs){return {roots:[['ref','xs']],objects:[{id:'xs',kind:'array',properties:[
  {key:'length',value:scalar(xs.length)},...xs.map((x,i)=>({key:String(i),value:scalar(x)}))]}]};}
function run(term,xs){return evaluateAlgorithmV8(core(term),null,{inputGraph:graph(xs)});}
const resultArray=out=>{const node=out.heap.get(out.completion.value[1]);return [...node.properties].filter(([k])=>k!=='length').map(([,v])=>v);};

test('v8 pure traversal implements ordered fold, map, filter, search, quantifiers and scans',()=>{
  assert.deepEqual(run(traversal('fold',op('multiply',bound(0),bound(1)),lit(1)),[2,3,4]).completion.value,scalar(24));
  assert.deepEqual(run(traversal('fold',op('subtract',bound(0),bound(1)),lit(10)),[2,3,4]).completion.value,scalar(1));
  assert.deepEqual(resultArray(run(traversal('map',op('add',bound(0),bound(1))),[2,3,4])),[2,4,6].map(scalar));
  assert.deepEqual(resultArray(run(traversal('filter',op('greater',bound(0),lit(2))),[2,3,4])),[3,4].map(scalar));
  assert.deepEqual(run(traversal('find',op('greater',bound(0),lit(2))),[2,3,4]).completion.value,scalar(3));
  assert.deepEqual(run(traversal('find_index',op('greater',bound(0),lit(2))),[2,3,4]).completion.value,scalar(1));
  assert.deepEqual(run(traversal('some',op('greater',bound(0),lit(2))),[]).completion.value,scalar(false));
  assert.deepEqual(run(traversal('every',op('greater',bound(0),lit(2))),[]).completion.value,scalar(true));
  assert.deepEqual(resultArray(run(traversal('scan',op('add',bound(0),bound(1)),lit(0)),[2,3,4])),[2,5,9].map(scalar));
  assert.deepEqual(run(traversal('fold',op('add',bound(0),bound(1)),lit(0)),[1e16,1,-1e16]).completion.value,scalar(0));
});

test('v8 eager bindings preserve alias identity and callback lexical capture',()=>{
  const term={op:'let',bindings:[{op:'object',properties:[{key:'n',value:lit(4)}]}],
    body:{op:'array',items:[bound(0),bound(0)]}};
  const program={...core(term),inputs:[]};
  const out=evaluateAlgorithmV8(program,[]);
  const aliases=resultArray(out);assert.deepEqual(aliases[0],aliases[1]);
  assert.equal(out.allocator.next,2);
  const capture={op:'let',bindings:[lit(10)],body:traversal('map',op('add',bound(0),bound(0,1)))};
  assert.deepEqual(resultArray(run(capture,[1,2])),[11,12].map(scalar));
  assert.throws(()=>validateTermV8({op:'let',bindings:[bound(0)],body:lit(3)}),/unbound lexical/);
  assert.throws(()=>validateTermV8(traversal('map',bound(0,1))),/unbound lexical/);
});

test('search and selections are lazy and defaults distinguish undefined from null and falsity',()=>{
  const bad=op('divide',lit(1n),lit(0n));
  const predicate=op('select',op('equal',bound(0),lit(1)),lit(true),bad);
  assert.deepEqual(run(traversal('some',predicate),[1,2]).completion.value,scalar(true));
  assert.deepEqual(run(traversal('find',predicate),[1,2]).completion.value,scalar(1));
  assert.throws(()=>run(traversal('map',predicate),[1,2]),RangeError);
  assert.deepEqual(evaluateTermV8(op('default_undefined',lit(null),bad)),scalar(null));
  assert.deepEqual(evaluateTermV8(op('default_undefined',lit(0),bad)),scalar(0));
  assert.deepEqual(evaluateTermV8(op('default_undefined',lit(undefined),lit(10))),scalar(10));
});

test('v8 rejects malformed scopes, v7 relabels, profiles, forged claims and observing eligibility',()=>{
  const valid=core(traversal('map',op('multiply',bound(0),lit(2))));
  assert.throws(()=>validateAlgorithm(valid),/version/);
  for(const mutate of [x=>x.schema='semantic-algorithm/1',x=>x.steps[0].term.callback.arity=2,
    x=>x.steps[0].term.profile='sparse-array',x=>x.steps[0].term.order='descending',
    x=>x.steps[0].term.callback.body=bound(3)]){
    const changed=structuredClone(valid);mutate(changed);assert.throws(()=>validateAlgorithmV8(changed));
  }
  const out=evaluateAlgorithmV8(valid,null,{inputGraph:graph([1,2])});
  assert(checkAlgorithmV8Claims(valid,null,out.claims,{inputGraph:graph([1,2])}).consistent);
  const claims=structuredClone(out.claims);claims[0].result=['ref','xs'];
  assert.equal(checkAlgorithmV8Claims(valid,null,claims,{inputGraph:graph([1,2])}).consistent,false);
  let hooks=0;
  const proxy=new Proxy(valid,{getPrototypeOf(){hooks++;return Object.prototype;}});
  assert.throws(()=>validateAlgorithmV8(proxy));assert.equal(hooks,0);
  const changed=graph([1,2]);changed.objects[0].properties.push({key:'map',value:['undefined']});
  assert.throws(()=>evaluateAlgorithmV8(valid,null,{inputGraph:changed}),/extra|holes|properties/);
});

test('v8 budget failure does not mutate the caller owned heap and fresh identities cannot collide',()=>{
  const heap=new Map([['v8:0',{kind:'object',properties:new Map()}]]),before=structuredClone(heap);
  const program={...core({op:'array',items:[lit(1)]}),inputs:[]};
  const out=evaluateAlgorithmV8(program,[],{heap});
  assert.deepEqual(heap,before);assert.deepEqual(out.completion.value,['ref','v8:1']);
  assert.throws(()=>evaluateTermV8(op('add',lit(1),lit(2)),{budget:{remaining:1}}),/budget/);
});

test('v8 allocated graphs use ECMAScript own-key order without reordering value evaluation',()=>{
  const arrayProgram={...core({op:'array',items:[lit(4),lit(5)]}),inputs:[]};
  const arrayOut=evaluateAlgorithmV8(arrayProgram,[]);
  assert.deepEqual(arrayOut.graph.objects[0].properties.map(p=>p.key),['0','1','length']);
  const objectProgram={...core({op:'object',properties:[
    {key:'2',value:{op:'array',items:[lit(2)]}},
    {key:'1',value:{op:'array',items:[lit(1)]}},
    {key:'last',value:lit(3)}]}),inputs:[]};
  const objectOut=evaluateAlgorithmV8(objectProgram,[]),object=objectOut.graph.objects.find(o=>o.id===objectOut.completion.value[1]);
  assert.deepEqual(object.properties.map(p=>p.key),['1','2','last']);
  assert.deepEqual(object.properties.slice(0,2).map(p=>p.value),[['ref','v8:1'],['ref','v8:0']],
    'values were evaluated in source order before integer-key enumeration');
});

test('v8 lexical environments, work budgets and graph identities fail closed without observing hooks',()=>{
  let hooks=0;
  const scope=[scalar(3)];Object.defineProperty(scope,'0',{enumerable:true,get(){hooks++;return scalar(3);}});
  assert.throws(()=>evaluateTermV8({op:'bound',depth:0,index:0},{scopes:[scope]}));
  const budget={};Object.defineProperty(budget,'remaining',{enumerable:true,get(){hooks++;return 10;}});
  assert.throws(()=>evaluateTermV8(lit(3),{budget}));
  assert.throws(()=>evaluateTermV8(lit(3),{budget:{remaining:Infinity}}),/budget/);
  const duplicate=graph([1]);duplicate.objects.push(structuredClone(duplicate.objects[0]));
  assert.throws(()=>evaluateAlgorithmV8(core(input),null,{inputGraph:duplicate}),/duplicate input graph identity/);
  assert.equal(hooks,0);
});
