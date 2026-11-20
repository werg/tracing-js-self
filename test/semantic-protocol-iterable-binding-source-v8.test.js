import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';

const fixture=body=>({source:'"use strict";function run(){'+body+'}',entry:'run',family:'iterable-binding-source',timeoutMs:30000});
const cases=[
  ['early-close','let log="";const it={[Symbol.iterator](){return this;},next(){return {done:false,value:3};},return(){log+="c";return {};}};const [first]=it;return first+log;',['str','3c']],
  ['empty-pattern','let log="";const it={[Symbol.iterator](){log+="a";return this;},get next(){log+="g";return function(){throw 7;};},return(){log+="c";return {};}};const []=it;return log;',['str','agc']],
  ['array-override','const a=[1];a[Symbol.iterator]=function(){let done=false;return {next(){const r={done,value:9};done=true;return r;}};};const [first]=a;return first;',['num',9]],
  ['cached-next','let gets=0,calls=0,closed=0;let next=function(){calls++;this.next=()=>{throw 99;};return {done:false,value:this.mark+calls};};const it={mark:10,get next(){gets++;return next;},set next(v){next=v;},[Symbol.iterator](){return this;},return(){closed++;return {};}};const [a,b]=it;return a+":"+b+":"+gets+":"+calls+":"+closed;',['str','11:12:1:2:1']],
  ['elision','let log="";let i=0;const it={[Symbol.iterator](){return this;},next(){log+="n";return {get done(){log+="d";return false;},get value(){log+="v";return ++i;}};},return(){log+="c";return {};}};const [,second]=it;return second+log;',['str','1ndndvc']],
  ['rest-exhaustion','let i=0;const it={[Symbol.iterator](){return this;},next(){return {done:i===3,value:i++};},return(){throw 99;}};const [first,...tail]=it;return first+tail[0]+tail[1];',['num',3]],
  ['throwing-default','let log="";function fail(){throw 7;}const it={[Symbol.iterator](){return this;},next(){return {done:false,value:undefined};},return(){log+="c";throw 9;}};try{const [first=fail()]=it;}catch(e){return log+e;}',['str','c7']],
  ['next-failure','let closed=0;const it={[Symbol.iterator](){return this;},next(){throw 7;},return(){closed++;return {};}};try{const [first]=it;}catch(e){return closed+":"+e;}',['str','0:7']],
  ['done-failure','let closed=0;const it={[Symbol.iterator](){return this;},next(){return {get done(){throw 7;}};},return(){closed++;return {};}};try{const [first]=it;}catch(e){return closed+":"+e;}',['str','0:7']],
  ['value-failure','let closed=0;const it={[Symbol.iterator](){return this;},next(){return {done:false,get value(){throw 7;}};},return(){closed++;return {};}};try{const [first]=it;}catch(e){return closed+":"+e;}',['str','0:7']],
  ['completed-array-stays-done','const a=[];const [first=(a.push(1,2),0),second=5]=a;return first+second;',['num',5]],
  ['active-array-observes-growth','const a=[undefined];const [first=(a.push(2),1),second,...tail]=a;return first+second+tail.length;',['num',3]],
  ['done-skips-further-next','let calls=0,closed=0;const it={[Symbol.iterator](){return this;},next(){calls++;return {done:true,get value(){throw 9;}};},return(){closed++;return {};}};const [first=3,second=4,...tail]=it;return first+second+":"+calls+":"+closed;',['str','7:1:0']],
  ['default-number-throw','const o={valueOf(){throw 7;}};const it={[Symbol.iterator](){return this;},next(){return {done:false,value:undefined};},return(){throw 9;}};try{const [first=Number(o)]=it;}catch(e){return e;}',['num',7]]
];

test('flat iterable bindings retain iterator semantics through independent source and selected-state replay',async()=>{
  for(const [name,body,expected]of cases){
    const result=await verifyProtocolRegionTrainingCase({...fixture(body),family:name});assert(result.exported,name+': '+result.reason);
    const artifact=result.exported,reference=artifact.sidecar.sourceArtifact.sidecar.reference;
    assert.deepEqual(RegionExecutionHarness.replay(artifact).controller.completion,{kind:'return',value:expected},name);
    assert.equal(reference.completionAudit.status,'agreed');
    if(!name.includes('array-')&&!name.includes('-array-'))assert.equal(reference.extensionAudit.status,'agreed');
    const observations=reference.observations.extensions?.find(row=>row.profile==='custom-iterator-observations/1')?.rows??[];
    if(name==='empty-pattern')assert.equal(observations.filter(row=>row.kind==='call'&&row.operation==='next').length,0);
    if(name==='elision')assert.equal(observations.filter(row=>row.kind==='read'&&row.operation==='value').length,1);
    if(name==='rest-exhaustion'||name.endsWith('-failure'))assert.equal(observations.filter(row=>row.operation==='return').length,0);
  }
});

test('binding checkpoints retain cached next and early-close obligations without repeating source effects',async()=>{
  const result=await verifyProtocolRegionTrainingCase(fixture(cases.find(row=>row[0]==='cached-next')[1]));assert(result.exported,result.reason);
  const artifact=result.exported;assert.equal((await recheckProtocolRegionEvidence(artifact)).sourceValidated,true);
  const rows=artifact.public.timeline,boundaries=rows.flatMap((row,index)=>row.fields?.line?.includes('semantic-handler-scopes/1')||
    row.fields?.line?.includes('"kind":"call"')?[index]:[]);assert(boundaries.length>=5);
  for(const index of boundaries){
    const prefix=structuredClone(artifact);prefix.public.timeline=rows.slice(0,index+1);
    const selected=RegionExecutionHarness.replay(prefix,{requireTerminal:false}),restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(selected.checkpoint())));
    assert.deepEqual(restored.modelContext('invocation1'),selected.modelContext('invocation1'));
    for(const row of rows.slice(index+1))restored.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
    assert.deepEqual(restored.exportEpisode(),artifact.public);
    assert.deepEqual(restored.controller.completion,{kind:'return',value:['str','11:12:1:2:1']});
  }
});

test('nested patterns, assignment patterns and captured builtin methods retain explicit source refusals',async()=>{
  for(const body of [
    'const [[first]]=[[3]];return first;',
    'let first=0;[first]=[3];return first;',
    'const [first]="a";return first;'
  ]){const result=await verifyProtocolRegionTrainingCase(fixture(body));assert.equal(result.status,'unsupported',result.reason);assert(!result.exported);}
});
