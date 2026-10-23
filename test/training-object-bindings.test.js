import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoundedNatlangEnvironment} from '../src/natlang.js';
import {referenceOutcome} from '../src/training/reference.js';
import {describeGraph,realizeGraph} from '../src/training/graph.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';

class EvalFailure extends Error {
  constructor(message,events,debug){super(message);this.events=events;this.debug=debug;}
}
function differential(code,scope={}){
  const captures=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,
    onTrace:(bundle,request,lowering)=>captures.push({bundle,lowering})});
  try{
    const result=env.execute({code,scope,body:true,
      path:'natlang://object-binding.ts'});
    assert.equal(captures.length,1);
    const {bundle,lowering}=captures[0];
    assert.equal(validateBundle(bundle).valid,true);
    assert.equal(replayExact(bundle).valid,true);
    const {sourceId,functionName,arguments:args}=bundle.entrySpec;
    assert.equal(sourceId,bundle.sources[0].sourceId);
    const reference=referenceOutcome({source:lowering.javascript,entry:functionName,
      args,initialHeap:bundle.initialState.heap});
    assert.equal(reference.kind,'return',JSON.stringify(reference));
    const value=bundle.finalState.control.a0.completion.value;
    assert.deepEqual(describeGraph(realizeGraph(bundle.finalState.heap,[...args,value])),
      reference.graph);
    return result.result;
  }finally{env.close();}
}

test('typed object binding shorthand and property rename match independent V8',()=>{
  assert.deepEqual(differential(`
    const {count, delta: addition}: {count:number;delta:number} = self;
    return [count,addition,count+addition];
  `,{count:7,delta:5}),[7,5,12]);
});

test('object binding preserves one initializer and source-order property reads',()=>{
  assert.deepEqual(differential(`
    let count=0;
    function value(){count++;return self;}
    const {first: a, second: b}=value();
    return [a,b,count];
  `,{first:2,second:8}),[2,8,1]);
});

test('object binding keeps referenced aliases across later writes',()=>{
  assert.deepEqual(differential(`
    const {item: alias}=self;
    alias.n+=4;
    let {item: again}=self;
    return [alias===again,again.n,self.item.n];
  `,{item:{n:3}}),[true,7,7]);
});

test('object binding lexical slots honor block scope',()=>{
  assert.deepEqual(differential(`
    let answer=0;
    {const {n: x}=self;answer=x+1;}
    const {n}=self;
    return answer+n;
  `,{n:9}),19);
});

test('object defaults and nested patterns execute through owned lexical cells',()=>{
  assert.deepEqual(differential(
    'const {a=9,b:{c=4}}=self;return [a,c];',{b:{c:2}}),[9,2]);
  assert.deepEqual(differential(
    'const {a: first=7,b: second=8}=self;return [first,second];',
    {a:null,b:undefined}),[null,8]);
});

test('var object destructuring uses hoisted function cells with owned V8 replay',()=>{
  assert.deepEqual(differential(
    'const before=typeof value;{var {a:value=4}=self;}return [before,value];',
    {a:3}),['undefined',3]);
  assert.deepEqual(differential(
    'var {a:x}=self;var {b:x}=self;return x;',
    {a:2,b:7}),7);
});

test('computed destructuring keys run once in owned source order',()=>{
  assert.deepEqual(differential(
    'let calls=0;function key(){calls++;return calls===1?"a":"b";}' +
    'const {[key()]:first,[key()]:second}=self;' +
    'return [first,second,calls];',{a:3,b:8}),[3,8,2]);
  assert.deepEqual(differential(
    'const {[self.key]:value}=self;return value;',
    {key:'x',x:17}),17);
  assert.equal(differential(
    'const {[2]:third}=self;return third;',
    {'2':31}),31);
});

test('unowned object-pattern variants reject before trace publication',()=>{
  const bundles=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,
    onTrace:bundle=>bundles.push(bundle)});
  try{
    for(const code of [
      'const {a,...rest}=self; return rest;',
      'const {a:x,b:x}=self; return x;',
      'const {a}=self, b=2; return a+b;'
    ]){
      assert.throws(()=>env.execute({code,scope:{a:1},body:true,
        path:'natlang://unsupported-pattern.ts'}),EvalFailure,code);
    }
    assert.equal(bundles.length,0);
  }finally{env.close();}
});
