import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime,replayExact} from 'tracing-js-self';
import {verifyTrainingCase,exportTraining,validateTrainingExport} from 'tracing-js-self/training';
import {normalizeJournal} from '../src/semantic/normalize.js';
import {decodeRecord,restoreLines} from '../src/training/format.js';

const strict=code=>'"use strict";\n'+code;
const completedEntry=/Only completed synchronous effect-free return entries/;
function run(code,args=[]) {
  const runtime=createRuntime().startEntry({text:strict(code),functionName:'f',args});
  return {runtime,progress:runtime.drive()};
}

test('public training entry preserves the Acorn profile and owned arithmetic replay',()=>{
  const source=strict('function g(x){return x*3;} function f(x){let y=x+2;if(y>3)y=g(y);return y-1;}');
  const result=verifyTrainingCase({source,entry:'f',args:[4]});
  assert.equal(result.status,'locally_verified',JSON.stringify(result));
  const exported=result.exported,bundle=exported.sidecar.archive;
  assert.equal(bundle.manifest.schema,'semantic-tracing-run/2');
  assert.equal(bundle.manifest.profile,'training-js/1');
  assert.equal(bundle.sources[0].parser,'acorn/8.15.0:training-js/1');
  assert.deepEqual(bundle.finalState.control.a0.completion,{kind:'return',value:['num',17]});
  assert.equal(replayExact(JSON.parse(JSON.stringify(bundle))).valid,true);
  assert.equal(validateTrainingExport(exported).valid,true);
  assert.equal(exported.sidecar.referenceStatus,'agreed');
  const context=restoreLines(exported.public.groups.slice(0,exported.sidecar.contextGroups)
    .flatMap(group=>group.events.map(event=>event.record))).map(decodeRecord);
  assert.deepEqual(context.map(record=>record.kind),['code','value']);
  assert.equal(context[0].fields.text,source);
  assert.deepEqual(context[1].fields.graph,{roots:[['num',4]],objects:[]});
});

test('arithmetic is projected at completion with input, consumer and control dependencies',()=>{
  const {runtime}=run('function f(x){let y=x*2;if(y>1)y=y+3;return y;}',[4]);
  const exported=exportTraining(runtime),bundle=exported.sidecar.archive;
  const semantic=exported.sidecar.semantic;
  const rows=semantic.events.filter(row=>row.arithmetic);
  assert.deepEqual(rows.map(row=>row.result),[['num',8],['num',11]]);
  for(const row of rows) {
    const complete=bundle.events.find(event=>event.eventId===row.journalEvent);
    assert.equal(complete.operation,'spec.operation.complete');
    assert.equal(row.invocation,complete.invocationId);
    assert.equal(row.source.codeId,complete.codeId);
    assert.deepEqual(row.completion,{type:'normal'});
    const command=complete.stateChanges.find(change=>change.kind==='operation.complete');
    const start=bundle.events.find(event=>event.stateChanges.some(change=>
      change.kind==='operation.create' && change.id===command.id));
    assert.deepEqual(row.operands,start.operands);
    assert.deepEqual(row.dependsOn,[...new Set(start.operandOrigins
      .filter(id=>semantic.journalMapping[id]).map(id=>semantic.journalMapping[id]))]);
    assert.equal(semantic.journalMapping[start.eventId],undefined);
  }
  const read=semantic.events.find(row=>row.reads.some(value=>value.supplyingEvent===rows[0].journalEvent));
  assert(read.dependsOn.includes(rows[0].id));
  assert(read.reads.some(value=>value.supplyingSemantic===rows[0].id));
  const branch=semantic.events.find(row=>row.op==='branch');
  assert.equal(rows[1].control,branch.id);
  for(const phase of bundle.events.filter(event=>event.operation.startsWith('spec.') &&
      event.operation!=='spec.operation.complete'))
    assert.equal(semantic.journalMapping[phase.eventId],undefined);
  const records=restoreLines(exported.public.groups.slice(exported.sidecar.contextGroups)
    .flatMap(group=>group.events.map(event=>event.record))).map(decodeRecord);
  assert.deepEqual(records.filter(record=>record.fields.arithmetic)
    .map(record=>record.fields.result),[['num',8],['num',11]]);
});

