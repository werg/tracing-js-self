import test from 'node:test';
import assert from 'node:assert/strict';
import {auditPublicCausality} from '../src/training/causal-audit.js';
import {encodeRecord,decodeRecord,fragmentLine} from '../src/training/format.js';
import {verifyTrainingCase} from '../src/training/admit.js';
const observed=record=>({mode:'observed',loss:'none',events:[{track:'t0',record}]});
const generated=record=>({mode:'generated',loss:'semantic',events:[{track:'t0',record}]});
function episode({length=20,maxBytes=512}={}){
 const code=encodeRecord('code',{sourceId:'s1',text:'x'.repeat(length),
   codes:[{id:'c1',params:[],async:false}],sites:[],staticFunctions:[]});
 const input=encodeRecord('value',{entry:'f',invocation:'i1',graph:{roots:[],objects:[]}});
 const groups=[...fragmentLine(code,{maxBytes}).map(observed),
   ...fragmentLine(input,{maxBytes}).map(observed),
   generated(encodeRecord('enter',{invocation:'i1',entry:'f',code:'c1',arguments:[]})),
   generated(encodeRecord('value',{id:'e1',invocation:'i1',result:['num',7]})),
   generated(encodeRecord('return',{id:'e2',invocation:'i1',
     dependsOn:['e1'],result:['num',7]})),
   generated(encodeRecord('end',{invocation:'i1',kind:'return'}))]
   .map((g,i)=>({...g,id:'m'+(i+1)}));
 return {schema:'semantic-execution/2',profile:'training-js/1',
   traceFormat:'semantic-trace/2',contextFormat:'semantic-context/2',
   completionPolicy:'immediate-return',groups};
}
test('public-only causal audit accepts ordered explicit producer links',()=>{
 const result=auditPublicCausality(episode());
 assert.equal(result.valid,true);
 assert.equal(result.semanticEvents,2);
 assert.equal(result.generatedRecords,4);
});
test('fragmented source context cannot switch lanes, modes, or end prematurely',()=>{
 const x=episode({length:1100,maxBytes:96});
 assert(x.groups.length>10);
 assert.equal(auditPublicCausality(x,{maxBytes:96}).valid,true);
 const bad=structuredClone(x);bad.groups[1].events[0].track='t1';
 assert.throws(()=>auditPublicCausality(bad,{maxBytes:96}),/Fragment crossed/);
 const incomplete=structuredClone(x);incomplete.groups.pop();
 assert.throws(()=>auditPublicCausality(incomplete,{maxBytes:96}),/terminal/);
});
test('public-only audit refuses uncommitted dependency and duplicate producer',()=>{
 const x=episode();
 const future=structuredClone(x);
 future.groups[3].events[0].record=encodeRecord('value',{
   id:'e1',invocation:'i1',result:['num',7],dependsOn:['e2']});
 assert.throws(()=>auditPublicCausality(future),/Future or unpublished/);
 const duplicate=structuredClone(x);
 duplicate.groups[4].events[0].record=encodeRecord('return',{
   id:'e1',invocation:'i1',result:['num',7],dependsOn:['e1']});
 assert.throws(()=>auditPublicCausality(duplicate),/Nonchronological or duplicate/);
});
test('actual exported candidate episode satisfies public-only causal audit',()=>{
 const verified=verifyTrainingCase({source:'"use strict";function f(o){o.x=o.x+1;return o.x;}',
   entry:'f',args:[{x:2}]});
 assert.equal(verified.status,'locally_verified',JSON.stringify(verified));
 const result=auditPublicCausality(verified.exported.public,
   {maxBytes:verified.exported.sidecar.limits.maxBytes});
 assert.equal(result.valid,true);
 assert(result.semanticEvents>0);
});

test('public-only audit rejects metadata smuggling in visible records and meridians',()=>{
 const x=episode();
 const hidden=structuredClone(x);
 hidden.groups[0].futureAnswer={result:99};
 assert.throws(()=>auditPublicCausality(hidden),/Invalid public group/);
 const prefix=structuredClone(x);
 const code=decodeRecord(prefix.groups[0].events[0].record);
 code.fields.referenceOutcome={result:99};
 assert.throws(()=>encodeRecord(code.kind,code.fields),/Unexpected/);
 prefix.groups[0].events[0].record=code.kind+' '+JSON.stringify(code.fields);
 assert.throws(()=>auditPublicCausality(prefix),/observed source bundle/);
 const input=structuredClone(x);
 const arg=decodeRecord(input.groups[1].events[0].record);
 arg.fields.graph.outcome={result:99};
 input.groups[1].events[0].record=encodeRecord(arg.kind,arg.fields);
 assert.throws(()=>auditPublicCausality(input),/observed input graph/);
 const generated=structuredClone(x);
 const original=decodeRecord(generated.groups[3].events[0].record);
 original.fields.oracle={result:99};
 assert.throws(()=>encodeRecord(original.kind,original.fields),/Unexpected/);
 generated.groups[3].events[0].record=original.kind+' '+JSON.stringify(original.fields);
 assert.throws(()=>auditPublicCausality(generated),/Unexpected/);
});

