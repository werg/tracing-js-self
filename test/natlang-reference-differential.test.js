import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoundedNatlangEnvironment} from '../src/natlang.js';
import {referenceOutcome} from '../src/training/reference.js';
import {realizeGraph,describeGraph} from '../src/training/graph.js';
import {validateBundle,reconstruct} from '../src/validation.js';
import {replayExact} from '../src/replay.js';

class EvalFailure extends Error {
  constructor(message,events,debug){super(message);this.events=events;this.debug=debug;}
}
const cases=[
  ['simple scalar expression','self.n + 3',false,{n:4}],
  ['typed shorthand and compound assignments',
    'let n: number=self.n, k: number=2; n *= k; const result={n,k}; return result.n+result.k;',
    true,{n:4}],
  ['owned typed arrow closures',
    'const delta: number = 3; const add = (x: number): number => x + delta; return add(self.n);',
    true,{n:4}],
  ['template substitutions','return `x=${self.n + 1}`;',true,{n:5}],
  ['bitwise number operators','return [self.n >>> 0, ~self.n, self.n & 3];',true,{n:-4}],
  ['captured for-let iteration values',
    'let fs = []; for (let i=0;i<3;i++){fs[i]=()=>i;} return [fs[0](),fs[1](),fs[2]()];',
    true,{}],
  ['owned object update and returned alias',
    'const o=self.o; o.n += self.a[0]; return [o,self.o.n];',true,{o:{n:1},a:[2,3]}],
  ['strict while loop','let n: number=self.n; let sum=0; while(n>0){sum+=n; n-=1;} return sum;',
    true,{n:4}],
  ['caught TS guest exception',
    'try { throw self.n; } catch (e: any) { return e*2; } finally { const z: number=1; }',
    true,{n:5}],
  ['unbound typeof and lexical unary',
    'return [typeof undeclared,typeof self,void self.n,~self.n];',true,{n:2}],
  ['TS optional property chains and nullish fallback',
    'const x: number = self.user?.address?.zip ?? 7; const y = self.empty?.zip ?? x+1; return [x,y];',
    true,{user:{address:{zip:9}},empty:null}],
  ['TS optional computed property skips unneeded key evaluation',
    'let n=0; const key=()=>{n+=1;return "value";}; const a=self.present?.[key()]; const b=self.absent?.[key()]; return [a,b,n];',
    true,{present:{value:5},absent:null}],
];

for(const [name,code,body,scope] of cases){
  test('natlang V8 differential: '+name,()=>{
    const captured=[];
    const environment=createBoundedNatlangEnvironment({EvalFailure,
      onTrace:(bundle,request,lowering)=>captured.push({bundle,request,lowering})});
    const result=environment.execute({code,body,scope,path:'natlang://differential.ts'});
    assert.equal(result.events[0].status,'completed');
    assert.equal(captured.length,1);
    const {bundle,lowering}=captured[0];
    assert.equal(validateBundle(bundle).valid,true);
    assert.equal(replayExact(bundle).valid,true);
    assert.deepEqual(reconstruct(bundle),bundle.finalState);
    assert.equal(bundle.sources[0].text,lowering.javascript);
    assert.equal(bundle.sites.length,lowering.generatedSiteOrigins.length);
    assert(!Object.hasOwn(bundle,'generatedSiteOrigins'));
    const {sourceId,functionName,arguments:args}=bundle.entrySpec;
    assert.equal(sourceId,bundle.sources[0].sourceId);
    const reference=referenceOutcome({
      source:lowering.javascript,entry:functionName,args,
      initialHeap:bundle.initialState.heap});
    assert.equal(reference.kind,'return',JSON.stringify(reference));
    const completion=bundle.finalState.control.a0.completion;
    assert.equal(completion.kind,'return');
    const owned=describeGraph(realizeGraph(bundle.finalState.heap,
      [...args,completion.value]));
    assert.deepEqual(owned,reference.graph);
    assert.deepEqual(result.result,realizeGraph(bundle.finalState.heap,[completion.value])[0]??null);
  });
}

test('unsupported generated TypeScript cannot be accepted via the differential reference',()=>{
  const observed=[];
  const environment=createBoundedNatlangEnvironment({EvalFailure,
    onTrace:bundle=>observed.push(bundle)});
  assert.throws(()=>environment.execute({code:'return new Date(0);',body:true,
    scope:{},path:'natlang://unsupported.ts'}),EvalFailure);
  assert.equal(observed.length,0);
});
