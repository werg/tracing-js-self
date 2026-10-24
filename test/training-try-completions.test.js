import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime,validateBundle,replayExact} from 'tracing-js-self';
import {verifyTrainingCase,exportTraining} from 'tracing-js-self/training';
import {createBoundedNatlangEnvironment} from '../src/natlang.js';
const strict=body=>'"use strict";\n'+body;
function completed(body,args=[]){
  const runtime=createRuntime().startEntry({text:strict(body),functionName:'f',args});
  const progress=runtime.drive();
  assert.equal(progress.kind,'terminated',JSON.stringify(progress));
  const archive=runtime.exportRun();
  assert.equal(validateBundle(archive).valid,true);
  assert.equal(replayExact(archive).valid,true);
  return archive;
}
test('strict explicit primitive throw is caught in owned lexical environment',()=>{
  const b=completed('function f(x){try {throw x+1;}catch(e){return e*2;}}',[3]);
  assert.deepEqual(b.finalState.control.a0.completion.value,['num',8]);
  assert(b.events.some(x=>x.operation==='completion.throw'));
});
test('finally executes after return and supports normal fallthrough',()=>{
  const source='function f(o){try {return o.n;}finally{o.n+=3;}}';
  const b=completed(source,[{n:2}]);
  assert.deepEqual(b.finalState.control.a0.completion.value,['num',2]);
  assert.equal(b.finalState.heap[Object.keys(b.finalState.heap).find(k=>b.finalState.heap[k].kind==='object')].properties.n.value[1],5);
});
test('caught throw has one actual v3 exit after handler binding',()=>{
  const source=strict('function f(){try{throw 1;}catch(e){return e+2;}}');
  const result=verifyTrainingCase({source,entry:'f'});
  assert.equal(result.status,'locally_verified',JSON.stringify(result));
  const runtime=createRuntime().startEntry({text:source,functionName:'f'});
  assert.equal(runtime.drive().kind,'terminated');
  const episode=exportTraining(runtime);
  const records=episode.sidecar.compiled.generated;
  assert.equal(records.filter(r=>r.startsWith('return ')).length,1);
  assert(records.some(r=>r.startsWith('transfer ')));
  assert(records.some(r=>r.startsWith('bind ')));
});
test('natlang TS catch/finally guest values execute and exactly replay',()=>{
  class EvalFailure extends Error{constructor(message,events){super(message);this.events=events;}}
  const archives=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,onTrace:b=>archives.push(b)});
  const result=env.execute({code:'try { throw self.x; } catch (e: any) { return e + 5; } finally { const n: number = 1; }',
    body:true,scope:{x:3},path:'natlang://try.ts'});
  assert.equal(result.result,8);
  assert.equal(archives.length,1);
});
test('destructured catch and exotic thrown values remain outside profile',()=>{
  assert.equal(verifyTrainingCase({source:strict('function f(){try{throw 1;}catch({message}){return message;}}'),entry:'f'}).status,'unsupported');
});
