import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {encodeWitness,decodeWitness,fragmentWitness,restoreWitness} from '../src/training/format.js';
import {SemanticController} from '../src/training/controller.js';
import {checkWitnessClaim} from '../src/training/witness-check.js';
import {auditPublicCausality} from '../src/training/causal-audit.js';
import {exportTraining,validateTrainingExport} from '../src/training/export.js';
import {evaluateSelectedTrajectory} from '../src/training/rollout.js';
import {trainingPrefix} from '../src/training/visibility.js';

const input=encodeWitness('input',{graph:{roots:[],objects:[]}});
const code=encodeWitness('code',{entry:'run',source:'function run(){}',sites:[]});
const tag=n=>['num',n];
const lit=value=>({op:'literal',value});
const rec=(kind,fields)=>encodeWitness(kind,fields);
const controller=(opts={})=>new SemanticController([code,input],opts);
const group=(mode,record,i)=>({id:'m'+(i+1),mode,
  loss:mode==='generated'?'semantic':'none',events:[{track:'t0',record}]});
function groups(generated,context=[code,input]){
  return [...context.map(x=>['observed',x]),
    ...generated.map(x=>['generated',x])].map(([mode,x],i)=>group(mode,x,i));
}
function verified(body,args=[]){
  const runtime=createRuntime({maxSteps:30000}).startEntry({
    text:'"use strict";'+body,functionName:'run',args});
  assert.equal(runtime.drive().kind,'terminated');
  const exportResult=exportTraining(runtime);
  assert.equal(validateTrainingExport(exportResult).valid,true);
  return exportResult;
}

test('public-only causal audit checks selected records without a private archive',()=>{
  const trajectory=groups([rec('compute',{expr:{op:'binary',operator:'+',
    left:lit(tag(3)),right:lit(tag(2))},result:tag(5)}),
    rec('return',{value:tag(5)}),rec('end',{kind:'return'})]);
  const report=auditPublicCausality({groups:trajectory});
  assert.equal(report.valid,true);
  assert.equal(report.firstWitnessViolation,null);
  const invalid=structuredClone(trajectory);
  invalid[2].mode='observed';
  assert.throws(()=>auditPublicCausality({groups:invalid}),/meridian|visibility/);
});

test('correct observable return and false intermediate reasoning are separate outcomes',()=>{
  const lines=[rec('compute',{bind:'a',expr:{op:'binary',operator:'*',
    left:lit(tag(4)),right:lit(tag(2))},result:tag(99)}),
    rec('return',{value:tag(8)}),rec('end',{kind:'return'})];
  const result=evaluateSelectedTrajectory({groups:groups(lines),
    referenceOutcome:{kind:'return',graph:{roots:[tag(8)],objects:[]}}});
  assert.equal(result.valid,true);
  assert.equal(result.correctness,'correct');
  assert.equal(result.firstWitnessViolation.consistent,false);
  assert.deepEqual(result.completion.value,tag(8));
});

test('different valid granularities are not automatically incorrect computations',()=>{
  const selected=groups([rec('compute',{expr:{op:'binary',operator:'+',
    left:lit(tag(2)),right:lit(tag(3))},result:tag(5)}),
    rec('return',{value:tag(5)}),rec('end',{kind:'return'})]);
  const expected=groups([rec('return',{value:tag(5)}),rec('end',{kind:'return'})]);
  const result=evaluateSelectedTrajectory({groups:selected,referenceGroups:expected,
    referenceOutcome:{kind:'return',graph:{roots:[tag(5)],objects:[]}}});
  assert.equal(result.correctness,'correct');
  assert.equal(result.firstWitnessViolation,null);
  assert(result.firstReferenceTraceDifference);
});

test('wrong declared read cannot commit a state change',()=>{
  const c=controller();
  c.commit(rec('allocate',{name:'o10',kind:'object',properties:[
    {key:'x',value:tag(2)}]}));
  const before=c.segmentPacket();
  assert.throws(()=>c.commit(rec('read',{object:'o10',key:'x',
    value:tag(8),present:true})),e=>e.category==='read');
  assert.deepEqual(c.segmentPacket(),before);
  c.commit(rec('read',{object:'o10',key:'x',value:tag(2),present:true}));
});

