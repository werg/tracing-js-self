import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission} from '../src/training/effectful-admit.js';
import {compileEffectfulWitness,verifyEffectfulProjection} from '../src/training/effectful-compiler.js';
import {decodeWitness} from '../src/training/format.js';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';

const records=episode=>episode.public.timeline.filter(row=>row.kind==='semantic').map(row=>decodeWitness(row.line));
const bytes=episode=>episode.public.timeline.filter(row=>row.kind==='semantic').reduce((n,row)=>n+Buffer.byteLength(row.line),0);
const fixture=(body,args=[])=>({source:'"use strict";'+body,entry:'run',args,
  fixture:{calls:[]},family:'local-state-compaction-test'});

test('idempotent lexical writes save actual target bytes against an explicit detailed control',async()=>{
  const input=fixture('function run(n){let value=n;value=n;value=n;return value;}',[3]);
  const control=await verifyEffectfulTrainingCase({...input,projectionOptions:{localStateCompaction:false}});
  const compact=await verifyEffectfulTrainingCase({...input,projectionOptions:{localStateCompaction:true}});
  assert.equal(control.status,'locally_verified',control.reason);
  assert.equal(compact.status,'locally_verified',compact.reason);
  const explicitControl=compileEffectfulWitness(control.exported.sidecar.archive,
    {...control.exported.sidecar.projectionOptions,localStateCompaction:false}).exported;
  assert.deepEqual(explicitControl.public,control.exported.public);
  assert.deepEqual(explicitControl.sidecar.compiler,control.exported.sidecar.compiler);
  assert.equal(compact.exported.sidecar.compiler.compaction.removedCellWrites,2);
  assert(bytes(compact.exported)<bytes(control.exported));
  assert.equal(records(compact.exported).filter(row=>row.kind==='bind'&&row.fields.name==='value').length,1);
  assert.equal(compact.exported.sidecar.compiler.elided.filter(row=>
    row.rule==='owned-idempotent-cell-write/1').length,2);
  assert.deepEqual(compact.exported.sidecar.reference.outcome,control.exported.sidecar.reference.outcome);
  const replay=await recheckEffectfulAdmission(compact.exported,{requireAdmitted:false});
  assert.equal(replay.sourceValidated,true);
  const forged=structuredClone(compact.exported);
  forged.sidecar.compiler.elided.find(row=>row.rule==='owned-idempotent-cell-write/1').value=['num',7];
  assert.throws(()=>verifyEffectfulProjection(compact.exported.sidecar.archive,forged,
    compact.exported.sidecar.projectionOptions),/certificates/);
});

test('different intermediate writes, alias identities and same-valued property writes remain visible',async()=>{
  const input=fixture('function run(){let x=0;x=2;x=0;const a={n:1};const b={n:1};let alias=a;alias=b;a.n=1;a.n=1;return x;}');
  const result=await verifyEffectfulTrainingCase({...input,projectionOptions:{localStateCompaction:true}});
  assert.equal(result.status,'locally_verified',result.reason);
  const trace=records(result.exported);
  assert.deepEqual(trace.filter(row=>row.kind==='bind'&&row.fields.name==='x').map(row=>row.fields.value),
    [['num',0],['num',2],['num',0]]);
  const aliases=trace.filter(row=>row.kind==='bind'&&row.fields.name==='alias').map(row=>row.fields.value);
  assert.equal(aliases.length,2);assert.notDeepEqual(aliases[0],aliases[1]);
  assert.equal(trace.filter(row=>row.kind==='write'&&row.fields.key==='n').length,4);
  assert.equal(result.exported.sidecar.compiler.compaction.removedCellWrites,0);
});

test('captured cell identity, shadowed cells, caught throws and finally transfers survive compaction',async()=>{
  const input=fixture('function run(){let x=1;const read=()=>x;x=1;{let x=1;x=1;}try{throw 2;}catch(error){x=error;}finally{x=3;}return read();}');
  const result=await verifyEffectfulTrainingCase({...input,projectionOptions:{localStateCompaction:true}});
  assert.equal(result.status,'locally_verified',result.reason);
  const trace=records(result.exported);
  assert(trace.some(row=>row.kind==='bind'&&row.fields.name==='x_1'));
  assert(trace.some(row=>row.kind==='transfer'&&row.fields.kind==='throw'));
  assert(trace.some(row=>row.kind==='allocate'&&row.fields.kind==='closure'&&
    row.fields.captures.some(capture=>capture.cell==='x')));
  const selected=SelectedExecutionHarness.replay(result.exported);
  assert.deepEqual(selected.invocations.get('invocation1').controller.completion.value,['num',3]);
});

test('compaction flag must be explicit boolean',async()=>{
  const result=await verifyEffectfulTrainingCase({...fixture('function run(){return 1;}'),
    projectionOptions:{localStateCompaction:'yes'}});
  assert.notEqual(result.status,'locally_verified');
  assert.match(result.reason,/localStateCompaction must be boolean/);
});
