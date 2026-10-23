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
  let evidence;
  const env=createBoundedNatlangEnvironment({EvalFailure,
    onTrace:(bundle,request,lowering)=>{evidence={bundle,lowering};}});
  try{
    const result=env.execute({code,scope,body:true,path:'natlang://array-bindings.ts'});
    assert(evidence,'a completed owned execution must publish its trace');
    const {bundle,lowering}=evidence;
    assert.equal(validateBundle(bundle).valid,true);
    assert.equal(replayExact(bundle).valid,true);
    const reference=referenceOutcome({source:lowering.javascript,
      entry:bundle.entrySpec.functionName,args:bundle.entrySpec.arguments,
      initialHeap:bundle.initialState.heap});
    assert.equal(reference.kind,'return',JSON.stringify(reference));
    const value=bundle.finalState.control.a0.completion.value;
    assert.deepEqual(describeGraph(realizeGraph(bundle.finalState.heap,
      [...bundle.entrySpec.arguments,value])),reference.graph);
    return result.result;
  }finally{env.close();}
}

test('typed array binding preserves slots and aliases with V8 and exact replay',()=>{
  assert.deepEqual(differential(
    'const [first, second]: [{n:number},{n:number}]=self.items;'+
    'first.n+=4;return [first===second,second.n,self.items[0].n];',
    {items:[{n:2},{n:2}]}),[false,2,6]);
  const shared={n:3};
  assert.deepEqual(differential(
    'let [first,second]=self.items;first.n+=5;return [first===second,second.n];',
    {items:[shared,shared]}),[true,8]);
});

test('array binding initializer runs once and lexical slots follow binding order',()=>{
  assert.deepEqual(differential(
    'let calls=0;function read(){calls++;return self.items;}'+
    'const [a,b]=read();return [a,b,calls];',{items:[5,8]}),[5,8,1]);
  assert.equal(differential(
    '{let [a,b]=self.items;const x=a+b;return x;}',
    {items:[3,7]}),10);
  assert.deepEqual(differential(
    'const [a,b,c]=self.items;return [a,b,c];',
    {items:[10]}),[10,undefined,undefined]);
});

test('TS for-of destructured pairs and lexical closure captures match native V8',()=>{
  assert.deepEqual(differential(
    'const callbacks=[]; for(const [a,b] of self.rows){callbacks.push(()=>a*10+b);}' +
    'return [callbacks[0](),callbacks[1]()];',
    {rows:[[1,2],[3,4]]}),[12,34]);
});
test('nested TypeScript object and array patterns have owned lazy defaults',()=>{
  assert.deepEqual(differential(
    'let calls=0;function generate(){calls++;return self.record;}' +
    'const {a:{x=7,y:renamed=8}, b:[first=9,second]}=generate();' +
    'return [x,renamed,first,second,calls];',
    {record:{a:{x:undefined,y:3},b:[undefined,12]}}),[7,3,9,12,1]);
  assert.deepEqual(differential(
    'let events=[];const {x=events.push(1),y=events.push(2)}=self;' +
    'return [x,y,events];',
    {x:0,y:null}),[0,null,[]]);
  assert.deepEqual(differential(
    'let events=[];const {a=events.push(1),b=events.push(2)}=self;' +
    'return [a,b,events];',
    {}),[1,2,[1,2]]);
  assert.deepEqual(differential(
    'const [{a=4}, {b:[x=8]}]=self.items;return [a,x];',
    {items:[{a:3},{b:[]}] }),[3,8]);
});

test('nested binding failures never publish successful traces',()=>{
  const traces=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,onTrace:b=>traces.push(b)});
  try{
    for(const [code,scope] of [
      ['const {a:{b}}=self;return b;', {a:null}],
      ['const {a:[x]}=self;return x;', {a:'string'}],
      ['const {x=1,x:y=2}=self;return x;',{}],
      ['const {a:{b:{c:{d:{e}}}}}=self;return e;',{}],
      ['const {[self.k]:a}=self;return a;',{}],
      ['const {x,...rest}=self;return rest;',{}],
      ['const {Array: Array, a:[x]}=self;return x;',{}]
    ])
      assert.throws(()=>env.execute({code,scope,body:true,
        path:'natlang://pattern-negative.ts'}),EvalFailure,code);
    assert.equal(traces.length,0);
  }finally{env.close();}
});

test('unsupported array patterns and non-array iterators fail before trace publication',()=>{
  const traces=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,
    onTrace:bundle=>traces.push(bundle)});
  try{
    for(const [code,scope] of [
      ['const [a,...b]=self.items;return b;',{items:[2,3]}],
      ['const [,b]=self.items;return b;',{items:[2,3]}],
      ['var [a]=self.items;return a;',{items:[2]}],
      ['const [a]=self.items,b=1;return a+b;',{items:[2]}],
      ['const [a,a]=self.items;return a;',{items:[2,3]}],
      ['const [a]=self.items;return a;',{items:'a'}],
      ['const Array={isArray:()=>true};const [a]=self.items;return a;',{items:[1]}],
      ['function f(Array){const [a]=self.items;return a;}return f({isArray:()=>true});',{items:[1]}],
      ['const [a]=self.items;return a;',{items:{0:2,length:1}}]
    ]){
      assert.throws(()=>env.execute({code,scope,body:true,path:'natlang://unsupported-array.ts'}),
        EvalFailure,code);
    }
    assert.equal(traces.length,0);
  }finally{env.close();}
});
