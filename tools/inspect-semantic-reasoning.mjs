// Inspect actual source-certified semantic witnesses, not hand-written trace
// sketches. Produces human-readable observed context, computations, mutations,
// callbacks, external operations, and completion in causal order.
import assert from 'node:assert/strict';
import {EFFECTFUL_ENGINEERING_FIXTURES} from '../src/training/engineering-fixtures.js';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
import {verifyOwnedSourceCase} from '../src/training/source-check.js';
import {decodeWitness} from '../src/training/format.js';
import {renderWitness} from '../src/training/render.js';

const wanted=process.argv.slice(2).length?process.argv.slice(2):[
  'counter-0','branch-1','compound-pure','compound-effectful',
  'callback-captured-write','rejection-finally','property-helper','seeded-random'
];
const ownedFixtures={
  'property-helper':{source:'"use strict"; function helper(value){return value+1;} '+
    'function run(box){if(box.count>3){box.count=2;} if(box.count>3){return 0;} return helper(box.count);}',
    entry:'run',args:[{count:4}]},
  'seeded-random':{source:'"use strict"; function sample(){return Math.random();} '+
    'function run(){Math.random();const a=sample();return a+Math.random();}',entry:'run',seed:0}
};
const rows=[];
for(const name of wanted){
  const fixture=Object.hasOwn(ownedFixtures,name)?ownedFixtures[name]:
    EFFECTFUL_ENGINEERING_FIXTURES.find(candidate=>candidate.id===name);
  if(!fixture)throw new Error('Unknown fixture '+name);
  const result=Object.hasOwn(ownedFixtures,name)?verifyOwnedSourceCase(fixture):
    await verifyEffectfulTrainingCase({...fixture,
      projectionOptions:{...fixture.projectionOptions,representation:'compact'}});
  assert.equal(result.status,'locally_verified',name+': '+result.reason);
  const episode=result.exported,trace=episode.public.timeline;
  const witnessBytes=trace.filter(item=>item.kind==='semantic')
    .reduce((n,item)=>n+Buffer.byteLength(item.line,'utf8'),0);
  const semantic=trace.filter(row=>row.kind==='semantic')
    .map(row=>({...decodeWitness(row.line),sequence:row.sequence}));
  const markers={records:semantic.length,computations:semantic.filter(row=>row.kind==='compute').length,
    bindings:semantic.filter(row=>row.kind==='bind').length,
    choices:semantic.filter(row=>row.kind==='choose').length,
    writes:semantic.filter(row=>row.kind==='write').length,
    requests:semantic.filter(row=>row.kind==='request').length,
    observations:trace.filter(row=>row.kind==='result').length,
    events:trace.filter(row=>row.kind==='event').length,
    foldedConditions:episode.sidecar.compiler.compaction.foldedConditions,
    fusedBindings:episode.sidecar.compiler.compaction.fusedBindings,
    generatedRecords:episode.sidecar.compiler.generatedRecords,witnessBytes};
  const readable=trace.flatMap(row=>{
    if(row.kind==='program'&&row.randomSeed!==undefined)return [String(row.sequence).padStart(4)+
      ' observed: deterministic random seed '+row.randomSeed];
    if(['semantic','result'].includes(row.kind))return [
      String(row.sequence).padStart(4)+' '+(row.kind==='semantic'?'compute':'observed')+
        ': '+renderWitness(row.line)];
    if(row.kind==='invocation')return [String(row.sequence).padStart(4)+
      ' observed: invoke '+row.entry+' ('+row.activation+')'];
    if(row.kind==='event')return [String(row.sequence).padStart(4)+
      ' observed: event '+row.eventId+' -> '+row.invocationId];
    return [];
  });
  rows.push({fixture:name,...markers});
  console.log('\n=== '+name+' (actual verified source execution) ===');
  console.log(fixture.source);
  for(const line of readable)console.log(line);
  console.log('CHECKS '+JSON.stringify(markers));
}
console.log('\nSEMANTIC_TRACE_INSPECTION '+JSON.stringify(rows));