function nestedEpisode() {
  const x=episode();
  x.groups=[
    ...x.groups.slice(0,2),
    generated(encodeRecord('enter',{invocation:'i1',entry:'f',code:'c1',arguments:[]})),
    generated(encodeRecord('call',{id:'e1',invocation:'i1',child:'i2',code:'c1',
      receiver:['undefined'],arguments:[],captures:null})),
    generated(encodeRecord('enter',{invocation:'i2',code:'c1',
      receiver:['undefined'],arguments:[],captures:null,dependsOn:['e1']})),
    generated(encodeRecord('return',{id:'e2',invocation:'i2',destination:'i1',
      result:['num',2]})),
    generated(encodeRecord('return',{id:'e3',invocation:'i1',result:['num',2]})),
    generated(encodeRecord('end',{invocation:'i1',kind:'return'}))
  ].map((group,i)=>({...group,id:'m'+(i+1)}));
  return x;
}
test('public causal audit binds the root entry and requires an actual root return',()=>{
  const mismatched=episode();
  const root=decodeRecord(mismatched.groups[2].events[0].record);
  root.fields.invocation='forged';
  mismatched.groups[2].events[0].record=encodeRecord(root.kind,root.fields);
  assert.throws(()=>auditPublicCausality(mismatched),/Root entered/);
  const noReturn=episode();
  noReturn.groups.splice(4,1);
  noReturn.groups.forEach((group,i)=>{group.id='m'+(i+1);});
  assert.throws(()=>auditPublicCausality(noReturn),/completed root return/);
  const wrongFrame=episode();
  const ret=decodeRecord(wrongFrame.groups[4].events[0].record);
  ret.fields.invocation='i999';
  wrongFrame.groups[4].events[0].record=encodeRecord(ret.kind,ret.fields);
  assert.throws(()=>auditPublicCausality(wrongFrame),/active invocation/);
});
test('public causal audit enforces declared child entry and stack returns',()=>{
  assert.equal(auditPublicCausality(nestedEpisode()).valid,true);
  const missing=nestedEpisode();
  missing.groups.splice(4,1);
  missing.groups.forEach((group,i)=>{group.id='m'+(i+1);});
  assert.throws(()=>auditPublicCausality(missing),/Call child not entered/);
  const misbound=nestedEpisode();
  const entered=decodeRecord(misbound.groups[4].events[0].record);
  entered.fields.arguments=[['num',99]];
  misbound.groups[4].events[0].record=encodeRecord(entered.kind,entered.fields);
  assert.throws(()=>auditPublicCausality(misbound),/Unjustified child/);
  const parentBeforeChild=nestedEpisode();
  [parentBeforeChild.groups[5],parentBeforeChild.groups[6]]=
    [parentBeforeChild.groups[6],parentBeforeChild.groups[5]];
  parentBeforeChild.groups.forEach((group,i)=>{group.id='m'+(i+1);});
  assert.throws(()=>auditPublicCausality(parentBeforeChild),/active invocation/);
  const wrongDestination=nestedEpisode();
  const ret=decodeRecord(wrongDestination.groups[5].events[0].record);
  ret.fields.destination='i999';
  wrongDestination.groups[5].events[0].record=encodeRecord(ret.kind,ret.fields);
  assert.throws(()=>auditPublicCausality(wrongDestination),/Return destination/);
});

function withPublishedGraph(graph) {
  const x=episode();
  const visible=decodeRecord(x.groups[1].events[0].record);
  visible.fields.graph=graph;
  x.groups[1].events[0].record=encodeRecord(visible.kind,visible.fields);
  const root=decodeRecord(x.groups[2].events[0].record);
  root.fields.arguments=graph.roots;
  x.groups[2].events[0].record=encodeRecord(root.kind,root.fields);
  return x;
}
test('published graph supports verified aliases and cycles without private heap',()=>{
  const graph={roots:[['ref','o1'],['ref','o1']],objects:[{
    id:'o1',kind:'object',shapeVersion:0,
    properties:[{key:'self',value:['ref','o1'],version:0}]
  }]};
  assert.equal(auditPublicCausality(withPublishedGraph(graph)).valid,true);
});
test('public-only audit rejects phantom references, malformed scalars and sparse arrays',()=>{
  const makeGraph=()=>({roots:[['ref','o1']],objects:[{
    id:'o1',kind:'object',shapeVersion:0,
    properties:[{key:'x',value:['num',1],version:0}]
  }]});
  const dangling=makeGraph();dangling.objects[0].properties[0].value=['ref','unpublished'];
  const missing=makeGraph();missing.roots=[['ref','ghost']];
  const duplicate=makeGraph();duplicate.objects.push(structuredClone(duplicate.objects[0]));
  const malformed=makeGraph();malformed.objects[0].properties[0].value=['num','1'];
  const sparse={roots:[['ref','o1']],objects:[{
    id:'o1',kind:'array',shapeVersion:0,
    properties:[{key:'0',value:['num',3],version:0},
      {key:'length',value:['num',2],version:0}]
  }]};
  const overflow={roots:[['ref','o1']],objects:[{
    id:'o1',kind:'array',shapeVersion:0,
    properties:[{key:'length',value:['num',4097],version:0}]
  }]};
  const extraProperty=makeGraph();
  extraProperty.objects[0].properties.push({key:'x',value:['num',9],version:1});
  for(const graph of [dangling,missing,duplicate,malformed,sparse,overflow,extraProperty])
    assert.throws(()=>auditPublicCausality(withPublishedGraph(graph)),/input graph|Unpublished reference/);
});
