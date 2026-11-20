import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
const read=(r,k)=>Object.values(r.state.envs).flatMap(e=>Object.entries(e.bindings))
  .find(([key])=>key===k)?.[1]?.token?.value;
function check(source){
 const r=createRuntime().start(source);assert.equal(r.drive().kind,'terminated');
 const b=JSON.parse(JSON.stringify(r.exportRun()));
 assert.equal(validateBundle(b).valid,true);assert.equal(replayExact(b).valid,true);
 return r;
}
test('Promise executor is synchronous and first resolution wins',()=>{
 const r=check(`let order='';
   let p=new Promise(function(resolve,reject){order+='a';resolve(7);reject(8);order+='b';});
   p.then(function(x){order+=x;});order+='c';`);
 assert.deepEqual(read(r,'order'),['str','abc7']);
});
test('executor throw causes owned rejection',()=>{
 const r=check(`let out=0;
   new Promise(function(resolve){throw 9;}).catch(function(e){out+=e;});`);
 assert.deepEqual(read(r,'out'),['num',9]);
});
test('executor throw consumes its resolving pair before retained resolver calls',()=>{
 const r=check(`let resolveLater;let rejectLater;let out=0;
   const p=new Promise(function(resolve,reject){resolveLater=resolve;rejectLater=reject;throw 9;});
   resolveLater(3);rejectLater(7);p.catch(function(e){out=e;});`);
 assert.deepEqual(read(r,'out'),['num',9]);
 const id=read(r,'p')[1],bundle=r.exportRun();
 const rejected=bundle.events.flatMap(event=>event.stateChanges)
   .find(change=>change.table==='promises'&&change.id===id&&change.before?.status==='pending'&&change.after?.status==='rejected');
 assert(rejected);assert.equal(rejected.after.resolverCalled,true);
 for(const event of bundle.events.filter(event=>event.operation==='call.enter'&&
   event.operands[0]?.[0]==='builtinfn'&&event.operands[0][1].includes('Promise.executor.')))
   assert.equal(event.stateChanges.some(change=>change.table==='promises'&&change.id===id),false);
});
test('executor throw after resolve does not supersede earlier completion',()=>{
 const r=check(`let out=0;
   new Promise(function(resolve){resolve(4);throw 9;}).then(function(x){out+=x;});`);
 assert.deepEqual(read(r,'out'),['num',4]);
});
test('constructor bad executor is catchable TypeError',()=>{
 const r=check(`let out='';try{new Promise(3);}catch(e){out=e.name;}`);
 assert.deepEqual(read(r,'out'),['str','TypeError']);
});
