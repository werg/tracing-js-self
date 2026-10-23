import test from 'node:test';
import assert from 'node:assert/strict';
import {auditPublicCausality} from '../src/training/causal-audit.js';
import {encodeRecord,fragmentLine} from '../src/training/format.js';
import {verifyTrainingCase} from '../src/training/admit.js';
const observed=record=>({mode:'observed',loss:'none',events:[{track:'t0',record}]});
const generated=record=>({mode:'generated',loss:'semantic',events:[{track:'t0',record}]});
function episode({length=20,maxBytes=512}={}){
 const code=encodeRecord('code',{sourceId:'s1',text:'x'.repeat(length),
   codes:[{id:'c1',params:[]}],sites:[]});
 const input=encodeRecord('value',{entry:'f',graph:{roots:[],objects:[]}});
 const groups=[...fragmentLine(code,{maxBytes}).map(observed),
   ...fragmentLine(input,{maxBytes}).map(observed),
   generated(encodeRecord('enter',{invocation:'i1',entry:'f',code:'c1',arguments:[]})),
   generated(encodeRecord('value',{id:'e1',invocation:'i1',result:['num',7]})),
   generated(encodeRecord('return',{id:'e2',invocation:'i1',
     dependsOn:['e1'],result:['num',7]})),
   generated(encodeRecord('end',{invocation:'i1',kind:'return'}))]
   .map((g,i)=>({...g,id:'m'+(i+1)}));
 return {schema:'semantic-execution/1',profile:'training-js/1',
   traceFormat:'semantic-trace/1',contextFormat:'semantic-context/1',
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