test('stale shared iteration copy rejects atomically and does not repair values',()=>{
  const c=controller();
  c.commit(rec('bind',{name:'l1',value:tag(7)}));
  const before=c.segmentPacket();
  assert.throws(()=>c.commit(rec('bind',{name:'l2',from:'l1',value:tag(99)})),
    e=>e.category==='binding');
  assert.deepEqual(c.segmentPacket(),before);
  c.commit(rec('bind',{name:'l2',from:'l1',value:tag(7)}));
  c.commit(rec('allocate',{name:'o1',kind:'closure',code:'run',
    properties:[],captures:[{binding:'n',cell:'l2'}]}));
  assert.deepEqual(c.heap.get('o1').captures,[{binding:'n',cell:'l2'}]);
  assert.throws(()=>c.commit(rec('allocate',{name:'o2',kind:'closure',code:'run',
    properties:[],captures:[{binding:'n',cell:'l9'}]})),e=>e.category==='capture');
});

test('fresh public identities may be renamed but distinct allocations may not merge',()=>{
  const c=controller();
  c.commit(rec('allocate',{name:'o77',kind:'object',properties:[]}));
  c.commit(rec('allocate',{name:'o88',kind:'object',properties:[]}));
  assert.throws(()=>c.commit(rec('allocate',{name:'o77',kind:'object',properties:[]})),
    e=>e.category==='identity');
  c.commit(rec('return',{value:['ref','o88']}));
  c.commit(rec('end',{kind:'return'}));
  const graph=c.observedGraph();
  assert.equal(graph.objects.length,1);
  assert.deepEqual(graph.roots,[['ref','o0']]);
});

test('array hole and present undefined survive selected truncation',()=>{
  const c=controller();
  c.commit(rec('allocate',{name:'o1',kind:'array',length:4,properties:[
    {key:'1',value:['undefined']},{key:'3',value:tag(9)}]}));
  c.commit(rec('write',{object:'o1',key:'length',present:true,value:tag(2)}));
  assert.equal(c.heap.get('o1').properties.has('0'),false);
  assert.equal(c.heap.get('o1').properties.has('1'),true);
  assert.equal(c.heap.get('o1').properties.has('3'),false);
  c.commit(rec('return',{value:['ref','o1']}));
  c.commit(rec('end',{kind:'return'}));
  const a=c.materialize(['ref','o1']);
  assert.equal(0 in a,false);
  assert.equal(1 in a,true);
  assert.equal(3 in a,false);
  assert.equal(a.length,2);
});

test('owned FIFO dispatch cannot skip ahead or run before synchronous stack unwind',()=>{
  const c=controller({completionPolicy:'owned-quiescence'});
  c.commit(rec('job',{action:'enqueue',job:'j1',owner:'i1'}));
  c.commit(rec('job',{action:'enqueue',job:'j2',owner:'i1'}));
  assert.throws(()=>c.commit(rec('job',{action:'dispatch',job:'j1',owner:'i1'})),
    e=>e.category==='job');
  c.commit(rec('return',{value:tag(3)}));
  assert.throws(()=>c.commit(rec('job',{action:'dispatch',job:'j2',owner:'i1'})),
    e=>e.category==='job');
  assert.throws(()=>c.commit(rec('end',{kind:'return'})),e=>e.category==='incomplete');
  for(const job of ['j1','j2']){
    c.commit(rec('job',{action:'dispatch',job,owner:'i1'}));
    c.commit(rec('job',{action:'complete',job,owner:'i1'}));
  }
  c.commit(rec('end',{kind:'return'}));
  assert.deepEqual(c.completion.value,tag(3));
});

test('selected external requests match actual fixture and preserve immutable arguments',()=>{
  const fixture={operation:'demo.store',arguments:['n',5],
    status:'fulfilled',result:['undefined']};
  const c=controller({capabilities:['demo.store'],fixtureReplies:[fixture]});
  c.commit(rec('request',{effect:'fx1',operation:'demo.store',
    arguments:[['str','n'],tag(5)]}));
  c.commit(rec('bind',{name:'n',value:tag(8)}));
  assert.deepEqual(c.effects.get('fx1').arguments,['n',5]);
  assert.throws(()=>c.commit(rec('request',{effect:'fx2',operation:'demo.store',
    arguments:[['str','n'],tag(8)]})),e=>e.category==='request-mismatch');
  const before=c.segmentPacket();
  assert.throws(()=>c.commit(rec('observe',{effect:'fx1',result:tag(99),
    status:'fulfilled'}),{mode:'observed'}),e=>e.category==='observation');
  assert.deepEqual(c.segmentPacket(),before);
  c.commit(rec('observe',{effect:'fx1',result:['undefined'],status:'fulfilled'}),
    {mode:'observed'});
  c.commit(rec('return',{value:tag(8)}));
  c.commit(rec('end',{kind:'return'}));
  assert.equal(c.completion.kind,'return');
});

