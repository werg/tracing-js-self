import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeWitness,decodeWitness} from '../src/training/format.js';
import {rewriteSemanticWitness} from '../src/training/rewrite.js';
import {SemanticController} from '../src/training/controller.js';
import {verifyTrainingCase} from '../src/training/admit.js';

const value=n=>['num',n];
const lit=n=>({op:'literal',value:value(n)});
const binary=(operator,left,right)=>({op:'binary',operator,left,right});
const record=(kind,fields)=>encodeWitness(kind,fields);
const certificate=(span,n)=>({record:n,rule:'primitive/1',
  semanticEvents:['e'+(n+1)],journalEvents:['j'+(n+1)],span});
const input=value(7);
const source='function run(x){return x*2+1;}';
const small={start:source.indexOf('x*2'),end:source.indexOf('x*2')+3};
const large={start:small.start,end:small.end+2};
const context=[
  record('code',{entry:'run',source,sites:[]}),
  record('input',{graph:{roots:[input],objects:[]}})
];
function rewrite(generated,certificates,extras={}){
  return rewriteSemanticWitness({generated,certificates,source,entry:'run',
    program:{functions:[{name:'run',params:['x']}]},
    inputGraph:{roots:[input],objects:[]},localNames:new Map(),
    maxOperators:4,...extras});
}

test('nested verified arithmetic becomes a checkable input-relative expression',()=>{
  const original=[
    record('compute',{expr:binary('*',lit(7),lit(2)),result:value(14),invocation:'i1'}),
    record('compute',{expr:binary('+',lit(14),lit(1)),result:value(15),invocation:'i1'}),
    record('return',{value:value(15),invocation:'i1'}),
    record('end',{kind:'return'})
  ];
  const certs=[certificate(small,0),certificate(large,1),
    certificate(null,2),certificate(null,3)];
  const result=rewrite(original,certs);
  assert.equal(result.generated.length,4);
  assert.deepEqual(decodeWitness(result.generated[0]),
    {kind:'bind',fields:{name:'arg0',value:value(7)}});
  const first=decodeWitness(result.generated[1]);
  assert.equal(first.kind,'compute');
  assert.deepEqual(first.fields.expr,binary('+',
    binary('*',{op:'local',name:'arg0'},lit(2)),lit(1)));
  assert.equal(result.certificates[1].rule,'fuse-expression/1');
  assert.deepEqual(result.certificates[1].journalEvents,['j1','j2']);
  const selected=new SemanticController(context);
  for(const line of result.generated)selected.commit(line);
  assert.deepEqual(selected.completion.value,value(15));
  assert.equal(selected.firstWitnessViolation,null);
});

test('separate source expressions are not fused merely because values coincide',()=>{
  const different='function run(x){const a=x*2;return 14+1;}';
  const original=[
    record('compute',{expr:binary('*',lit(7),lit(2)),result:value(14)}),
    record('compute',{expr:binary('+',lit(14),lit(1)),result:value(15)})
  ];
  const s1={start:different.indexOf('x*2'),end:different.indexOf('x*2')+3};
  const s2={start:different.indexOf('14+1'),end:different.indexOf('14+1')+4};
  const result=rewrite(original,[certificate(s1,0),certificate(s2,1)],{source:different});
  assert.equal(result.generated.map(decodeWitness).filter(r=>r.kind==='compute').length,2);
});

test('a source-related computed assignment becomes one coherent state transition',()=>{
  const text='function run(x){let y=x+1;return y*2;}';
  const calc={start:text.indexOf('x+1'),end:text.indexOf('x+1')+3};
  const declaration={start:text.indexOf('y=x+1'),end:text.indexOf('y=x+1')+5};
  const other={start:text.indexOf('y*2'),end:text.indexOf('y*2')+3};
  const originals=[
    record('compute',{expr:binary('+',lit(7),lit(1)),result:value(8)}),
    record('bind',{name:'y1',value:value(8)}),
    record('compute',{expr:binary('*',lit(8),lit(2)),result:value(16)})
  ];
  const result=rewrite(originals,[
    certificate(calc,0),certificate(declaration,1),certificate(other,2)
  ],{source:text,localNames:new Map([['y1','y']])});
  assert.equal(result.generated.length,3);
  const [inputAlias,first,second]=result.generated.map(decodeWitness);
  assert.equal(inputAlias.kind,'bind');
  assert.equal(first.fields.bind,'y1');
  assert.deepEqual(second.fields.expr.left,{op:'local',name:'y1'});
  const controller=new SemanticController([
    record('code',{entry:'run',source:text,sites:[]}),context[1]]);
  for(const line of result.generated)controller.commit(line);
  controller.commit(record('return',{value:value(16)}));
  controller.commit(record('end',{kind:'return'}));
  assert.equal(controller.firstWitnessViolation,null);
});

test('source-owned demonstrations retain independent outcome checks with a shorter context',()=>{
  const checked=verifyTrainingCase({source:'"use strict";'+source,entry:'run',args:[7]});
  assert.equal(checked.status,'locally_verified',checked.reason);
  const witness=checked.exported.sidecar.compiled.generated.map(decodeWitness);
  assert(witness.some(r=>r.kind==='compute'));
  assert.equal(witness.filter(r=>r.kind==='end').length,1);
  const sourceRecord=decodeWitness(checked.exported.sidecar.compiled.context[0]);
  assert.deepEqual(sourceRecord.fields.sites,[]);
  assert.deepEqual(checked.exported.sidecar.reference.graph.roots.at(-1),value(15));
});
