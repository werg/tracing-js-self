import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {encodeWitness,decodeWitness,validateExpression} from '../src/training/witness-ir.js';
import {WitnessController} from '../src/training/witness-controller.js';
import {exportWitnessTraining,validateWitnessTrainingExport,
  evaluateWitnessTrajectory,fragmentWitness,restoreWitness} from '../src/training/export-v3.js';

function sourceCase(body,args){
  const runtime=createRuntime({maxSteps:30000}).startEntry({
    text:'"use strict"; '+body,functionName:'run',args});
  assert.equal(runtime.drive().kind,'terminated');
  return exportWitnessTraining(runtime,{maxBytes:512,maxOperators:1});
}
test('typed public v3 arithmetic computes and serializes separately from private journal',()=>{
  const episode=sourceCase('function run(x){return x*2+1;}',[7]);
  assert.equal(episode.public.schema,'semantic-execution/3');
  assert.equal(episode.public.traceFormat,'semantic-trace/3');
  assert.equal(episode.sidecar.schema,'semantic-supervision/2');
  assert.equal(validateWitnessTrainingExport(episode).valid,true);
  const result=evaluateWitnessTrajectory({groups:episode.public.groups,
    referenceOutcome:episode.sidecar.reference});
  assert.equal(result.valid,true,JSON.stringify(result.invalid));
  assert.equal(result.correctness,'correct');
  assert.equal(result.firstWitnessViolation,null);
  const records=episode.sidecar.compiled.generated.map(decodeWitness);
  assert(records.filter(r=>r.kind==='compute').length>=2);
  assert(records.every(r=>!JSON.stringify(r).includes('journalEvent')));
});
test('selected wrong computation is not repaired even if terminal outcome matches',()=>{
  const code=encodeWitness('code',{entry:'run',source:'function run(x){return x+1;}',
    sites:[]});
  const input=encodeWitness('input',{graph:{roots:[['num',4]],objects:[]}});
  const selected=new WitnessController([code,input]);
  selected.commit(encodeWitness('bind',{name:'y',value:['num',99]}));
  selected.commit(encodeWitness('compute',{bind:'z',expr:{op:'binary',operator:'*',
    left:{op:'local',name:'y'},right:{op:'literal',value:['num',2]}},result:['num',10]}));
  selected.commit(encodeWitness('return',{value:['num',10]}));
  selected.commit(encodeWitness('end',{kind:'return'}));
  assert.equal(selected.completion.value[1],10);
  assert.equal(selected.firstWitnessViolation.consistent,false);
  assert.equal(selected.locals.get('z')[1],10);
});
test('public transport fragments restore exact code points and never become operations',()=>{
  const line=encodeWitness('code',{entry:'run',source:'function run(){ return "😎"; }'+
    '/*'.padEnd(190,'z')+'*/',sites:[]});
  const parts=fragmentWitness(line,{maxBytes:95});
  assert(parts.length>2);
  assert(parts.every(piece=>Buffer.byteLength(piece,'utf8')<=95));
  assert.deepEqual(restoreWitness(parts),[line]);
  assert.throws(()=>decodeWitness('compute {"result":["num",NaN]}'),/Invalid semantic/);
});
test('expression budgets, spoofed references and unknown fields are rejected',()=>{
  assert.throws(()=>encodeWitness('compute',{expr:{op:'literal',value:['num',4]},
    result:['num',4],privateEvent:14}),/Invalid semantic/);
  assert.throws(()=>encodeWitness('input',{graph:{
    roots:[['ref','o99']],objects:[]}}),/Invalid semantic/);
  const leaf={op:'literal',value:['num',1]};
  let tree=leaf;
  for(let i=0;i<9;i++)tree={op:'binary',operator:'+',left:tree,right:leaf};
  assert.throws(()=>validateExpression(tree),/operator budget/);
});
test('controller mutations and FIFO jobs are independent of source interpreter',()=>{
  const code=encodeWitness('code',{entry:'run',source:'function run(){}',sites:[]});
  const input=encodeWitness('input',{graph:{roots:[],objects:[]}});
  const selected=new WitnessController([code,input],{completionPolicy:'owned-quiescence'});
  selected.commit(encodeWitness('allocate',{name:'o1',kind:'array',length:3,
    properties:[{key:'1',value:['undefined']}]}));
  assert.equal(selected.heap.get('o1').properties.has('0'),false);
  selected.commit(encodeWitness('job',{action:'enqueue',job:'j1',owner:'i1'}));
  selected.commit(encodeWitness('job',{action:'enqueue',job:'j2',owner:'i1'}));
  assert.throws(()=>selected.commit(encodeWitness('job',
    {action:'dispatch',job:'j1',owner:'i1'})),e=>e.category==='job');
  selected.commit(encodeWitness('return',{value:['ref','o1']}));
  assert.throws(()=>selected.commit(encodeWitness('job',
    {action:'dispatch',job:'j2',owner:'i1'})),e=>e.category==='job');
  selected.commit(encodeWitness('job',{action:'dispatch',job:'j1',owner:'i1'}));
  selected.commit(encodeWitness('job',{action:'complete',job:'j1',owner:'i1'}));
  selected.commit(encodeWitness('job',{action:'dispatch',job:'j2',owner:'i1'}));
  selected.commit(encodeWitness('job',{action:'complete',job:'j2',owner:'i1'}));
  selected.commit(encodeWitness('end',{kind:'return'}));
  const graph=selected.observedGraph();
  assert.equal(graph.objects[0].properties.filter(p=>p[0]==='0').length,0);
  assert.equal(graph.objects[0].properties.find(p=>p[0]==='1')[1][0],'undefined');
});

