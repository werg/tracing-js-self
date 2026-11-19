import test from 'node:test';
import assert from 'node:assert/strict';
import {createProtocolStateV8,applyProtocolRecordV8,snapshotProtocolStateV8,restoreProtocolStateV8} from '../src/semantic/protocol-state-v8.js';
import {validatePromiseJoinRecordV8,restorePromiseJoinStateV8,assertPromiseJoinNextV8} from '../src/semantic/protocol-promise-join-v8.js';
import {PROTOCOL_MACHINE_API_V8 as api} from '../src/semantic/protocol-state-v8.js';

function controller(){
  return {heap:new Map(),locals:new Map(),captureAliases:new Map(),receiver:['undefined'],stack:['invocation'],
    frameFunctions:new Map([['invocation','run']]),pending:null,lastReturn:null,completion:null,protocol:createProtocolStateV8(),
    rootInvocation:'root',jobs:new Map(),ready:[],continuations:new Map(),scheduler:{registration:0,ready:0},
    refreshReady(){
      const ready=[];
      for(const [id,job] of this.jobs)if(job.status==='waiting'&&job.promise&&this.heap.get(job.promise)?.state!=='pending')
        ready.push({id,sequence:job.sequence,job});
      ready.sort((a,b)=>a.sequence-b.sequence);
      for(const item of ready){item.job.status='queued';item.job.readySequence=++this.scheduler.ready;this.ready.push(item.id);}
    },
    settlePromise(id,status,value){
      const target=this.heap.get(id);assert.equal(target?.kind,'promise');assert.equal(target.state,'pending');
      target.state=status;target.result=structuredClone(value);this.refreshReady();
    }};
}
function promise(c,id,state='pending',result=null){
  c.heap.set(id,{kind:'promise',properties:new Map(),state,result,adopted:null,external:null,reactions:[],join:null});
}
function join(c,mode,result,inputs,jobs,output=null,error=null){
  const record={kind:'promise.join',mode,result,inputs,jobs,output,error};
  assert.equal(validatePromiseJoinRecordV8(record),true);applyProtocolRecordV8(c,record);return record;
}
function step(c,record){c.stack=[];applyProtocolRecordV8(c,{kind:'promise.join.step',entry:null,output:null,error:null,...record});}
function snapshot(c){return structuredClone({heap:[...c.heap].map(([id,node])=>[id,{...node,properties:[...node.properties]}]),
  jobs:[...c.jobs],ready:c.ready,scheduler:c.scheduler,protocol:snapshotProtocolStateV8(c)});}
function restore(c){
  const saved=snapshot(c),restored=controller();restored.heap=new Map(saved.heap.map(([id,node])=>[id,{...node,properties:new Map(node.properties)}]));
  restored.jobs=new Map(saved.jobs);restored.ready=saved.ready;restored.scheduler=saved.scheduler;
  restoreProtocolStateV8(restored,saved.protocol);return restored;
}

test('Promise.all keeps per-input order, waits on independent arrivals, then allocates a final result array',()=>{
  const c=controller();promise(c,'p0');promise(c,'p1','fulfilled',['num',20]);promise(c,'joined');
  join(c,'all','joined',['p0','p1'],['j0','j1']);assert.deepEqual(c.ready,['j1']);
  step(c,{result:'joined',job:'j1',status:'pending',value:null});
  assert.deepEqual(c.ready,[]);assert.deepEqual(c.heap.get('joined').join.values,[null,['num',20]]);
  c.settlePromise('p0','fulfilled',['num',10]);assert.deepEqual(c.ready,['j0']);
  step(c,{result:'joined',job:'j0',output:'o9',status:'fulfilled',value:['ref','o9']});
  const output=c.heap.get('o9');assert.equal(output.kind,'array');
  assert.deepEqual(output.properties.get('0'),['num',10]);assert.deepEqual(output.properties.get('1'),['num',20]);
  assert.deepEqual(output.properties.get('length'),['num',2]);
  assert.equal(c.jobs.get('j0').status,'completed');assert.equal(c.jobs.get('j1').status,'completed');
  const resumed=restore(c);assert.equal(restorePromiseJoinStateV8(resumed,api).valid,true);
});

test('Promise.race uses the first queued settlement and consumes later reactions as explicit no-ops',()=>{
  const c=controller();promise(c,'p0','rejected',['str','first']);promise(c,'p1','fulfilled',['num',2]);promise(c,'joined');
  join(c,'race','joined',['p0','p1'],['j0','j1']);assert.deepEqual(c.ready,['j0','j1']);
  step(c,{result:'joined',job:'j0',status:'rejected',value:['str','first']});
  step(c,{result:'joined',job:'j1',status:'rejected',value:['str','first']});
  assert.equal(c.heap.get('joined').state,'rejected');assert.equal(c.ready.length,0);
  assert.equal(restore(c).heap.get('joined').join.settled,true);
});

test('empty all allocates and fulfills immediately while empty race remains pending without allocations',()=>{
  const all=controller();promise(all,'all');join(all,'all','all',[],[],'oEmpty');
  assert.equal(all.heap.get('all').state,'fulfilled');assert.deepEqual(all.heap.get('all').result,['ref','oEmpty']);
  assert.deepEqual(all.heap.get('oEmpty').properties,new Map([['length',['num',0]]]));restore(all);
  const race=controller();promise(race,'race');join(race,'race','race',[],[]);
  assert.equal(race.heap.get('race').state,'pending');assert.equal(race.heap.has('oEmpty'),false);restore(race);
});

test('false join claims, wrong IDs, bypass dispatches and unsupported modes are transactional',()=>{
  const c=controller();promise(c,'p','fulfilled',['num',1]);promise(c,'joined');join(c,'all','joined',['p'],['j']);
  const before=snapshot(c);
  assert.throws(()=>step(c,{result:'joined',job:'j',output:'oFalse',status:'fulfilled',value:['num',99]}),/false join result/);
  assert.deepEqual(snapshot(c),before);
  c.stack=[];
  assert.equal(assertPromiseJoinNextV8(c,{kind:'job',fields:{action:'dispatch',job:'j'}}),false);
  assert.throws(()=>join(controller(),'any','p',[],[]),/unsupported mode/);
});
