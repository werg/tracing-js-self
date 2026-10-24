import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';

const read=(r,name)=>Object.values(r.state.envs).flatMap(e=>Object.entries(e.bindings))
  .find(([key])=>key===name)?.[1]?.token?.value;
function check(text) {
  const runtime=createRuntime().start(text);
  const outcome=runtime.drive();
  const bundle=JSON.parse(JSON.stringify(runtime.exportRun()));
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
  return {runtime,outcome,bundle};
}
test('bounded timers run after microtasks in deadline order',()=>{
  const {runtime,outcome,bundle}=check(`let order='';
    function a(){order+='a';queueMicrotask(m);}
    function b(){order+='b';} function m(){order+='m';}
    setTimeout(b,8);setTimeout(a,2);queueMicrotask(m);`);
  assert.equal(outcome.kind,'terminated');
  assert.deepEqual(read(runtime,'order'),['str','mamb']);
  assert.deepEqual(bundle.events.filter(e=>e.operation==='host.task.enter').map(e=>e.result),
    [['num',2],['num',8]]);
});
test('interval callback can cancel itself',()=>{
  const {runtime,outcome,bundle}=check(`let count=0;let timer=0;
    function tick(){count+=1;if(count===3)clearInterval(timer);}
    timer=setInterval(tick,1);`);
  assert.equal(outcome.kind,'terminated');
  assert.deepEqual(read(runtime,'count'),['num',3]);
  assert.equal(bundle.events.filter(e=>e.operation==='host.task.enter').length,3);
});
test('clearTimeout removes a pending task',()=>{
  const {runtime,outcome}=check(`let called=0;function cb(){called+=1;}
    let timer=setTimeout(cb,1);clearTimeout(timer);`);
  assert.equal(outcome.kind,'terminated');
  assert.deepEqual(read(runtime,'called'),['num',0]);
});
test('Promise.all awaits values and preserves input positions',()=>{
  const {runtime,outcome}=check(`let joined=0;
    function save(values){joined=values[0]*10+values[1];}
    Promise.all([Promise.resolve(4),2]).then(save);`);
  assert.equal(outcome.kind,'terminated');
  assert.deepEqual(read(runtime,'joined'),['num',42]);
});
test('Promise.race and Promise.all(empty) settle on owned jobs',()=>{
  const {runtime,outcome}=check(`let result=0;function got(x){result+=x;}
    Promise.race([Promise.resolve(7),Promise.resolve(8)]).then(got);
    Promise.all([]).then(function(v){result+=v.length;});`);
  assert.equal(outcome.kind,'terminated');
  assert.deepEqual(read(runtime,'result'),['num',7]);
});
test('forged task clock fails independent reconstruction',()=>{
  const {bundle}=check(`function noop(){}setTimeout(noop,4);`);
  const e=bundle.events.find(x=>x.operation==='host.task.enter');
  e.stateChanges.find(p=>p.table==='control'&&p.id==='a0').after.now=999;
  assert.throws(()=>validateBundle(bundle));
});