test('computed phase registers remain absent until the arithmetic operation completes',()=>{
  const runtime=createRuntime().startEntry({text:strict('function f(x){return x*2;}'),
    functionName:'f',args:[6]});
  let operation;
  for(let steps=0;steps<100;steps++) {
    runtime.step();
    operation=Object.values(runtime.state.operations)[0];
    if(operation?.phase==='complete')break;
  }
  assert.equal(operation?.phase,'complete');
  assert.deepEqual(operation.registers.value.value,['num',12]);
  runtime.seal('diagnostic');
  const semantic=normalizeJournal(runtime.exportRun());
  assert.equal(semantic.events.some(row=>row.arithmetic),false);
  assert.equal(semantic.events.some(row=>row.result?.[0]==='num' && row.result[1]===12),false);
  assert.throws(()=>exportTraining(runtime),completedEntry);
});

test('compact arithmetic preserves BigInt, string and exact numeric values',()=>{
  for(const [operator,args,value] of [
    ['+',[2n,3n],['bigint','5']],
    ['+',['x',2],['str','x2']],
    ['-',[-0,0],['num','-0']],
    ['/',[0,0],['num','NaN']]
  ]) {
    const {runtime}=run(`function f(a,b){return a${operator}b;}`,args);
    const exported=exportTraining(runtime);
    const row=exported.sidecar.semantic.events.find(event=>event.arithmetic);
    assert.deepEqual(row.result,value);
    assert.equal(row.arithmetic.operator,operator);
    assert.equal(validateTrainingExport(JSON.parse(JSON.stringify(exported))).valid,true);
  }
});

test('abrupt, unsupported and pending entries cannot become training episodes',()=>{
  const valid=exportTraining(run('function f(x){return x+1;}',[2]).runtime);
  const pending=createRuntime().startEntry({text:strict('function f(){return 1;}'),functionName:'f'});
  assert.throws(()=>exportTraining(pending),completedEntry);
  for(const [operator,args,kind,completion,semanticOp] of [
    ['+',[1n,1],'runtime.failure','throw','throw'],
    ['/',[1n,0n],'runtime.failure','throw','throw'],
    ['+',[[{}],1],'unsupported','unsupported','end']
  ]) {
    const code=`function f(a,b){return a${operator}b;}`;
    const {runtime,progress}=run(code,args);
    assert.equal(progress.kind,kind);
    const archive=runtime.exportRun(),semantic=normalizeJournal(archive);
    const row=semantic.events.find(event=>event.arithmetic);
    assert.equal(row.op,semanticOp);
    assert.equal(row.completion.type,completion);
    assert.equal(row.result,null);
    assert.throws(()=>exportTraining(runtime),completedEntry);
    assert.equal(verifyTrainingCase({source:strict(code),entry:'f',args}).status,'unsupported');
    const forged=structuredClone(valid);
    forged.sidecar.archive=archive;
    forged.sidecar.semantic=semantic;
    assert.throws(()=>validateTrainingExport(forged),completedEntry);
  }
});

test('training validation rejects a substituted phase producer or arithmetic result',()=>{
  const exported=exportTraining(run('function f(x){return x*2;}',[3]).runtime);
  const phase=exported.sidecar.archive.events.find(event=>event.operation==='primitive.binary');
  const forged=structuredClone(exported);
  forged.sidecar.semantic.events.find(event=>event.arithmetic).journalEvent=phase.eventId;
  assert.throws(()=>validateTrainingExport(forged),/Semantic projection disagrees/);
  const changed=structuredClone(exported);
  changed.sidecar.semantic.events.find(event=>event.arithmetic).result=['num',7];
  assert.throws(()=>validateTrainingExport(changed),/Semantic projection disagrees/);
});