test('required outstanding effect cannot be hidden behind an end record',()=>{
  const c=controller({capabilities:['demo.readNumber'],
    fixtureReplies:[{operation:'demo.readNumber',arguments:['x'],
      status:'fulfilled',result:tag(3)}]});
  c.commit(rec('request',{effect:'f1',operation:'demo.readNumber',
    arguments:[['str','x']]}));
  c.commit(rec('return',{value:tag(2)}));
  assert.throws(()=>c.commit(rec('end',{kind:'return'})),e=>e.category==='incomplete');
  c.commit(rec('observe',{effect:'f1',status:'fulfilled',result:tag(3)}),
    {mode:'observed'});
  c.commit(rec('end',{kind:'return'}));
  assert.equal(c.completion.kind,'return');
});

test('fragments restore exact bytes but never count as guest calculations',()=>{
  const long=rec('code',{entry:'run',source:'function run(){return "🎆";}'+' '.repeat(400),
    sites:[]});
  const physical=fragmentWitness(long,{maxBytes:100});
  assert(physical.length>2);
  assert.deepEqual(restoreWitness(physical),[long]);
  assert.throws(()=>restoreWitness(physical.slice(0,-1)),/Incomplete/);
});

test('semantic source site dictionary does not depend on executed branch',()=>{
  const source='"use strict";function run(x){if(x>0)return x+2;return x-2;}';
  const create=x=>createRuntime().startEntry({text:source,functionName:'run',args:[x]});
  const a=trainingPrefix(create(-1).exportRun());
  const b=trainingPrefix(create(2).exportRun());
  assert.equal(a.source,b.source);
  assert.notEqual(a.input,b.input);
});

test('canonical compiler records contain no private journal counters or shape revisions',()=>{
  const exported=verified('function run(o){o.n+=3;return o.n;}',[{n:2}]);
  const corpus=exported.sidecar.compiled.generated.join('\n');
  assert(!corpus.includes('journalEvent'));
  assert(!corpus.includes('shapeVersion'));
  assert(!corpus.includes('envId'));
  assert.equal(exported.public.schema,'semantic-execution/3');
});

test('transformation certificates remain private and forged sidecar fails integrity',()=>{
  const exported=verified('function run(x){return x*2+1;}',[7]);
  const damaged=structuredClone(exported);
  damaged.sidecar.compiled.certificates[0].rule='guess/999';
  assert.throws(()=>validateTrainingExport(damaged),/integrity|certificate/i);
  assert(exported.sidecar.compiled.certificates.length>0);
});

test('version-two records and unknown source fields are refused rather than translated',()=>{
  assert.throws(()=>decodeWitness('enter {"invocation":"f1"}'),/Invalid semantic/);
  assert.throws(()=>decodeWitness('code {"entry":"run","source":"x","sites":[],"shapeVersion":99}'),
    /Invalid semantic/);
  assert.throws(()=>decodeWitness('compute {"expr":{"op":"literal","value":["num",NaN]},"result":["num",4]}'),
    /Invalid semantic/);
});

test('no model prediction may query future reference or overwrite an earlier accepted claim',()=>{
  const c=controller();
  c.commit(rec('compute',{expr:{op:'binary',operator:'+',left:lit(tag(4)),
    right:lit(tag(2))},result:tag(99)}));
  assert.equal(c.firstWitnessViolation.consistent,false);
  c.commit(rec('return',{value:tag(6)}));
  c.commit(rec('end',{kind:'return'}));
  assert.equal(c.firstWitnessViolation.expected[1],6);
  assert.deepEqual(c.completion.value,tag(6));
});

test('JavaScript source names and witness identities use different strict grammars',()=>{
  for(const entry of ['isBoolean','_scanData','$helper','Δsum','résumé','a\u200cb']){
    const record=rec('code',{entry,source:'function '+entry+'(){}',sites:[]});
    assert.equal(decodeWitness(record).fields.entry,entry);
  }
  for(const entry of ['bad-name','5bad','name space','']){
    assert.throws(()=>rec('code',{entry,source:'function run(){}',sites:[]}),
      /source context/);
  }
  assert.throws(()=>rec('allocate',{name:'Δsum',kind:'object',properties:[]}),
    /identity/);
});
