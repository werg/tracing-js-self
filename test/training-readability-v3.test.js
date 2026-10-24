import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTrainingCase} from '../src/training/admit.js';
import {decodeWitness,restoreWitness} from '../src/training/format.js';

const cases=[
  {name:'arithmetic',body:'function run(x) { return x * 2 + 1; }',args:[7],answer:15},
  {name:'loop',body:'function run(a) { let sum=0; for(let i=0;i<a.length;i++) { sum += a[i]; } return sum; }',args:[[2,3,4]],answer:9},
  {name:'nested_calls',body:'function run(x) { function inc(y) { return x+y; } return inc(inc(1)); }',args:[4],answer:9},
  {name:'alias_mutation',body:'function run(o,d) { const a=o; a.n=a.n+d; return [o,a.n]; }',args:[{n:4},3]},
  {name:'map_reduce',body:'function run(a) { return a.map(x=>x*2).reduce((s,x)=>s+x,0); }',args:[[2,3,4]],answer:18},
  {name:'map_mutation',body:'function run(a) { return a.map((x,i)=>{if(i===0)a[1]=50;return x;}); }',args:[[1,2,3]]},
  {name:'short_circuit',body:'function run(o) { return o && o.n > 0 ? o.n + 1 : 0; }',args:[{n:4}],answer:5},
  {name:'allocation_push',body:'function run(x) { const a=[x,x+1]; a.push(9); return a; }',args:[4]},
  {name:'repeated_reads',body:'function run(o) { const x=o.n; const y=o.n; return x+y; }',args:[{n:4}],answer:8},
  {name:'loop_captured',body:'function run(){ const fs=[]; for(let i=0;i<3;i++) { fs.push(()=>i); } return [fs[0](),fs[1](),fs[2]()]; }',args:[]}
];
for(const fixture of cases){
  test('version-three readability acceptance: '+fixture.name,()=>{
    const verified=verifyTrainingCase({source:'"use strict"; '+fixture.body,
      entry:'run',args:fixture.args,maxGenerated:2048,maxSteps:30000});
    assert.equal(verified.status,'locally_verified',fixture.name+' '+JSON.stringify({
      status:verified.status,reason:verified.reason}));
    const groups=verified.exported.public.groups;
    assert.equal(verified.exported.public.schema,'semantic-execution/3');
    const lines=restoreWitness(groups.filter(g=>g.mode==='generated')
      .flatMap(g=>g.events.map(e=>e.record)));
    const decoded=lines.map(decodeWitness);
    assert(decoded.every(({fields})=>!Object.hasOwn(fields,'shapeVersion')&&
      !Object.hasOwn(fields,'journalEvent')));
    assert.equal(decoded.at(-1).kind,'end');
    assert.equal(decoded.filter(v=>v.kind==='return'&&v.fields.invocation==='i1').length,1);
    if(Object.hasOwn(fixture,'answer'))
      assert.deepEqual(decoded.findLast(v=>v.kind==='return'&&v.fields.invocation==='i1')
        .fields.value,['num',fixture.answer]);
    if(fixture.name==='loop')assert(lines.length<=20,'loop requires <=20 semantic records');
  });
}