test('nested pure guest helper keeps one dynamic call and real child completion',()=>{
  const episode=sourceCase(
    'function inc(y){return y+1;}function run(x){return inc(x);}',[4]);
  const trace=episode.sidecar.compiled.generated.map(decodeWitness);
  assert(trace.some(record=>record.kind==='call'));
  assert.equal(trace.filter(record=>record.kind==='return').length,2);
  assert.equal(evaluateWitnessTrajectory({
    groups:episode.public.groups,referenceOutcome:episode.sidecar.reference
  }).correctness,'correct');
});
test('selected fresh object names are independent of reference spelling',()=>{
  const code=encodeWitness('code',{entry:'run',source:'function run(){return {n:2};}',sites:[]});
  const input=encodeWitness('input',{graph:{roots:[],objects:[]}});
  const controller=new WitnessController([code,input]);
  controller.commit(encodeWitness('allocate',{name:'o77',kind:'object',
    properties:[{key:'n',value:['num',2]}]}));
  controller.commit(encodeWitness('return',{value:['ref','o77']}));
  controller.commit(encodeWitness('end',{kind:'return'}));
  assert.deepEqual(controller.observedGraph().objects[0].properties,[['n',['num',2]]]);
});

test('pending return through finally closes only after observable cleanup mutation',()=>{
  const episode=sourceCase(
    'function run(o){try{return o.n;}finally{o.n+=3;}}',[{n:2}]);
  assert.equal(validateWitnessTrainingExport(episode).valid,true);
  const trace=episode.sidecar.compiled.generated.map(decodeWitness);
  assert.equal(trace.filter(e=>e.kind==='return').length,1);
  const transfer=trace.findIndex(e=>e.kind==='transfer');
  const update=trace.findIndex((e,i)=>i>transfer&&e.kind==='write');
  const actual=trace.findIndex(e=>e.kind==='return');
  assert(transfer>=0&&update>transfer&&actual>update);
  assert.deepEqual(trace[actual].fields.value,['num',2]);
  assert.equal(evaluateWitnessTrajectory({
    groups:episode.public.groups,referenceOutcome:episode.sidecar.reference
  }).correctness,'correct');
});
test('finally replacement return supersedes saved primitive but keeps mutation',()=>{
  const episode=sourceCase(
    'function run(o){try{return o.n;}finally{o.n+=3;return o.n;}}',[{n:2}]);
  const trace=episode.sidecar.compiled.generated.map(decodeWitness);
  assert.equal(trace.filter(e=>e.kind==='return').length,1);
  assert(trace.findIndex(e=>e.kind==='transfer')>=0);
  assert.deepEqual(trace.find(e=>e.kind==='return').fields.value,['num',5]);
  assert.equal(validateWitnessTrainingExport(episode).valid,true);
});
