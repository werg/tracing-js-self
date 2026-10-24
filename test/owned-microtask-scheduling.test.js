import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';

const read=(r,name)=>Object.values(r.state.envs).flatMap(e=>Object.entries(e.bindings))
 .find(([key])=>key===name)?.[1]?.token?.value;

const source=`let order='';
 function a(){order+='a';queueMicrotask(c);}
 function b(){order+='b';}
 function c(){order+='c';}
 queueMicrotask(a);
 Promise.resolve(1).then(b);
 queueMicrotask(b);`;

test('owned queueMicrotask shares FIFO jobs with Promise reactions',()=>{
 const r=createRuntime().start(source);
 assert.equal(r.drive().kind,'terminated');
 assert.deepEqual(read(r,'order'),['str','abbc']);
 const bundle=JSON.parse(JSON.stringify(r.exportRun()));
 assert.equal(validateBundle(bundle).valid,true);
 assert.equal(replayExact(bundle).valid,true);
 const jobs=bundle.events.filter(e=>e.operation==='job.enter');
 assert.equal(jobs.length,4);
 assert.equal(jobs.filter(e=>e.causes.some(c=>c.kind==='invocation')).length,4);
 assert.equal(jobs.filter(e=>e.causes.some(c=>c.kind==='promise')).length,1);
});

test('nested guest microtask preserves end-of-turn order and exact replay',()=>{
 const source=`let result='';
 function first(){result+='1';queueMicrotask(third);}
 function second(){result+='2';}
 function third(){result+='3';}
 queueMicrotask(first);queueMicrotask(second);`;
 const r=createRuntime().start(source);
 assert.equal(r.drive().kind,'terminated');
 assert.deepEqual(read(r,'result'),['str','123']);
 const bundle=JSON.parse(JSON.stringify(r.exportRun()));
 assert.equal(validateBundle(bundle).valid,true);
 assert.equal(replayExact(bundle).valid,true);
});

test('non-callable microtask callback is an owned guest TypeError',()=>{
 const r=createRuntime().start('queueMicrotask(42);');
 assert.equal(r.drive().kind,'runtime.failure');
 const bundle=JSON.parse(JSON.stringify(r.exportRun()));
 assert.equal(validateBundle(bundle).valid,true);
 assert.equal(replayExact(bundle).valid,true);
 assert.equal(r.state.control.a0.failure.completion.errorType,'TypeError');
});

test('forged microtask queue order fails independent reconstruction',()=>{
 const r=createRuntime().start(`function cb(){}queueMicrotask(cb);queueMicrotask(cb);`);
 assert.equal(r.drive().kind,'terminated');
 const bundle=JSON.parse(JSON.stringify(r.exportRun()));
 const event=bundle.events.find(e=>e.operation==='job.enter');
 const patch=event.stateChanges.find(p=>p.table==='control');
 assert(patch);
 patch.after.queue.push({kind:'microtask',functionId:'not-an-allocation'});
 assert.throws(()=>validateBundle(bundle));
});
