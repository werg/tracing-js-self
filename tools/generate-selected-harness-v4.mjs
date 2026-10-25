#!/usr/bin/env node
// Controlled real-broker fixture for the cross-repository v4-envelope/v3-witness
// compatibility contract. This is NOT an admitted teacher episode or a model.
import {writeFileSync} from 'node:fs';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
import {encodeWitness} from '../src/training/format.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';

const source='"use strict";function run(key){const current=host.readAsync(key);const next=current+1;host.store(key,next);return next;}';
const sites=analyzeSemanticProgram(source).sites;
const site=operation=>{
  const chosen=sites.find(candidate=>candidate.operation===operation);
  if(!chosen)throw new Error('Unregistered program callsite '+operation);
  return {start:chosen.start,end:chosen.end};
};
const witness=(effect,operation,args,payload)=>encodeWitness('request',{
  effect,operation,invocation:'i1',site:site(operation),arguments:args,payload
});
const values=new Map([['counter',7],['second',21]]);
const receipts=[];
const services={
  'demo.readAsync':async([key],meta)=>{
    receipts.push({effect:meta.effectId,invocation:meta.invocationId,operation:meta.operation});
    return values.get(key);
  },
  'demo.store':([key,value],meta)=>{
    receipts.push({effect:meta.effectId,invocation:meta.invocationId,operation:meta.operation});
    values.set(key,value);
  }
};
const harness=new SelectedExecutionHarness({sessionId:'interop1',services});
harness.publishProgram({programId:'counter',source,entry:'run',
  capabilities:['demo.readAsync','demo.store']});

for(const [invocation,track,key] of [
  ['outside1','worker:1','counter'],['outside2','worker:2','second']
]){
  harness.admitInvocation({programId:'counter',invocationId:invocation,
    trackId:track,realmId:'realm:'+invocation,
    triggerId:'caller:'+invocation,args:[key]});
  harness.selected(invocation,witness('fx1','demo.readAsync',
    [['str',key]],JSON.stringify([key])));
  const read=await harness.dispatch(invocation,'fx1');
  if(read.status!=='fulfilled')throw new Error('Expected tool read to succeed');
  const previous=read.result[1],next=previous+1;
  harness.selected(invocation,encodeWitness('compute',{
    expr:{op:'binary',operator:'+',left:{op:'literal',value:['num',previous]},
      right:{op:'literal',value:['num',1]}},result:['num',next]
  }));
  harness.selected(invocation,witness('fx2','demo.store',
    [['str',key],['num',next]],JSON.stringify([key,next])));
  await harness.dispatch(invocation,'fx2');
  harness.selected(invocation,encodeWitness('return',{value:['num',next]}));
  harness.selected(invocation,encodeWitness('end',{kind:'return'}));
}
if(values.get('counter')!==8||values.get('second')!==22||receipts.length!==4)
  throw new Error('Fixture must contain four actual dispatched external effects');
const document=harness.exportEpisode({sourceLineage:'fixture:counter:controlled'});
const outfile=process.argv[2];
if(outfile)writeFileSync(outfile,JSON.stringify(document)+'\n');
else process.stdout.write(JSON.stringify(document)+'\n');
