import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';

const wire=x=>JSON.parse(JSON.stringify(x));
const find=(r,name)=>Object.values(r.state.envs).flatMap(e=>Object.entries(e.bindings))
  .find(([k])=>k===name)?.[1]?.token?.value;

function verify(source,kind='terminated') {
  const r=createRuntime().start(source);
  assert.equal(r.drive().kind,kind);
  const archive=wire(r.exportRun());
  assert.equal(validateBundle(archive).valid,true);
  assert.equal(replayExact(archive).valid,true);
  return {r,archive};
}

test('ordinary object and dense primitive-array default conversion agree with Node scalar values',()=>{
  for(const expression of [
    '{} + 2','[] + 2','[1,2] + 3',"[false,null,'x'] + 1",
    '({x:1}) + 2','({x:1}) * 3'
  ]) {
    const source='let result='+expression+';';
    const {r}=verify(source);
    const expected=vm.runInNewContext(expression);
    const tagged=typeof expected==='string'?['str',expected]:
      Number.isNaN(expected)?['num','NaN']:['num',expected];
    assert.deepEqual(find(r,'result'),tagged,source);
  }
});

test('guest valueOf, fallback to toString, and this are observable and ordered',()=>{
  const source=`let trace='';let result='';
    function value(){trace+='v';return this;}
    function string(){trace+='s';return 'eight';}
    let object={valueOf:value,toString:string};
    result=object+2;`;
  const {r,archive}=verify(source);
  assert.deepEqual(find(r,'trace'),['str','vs']);
  assert.deepEqual(find(r,'result'),['str','eight2']);
  assert.deepEqual(archive.events.filter(e=>e.operation==='spec.internal.get')
    .map(e=>e.readObservations[0].key),['valueOf','toString']);
  assert.equal(archive.events.filter(e=>e.operation==='spec.internal.return').length,2);
});

test('non-callable own conversion properties are skipped, then throw TypeError',()=>{
  const source=`let name='';let object={valueOf:7,toString:8};
    try {let x=object+1;}catch(e){name=e.name;}`;
  const {r}=verify(source);
  assert.deepEqual(find(r,'name'),['str','TypeError']);
});

test('a guest method throw propagates through the pending coercion operation',()=>{
  const source=`let caught='';function explode(){throw 'coerce-failure';}
    let object={valueOf:explode};
    try {let value=object+1;}catch(e){caught=e;}`;
  const {r,archive}=verify(source);
  assert.deepEqual(find(r,'caught'),['str','coerce-failure']);
  assert(archive.events.some(e=>e.operation==='spec.operation.complete'&&e.completion?.type==='throw'));
  assert(Object.values(r.state.frames).some(f=>f.status==='thrown'));
});

test('complex arrays fail closed rather than invoking host coercion',()=>{
  const {r}=verify('let value=[{}]+1;','unsupported');
  assert.equal(r.state.control.a0.failure.completion.feature,'ArrayToString(complex)');
});

test('forged own-property [[Get]] value and producer are rejected by validator',()=>{
  const {archive}=verify('let result={valueOf:3}+1;');
  const got=archive.events.find(e=>e.operation==='spec.internal.get'&&
    e.readObservations[0]?.present);
  assert(got);
  const tampered=wire(archive);
  tampered.events.find(e=>e.eventId===got.eventId).readObservations[0].version=999;
  assert.throws(()=>validateBundle(tampered),/method\/provenance|mismatch/);
});

test('prototype-dangerous own keys still have deterministic property history',()=>{
  const {r}=verify("let value={constructor:1,valueOf:7,toString:8};let result=value.constructor;");
  assert.deepEqual(find(r,'result'),['num',1]);
  const obj=Object.values(r.state.heap).find(x=>x.kind==='object'&&x.properties.constructor?.value?.[1]===1);
  assert(obj);
  assert.equal(obj.propertyVersions.valueOf,1);
  assert.equal(obj.propertyVersions.toString,1);
  assert.equal(obj.propertyVersions.constructor,1);
});
