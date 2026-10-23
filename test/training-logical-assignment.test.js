import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTrainingCase,recheckIndependentTrainingEvidence,
  validateTrainingExport} from '../src/training/index.js';
import {validateBundle,replayExact} from '../src/index.js';
import {createBoundedNatlangEnvironment} from '../src/natlang.js';

function verify(code,args=[]){
  const evidence=verifyTrainingCase({source:'"use strict";\n'+code,
    entry:'f',args,maxGenerated:1024,maxSteps:20000});
  assert.equal(evidence.status,'locally_verified',JSON.stringify(evidence).slice(0,500));
  assert.equal(validateTrainingExport(evidence.exported).valid,true);
  assert.equal(recheckIndependentTrainingEvidence(evidence.exported).valid,true);
  assert.equal(validateBundle(evidence.exported.sidecar.archive).valid,true);
  assert.equal(replayExact(evidence.exported.sidecar.archive).valid,true);
  return evidence.exported;
}

test('logical identifier writes short-circuit with V8-equivalent return and update',()=>{
  verify('function f(){let a=0,b=2,c=null,d=8;'+
    'const x=(a&&=7),y=(b&&=4),z=(c??=9),w=(d??=1);return [x,y,z,w,a,b,c,d];}');
  verify('function f(){let count=0;let a=1,b=0;'+
    'function hit(){count++;return 7;}'+
    'a||=hit();b||=hit();a&&=hit();b??=hit();return [a,b,count];}');
  verify('function f(a){a??=11;return a;}',[undefined]);
  verify('function f(a){a??=11;return a;}',[null]);
  verify('function f(a){a??=11;return a;}',[false]);
});

test('computed logical member reference is evaluated only once; RHS is lazy',()=>{
  verify('function f(o){let keys=0,values=0;'+
    'function target(){keys++;return o;}function key(){keys++;return "n";}'+
    'function val(){values++;return 13;}'+
    'const first=(target()[key()]&&=val());'+
    'const second=(target()[key()]||=val());'+
    'const third=(target()[key()]??=val());'+
    'return [first,second,third,keys,values,o.n];}',[{n:0}]);
  verify('function f(o){let k=0;const result=(o[++k]??=3);'+
    'return [result,k,o];}',[{1:null}]);
  verify('function f(o){let n=0;const v=(o.x ||= (++n));'+
    'return [v,o.x,n];}',[{x:5}]);
  verify('function f(o){let n=0;const v=(o.x &&= (++n));'+
    'return [v,o.x,n];}',[{x:0}]);
});

test('typed natlang logical assignment executes entirely in owned interpreter',()=>{
  class EvalFailure extends Error {
    constructor(message,events,debug){super(message);this.events=events;this.debug=debug;}
  }
  const traces=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,
    onTrace:bundle=>traces.push(bundle)});
  try{
    const result=env.execute({body:true,path:'natlang://logical-assignment.ts',
      scope:{value:null,original:2},code:
      'let n: number | null=self.value; n??=5;'+
      'let x=self.original; x&&=n;'+
      'return [n,x];'});
    assert.deepEqual(result.result,[5,5]);
    assert.equal(traces.length,1);
    assert.equal(replayExact(traces[0]).valid,true);
    assert.throws(()=>env.execute({body:true,path:'natlang://unsupported.ts',
      scope:{},code:'return missing ||= 1;'}),EvalFailure);
    assert.equal(traces.length,1);
  }finally{env.close();}
});
