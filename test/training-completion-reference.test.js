import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {instrumentCompletionSource,createCompletionCapture,COMPLETION_HOOK,
  ownedCompletionObservations,compareCompletionObservations} from '../src/training/completion-reference.js';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission} from '../src/training/effectful-admit.js';
import {auditTeacherMutations} from '../tools/audit-teacher-mutations.mjs';

test('once-evaluated completion observations preserve call/key/getter/argument ordering',()=>{
  const source='"use strict";function run(){let log="";let value=0;const box={};'+
    'Object.defineProperty(box,"x",{get:()=>{log+="g";return value;},set:v=>{log+="s";value=v;}});'+
    'function base(){log+="b";return box;}function key(){log+="k";return "x";}'+
    'function arg(){log+="a";return 3;}'+
    'try{base()[key()]=arg();return log+box.x;}finally{log+="f";}}';
  const {capture,observations}=createCompletionCapture();
  const original=vm.runInNewContext(source+';run()');
  const actual=vm.runInNewContext(instrumentCompletionSource(source)+';run()',{[COMPLETION_HOOK]:capture});
  assert.equal(actual,original);assert.equal(actual,'bkas3');
  assert(observations.some(x=>x.kind==='finally'));
  assert.equal(observations.filter(x=>x.kind==='assign'&&x.value?.[1]===3).length,2);
});

test('the overwritten getter-only regression certifies catch and the exact binding sequence',async()=>{
  const source='"use strict";function run(){const box={};Object.defineProperty(box,"x",{get:()=>1});'+
    'let answer=0;try{answer=(box.x=2);}catch(e){answer=7;}answer=0;return answer;}';
  const result=await verifyEffectfulTrainingCase({source,entry:'run',family:'completion-regression',fixture:{calls:[]}});
  assert.equal(result.status,'locally_verified',result.reason);
  const receipt=result.exported.sidecar.reference.sourceChecks;
  assert.equal(receipt.schema,'effectful-source-checks/5');
  assert.equal(receipt.completions.counts.catch,1);
  const observations=ownedCompletionObservations(result.exported.sidecar.archive,source);
  const writes=observations.filter(row=>row.kind==='assign'&&source.slice(...row.site.split(':').map(Number)).startsWith('answer='));
  assert.deepEqual(writes.map(row=>row.value),[['num',7],['num',0]]);
  assert.equal((await recheckEffectfulAdmission(result.exported,{requireAdmitted:false})).sourceValidated,true);
});

test('reference identity observations preserve aliasing without reading user properties',()=>{
  let getters=0;const object={get x(){getters++;throw new Error('must not read');}};
  const {capture,observations}=createCompletionCapture();
  capture('a','initialize',object);capture('b','assign',object);capture('c','initialize',{});
  assert.equal(getters,0);
  assert.deepEqual(observations.map(row=>row.value),[['identity','object',1],['identity','object',1],['identity','object',2]]);
});

test('observations preserve return ASI, bare returns, nested wrappers and loop transfers',async()=>{
  const cases=[
    '"use strict";function run(){return\n3;}',
    '"use strict";function run(){let x;let n=0;for(let i=0;i<4;i++){if(i===1)continue;if(i===3)break;n=n+i;}return n;}',
    '"use strict";function f(){return 2;}function run(){let x=f();return (x=f());}'
  ];
  for(const source of cases){
    const result=await verifyEffectfulTrainingCase({source,entry:'run',family:'completion-order',fixture:{calls:[]}});
    assert.equal(result.status,'locally_verified',result.reason+' '+JSON.stringify(result.failure?.original.error.details));
  }
});

test('supplied parameters beside a default closure never borrow a body declaration source site',async()=>{
  const body='const seen=new Set();return array.filter(element=>{'+
    'const key=keyFn(element);if(seen.has(key))return false;seen.add(key);return true;});';
  const cases=[
    'function run(array,keyFn=value=>value){'+body+'}',
    'function run(array){const select=(array,keyFn=value=>value)=>{'+body+'};return select(array);}',
    'function run(array){const select=function(array,keyFn=value=>value){'+body+'};return select(array);}',
    'function run(value,read=()=>value){var value=value;return read();}'
  ];
  for(const [index,code] of cases.entries()){
    const source='"use strict";'+code;
    const result=await verifyEffectfulTrainingCase({source,entry:'run',args:index===3?[9]:[[1,2,1]],
      family:'completion-parameter-location',fixture:{calls:[]}});
    assert.equal(result.status,'locally_verified',result.reason+' '+JSON.stringify(result.failure?.original.error.details));
    const archive=result.exported.sidecar.archive;
    const parameterInstructions=Object.values(archive.programs).flatMap(program=>program.instructions)
      .filter(instruction=>instruction.op==='PARAM_INIT');
    assert(parameterInstructions.length>=2);
    for(const instruction of parameterInstructions)
      assert.match(source.slice(instruction.start,instruction.end),new RegExp('^'+instruction.arg+'(?:=|$)'));
    const observed=ownedCompletionObservations(archive,source);
    const seenStart=source.indexOf('seen=new Set()');
    if(seenStart>=0){
      const initializations=observed.filter(row=>row.site===seenStart+':'+(seenStart+'seen=new Set()'.length));
      assert.equal(initializations.length,1,'the source declaration executes once');
      assert.equal(initializations[0].kind,'initialize');
    }
  }
});

test('completion evidence still rejects an initialization attributed to a different source binding',async()=>{
  const source='"use strict";function run(array,keyFn=value=>value){const seen=new Set();return array.length;}';
  const result=await verifyEffectfulTrainingCase({source,entry:'run',args:[[1,2]],
    family:'completion-binding-site',fixture:{calls:[]}});
  assert.equal(result.status,'locally_verified',result.reason);
  const altered=structuredClone(result.exported.sidecar.archive);
  const bodyInitialization=altered.events.find(event=>event.operation==='binding.initialize'&&
    altered.programs[event.codeId].instructions.some(instruction=>
      instruction.siteId===event.siteId&&instruction.op==='INIT'&&instruction.arg==='seen'));
  altered.programs[bodyInitialization.codeId].instructions.find(instruction=>
    instruction.siteId===bodyInitialization.siteId).arg='array';
  assert.throws(()=>ownedCompletionObservations(altered,source),/different committed binding/);
});

test('independent observation disagreement reports the first divergence and exact denominator',()=>{
  assert.deepEqual(compareCompletionObservations([{site:'1:2',kind:'assign',value:['num',1]}],[]),{
    schema:'source-completions/1',status:'mismatch',checked:0,index:0,
    expected:{site:'1:2',kind:'assign',value:['num',1]},observed:null});
  assert.throws(()=>instrumentCompletionSource('function run(__tracingSourceCompletion){}'),/Reserved/);
});

test('systematic teacher mutants with restored final outcomes fail independent certification',async()=>{
  const report=await auditTeacherMutations();
  assert.equal(report.passed,true,JSON.stringify(report,null,2));
  assert.equal(report.attempted,13);assert.equal(report.detectedIndependently,13);
  assert.equal(report.journalEdited,false);
});
