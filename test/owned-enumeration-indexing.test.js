import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoundedNatlangEnvironment} from '../src/natlang.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';

class EvalFailure extends Error {
  constructor(message,events,debug){super(message);this.events=events;this.debug=debug;}
}
function execute(code,scope){
  const captures=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,
    onTrace:bundle=>captures.push(bundle)});
  const r=env.execute({code,scope,body:true,path:'builtin://owned-bounded.js'});
  assert.equal(captures.length,1);
  assert.equal(validateBundle(captures[0]).valid,true);
  assert.equal(replayExact(captures[0]).valid,true);
  return r.result;
}
test('Object.keys, values and entries agree with V8 for owned ordinary data',()=>{
  const object={a:{n:4},b:2};
  const result=execute('const vs=Object.values(self);const es=Object.entries(self);'+
    'return [Object.keys(self),vs,es,vs[0]===self.a,es[0][1]===self.a];',object);
  assert.deepEqual(result,[Object.keys(object),Object.values(object),
    Object.entries(object),true,true]);
});
test('Array.at relative indexing agrees with V8, including NaN and bounds',()=>{
  const array=[NaN,-0,4,NaN];
  const result=execute('return [self.values.at(-1),self.values.at(-9),self.values.at(1),self.values.at(3),'+
    'self.values.indexOf(NaN),self.values.indexOf(0)];',{values:array});
  assert.deepEqual(result,[array.at(-1),array.at(-9),array.at(1),array.at(3),
    array.indexOf(NaN),array.indexOf(0)]);
});
test('unmodeled exotic enumeration fails without invoking native functions',()=>{
  const env=createBoundedNatlangEnvironment({EvalFailure});
  assert.throws(()=>env.execute({code:'return Object.values(new Proxy(self, {}));',
    scope:{x:1},body:true,path:'builtin://unsupported'}),EvalFailure);
});
