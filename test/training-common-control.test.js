import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime,replayExact,validateBundle} from 'tracing-js-self';
import {verifyTrainingCase,validateTrainingExport} from 'tracing-js-self/training';
import {decodeRecord,restoreLines} from '../src/training/format.js';

const strict=body=>'"use strict";\n'+body;
function verified(body,args=[]) {
  const source=strict(body);
  const result=verifyTrainingCase({source,entry:'f',args,maxGenerated:1024});
  assert.equal(result.status,'locally_verified',JSON.stringify(result));
  assert.equal(validateTrainingExport(result.exported).valid,true);
  const archive=JSON.parse(JSON.stringify(result.exported.sidecar.archive));
  assert.equal(validateBundle(archive).valid,true);
  assert.equal(replayExact(archive).valid,true);
  assert.equal(result.exported.sidecar.operationAudit.status,'agreed');
  return result.exported;
}

test('for-let loops have owned induction, break and continue, including the update target',()=>{
  const exported=verified(`function f(limit) {
    let sum=0;
    for(let i=0;i<limit;i++){
      if(i===2)continue;
      if(i===5)break;
      sum+=i;
    }
    return sum;
  }`,[8]);
  const operationAudit=exported.sidecar.operationAudit;
  assert.equal(operationAudit.covered.updates,5);
  assert.deepEqual(exported.sidecar.archive.finalState.control.a0.completion,
    {kind:'return',value:['num',8]});
  assert(exported.sidecar.semantic.events.some(e=>e.op==='loop'));
  const updates=exported.sidecar.semantic.events.filter(e=>e.update);
  assert(updates.every(e=>e.op==='write' && e.update.operator==='++' &&
    e.update.prefix===false && e.reads.length===1 && e.writes.length===1));
  const records=restoreLines(exported.public.groups.slice(exported.sidecar.contextGroups)
    .flatMap(group=>group.events.map(event=>event.record))).map(decodeRecord);
  assert.equal(records.filter(record=>record.fields.update).length,updates.length);
});

test('for expressions, open-ended loops and nested exits match the V8 reference',()=>{
  verified(`function f(){
    let i=0; let total=0;
    for(i=0;i<4;i+=1)total+=i;
    for(;;){i--;if(i===1)break;}
    return total+i;
  }`);
});

test('do-while executes the body first; continue evaluates the condition',()=>{
  const exported=verified(`function f(){
    let i=0;
    let sum=0;
    do {
      i++;
      if(i<3)continue;
      sum+=i;
    } while(i<4);
    return sum;
  }`);
  assert.deepEqual(exported.sidecar.archive.finalState.control.a0.completion,
    {kind:'return',value:['num',7]});
  verified('function f(){let x=1;do{x++;break;}while(false);return x;}');
});

test('conditional expression selects one branch and never evaluates the other',()=>{
  const code=`function f(flag){
    let obj={value:0};
    const answer=flag ? (obj.value=3) : (obj.value=7);
    return [answer,obj.value];
  }`;
  for(const flag of [true,false]) {
    const e=verified(code,[flag]);
    assert(e.sidecar.semantic.events.some(row=>row.op==='branch'));
    assert.deepEqual(e.sidecar.archive.finalState.control.a0.completion.value[0],'ref');
  }
});

test('owned update uses ToNumeric instead of string concatenation, and returns the old numeric value for postfix',()=>{
  const cases=[
    [`function f(){let n='2';let previous=n++;return [previous,n];}`,['num',2],['num',3]],
    [`function f(){let n=2n;let previous=n--;return [previous,n];}`,['bigint','2'],['bigint','1']],
    [`function f(){let n=true;return ++n;}`,null,['num',2]],
    [`function f(){let n=-0;return n--;}`,null,['num','-0']],
    [`function f(){let n=undefined;return n++;}`,null,['num','NaN']]
  ];
  for(const [code,previous,updated] of cases) {
    const exported=verified(code);
    const updates=exported.sidecar.semantic.events.filter(row=>row.update);
    assert.equal(updates.length,1);
    assert.equal(exported.sidecar.operationAudit.covered.updates,1);
    if(previous) {
      assert.deepEqual(updates[0].result,previous);
      assert.deepEqual(updates[0].writes[0].value,updated);
    }else assert.deepEqual(updates[0].result,updated);
  }
});

test('unowned semantic cases fail closed instead of making plausible training examples',()=>{
  const rejected=[
    'function f(){const a={n:1};a.n++;return a.n;}',
    'function f(){let n=0;for(const i=0;i<3;i++)n+=i;return n;}',
    'function f(){let x=0;for(let i=0;i<2;i++){function g(){return i;}x+=g();}return x;}',
    'function f(){return missing++ ;}',
    'function f(){label:while(true){break label;}return 1;}'
  ];
  for(const code of rejected)
    assert.equal(verifyTrainingCase({source:strict(code),entry:'f'}).status,'unsupported',code);
  const runtime=createRuntime().startEntry({text:strict(
    'function f(x){x++;return 0;}'),functionName:'f',args:[{x:1}]});
  assert.throws(()=>runtime.drive(),/Update coercion outside the bounded scalar profile/);
});
