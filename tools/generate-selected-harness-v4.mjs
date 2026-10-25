#!/usr/bin/env node
// Code once, two outside calls, actual asynchronous read/compute/write through
// the production selected driver. Selections are controlled engineering inputs.
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
import {SelectedModelDriver} from '../src/training/model-driver.js';
import {encodeWitness as witness} from '../src/training/format.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';

const source='"use strict";async function run(key){const current=await host.readAsync(key);const next=current+1;host.store(key,next);return next;}';
const sites=analyzeSemanticProgram(source).sites;
const site=operation=>{const found=sites.find(s=>s.operation===operation);return {start:found.start,end:found.end};};
const values=new Map([['counter',7],['second',21]]),calls=[];
const harness=new SelectedExecutionHarness({sessionId:'interop1',services:{
  'demo.readAsync':async([key],meta)=>{calls.push([meta.invocationId,'read',key]);return values.get(key);},
  'demo.store':([key,value],meta)=>{calls.push([meta.invocationId,'write',key,value]);values.set(key,value);}
}});
const steps=new Map();
const driver=new SelectedModelDriver({harness,select:async prefix=>{
  const invocation=prefix.invocationId,index=steps.get(invocation)??0;
  const key=prefix.committed.find(item=>item.kind==='invocation').inputGraph.roots[0][1];
  const reply=prefix.committed.find(item=>item.kind==='result'&&item.effectId==='read');
  const current=reply?.result[1],next=current+1,root='root'+invocation,read='read'+invocation;
  const lines=[
    ()=>witness('promise',{action:'create',promise:root}),
    ()=>witness('request',{effect:'read',operation:'demo.readAsync',arguments:[['str',key]],
      invocation,site:site('demo.readAsync'),payload:JSON.stringify([key]),promise:read}),
    ()=>witness('await',{promise:read,continuation:'resume',invocation,returnPromise:root}),
    ()=>witness('resume',{continuation:'resume',invocation,status:reply.status,result:reply.result}),
    ()=>witness('compute',{expr:{op:'binary',operator:'+',left:{op:'literal',value:['num',current]},
      right:{op:'literal',value:['num',1]}},result:['num',next]}),
    ()=>witness('request',{effect:'write',operation:'demo.store',arguments:[['str',key],['num',next]],
      invocation,site:site('demo.store'),payload:JSON.stringify([key,next])}),
    ()=>witness('promise',{action:'resolve',promise:root,value:['num',next]}),
    ()=>witness('return',{value:['ref',root]}),
    ()=>witness('end',{kind:'return'})
  ];
  if(!lines[index])throw new Error('Controlled fixture selection exhausted');
  steps.set(invocation,index+1);return lines[index]();
}});
try{
  for(const [invocationId,trackId,key,expected] of [
    ['outside1','worker:9','counter',8],['outside2','worker:12','second',22]]){
    const result=await driver.run({programId:'counter',source,entry:'run',
      capabilities:['demo.readAsync','demo.store'],invocationId,trackId,realmId:'shared',
      realmPolicy:'retained',completionPolicy:'await-returned-promise',triggerId:'caller:'+invocationId,args:[key]});
    assert.deepEqual(result.completion,{kind:'return',value:['num',expected]});
  }
}finally{driver.close();}
assert.equal(calls.length,4);assert.equal(harness.timeline.filter(r=>r.kind==='program').length,1);
const document=harness.exportEpisode({sourceLineage:'controlled:counter:two-invocations'});
const before=calls.length;SelectedExecutionHarness.replay(document);assert.equal(calls.length,before);
const outfile=process.argv[2];
if(outfile)writeFileSync(outfile,JSON.stringify(document)+'\n');
else process.stdout.write(JSON.stringify(document)+'\n');
