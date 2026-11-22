// The original source, host registration and journalled arrival are real.
// Supplied lexical decisions isolate the recovery protocol; no learned claim.
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {RegionExecutionHarness} from '../../src/semantic/region-harness.js';
import {commitCausalLmV8Selection} from '../../src/semantic/causal-lm-v8.js';
import {encodeDetailedRecord} from '../../src/semantic/detail-v8.js';
import {analyzeSemanticProgram} from '../../src/training/semantic-program.js';
import {DurableHostIngressJournal,DurableHostIngressBroker} from '../../src/storage/host-ingress-journal.js';

export const lateCallbackSource='"use strict";function run(){host.listen("tick",handler);return 1;}function handler(value){return value;}';

export async function lateCallbackFixture(directory){
  let referenceRegistrations=0,referenceCallback;
  const referenceRoot=runInNewContext(lateCallbackSource+';run();',{host:{listen(name,callback){
    assert.equal(name,'tick');referenceRegistrations++;referenceCallback=callback;return 1;
  }}});
  assert.equal(referenceRoot,1);assert.equal(referenceCallback(5),5);assert.equal(referenceRegistrations,1);
  const line=(kind,fields)=>encodeDetailedRecord({kind,fields}),
    {start,end}=analyzeSemanticProgram(lateCallbackSource).sites.find(row=>row.operation==='demo.listen'),
    records=[line('allocate',{name:'fn',kind:'closure',code:'handler',captures:[],properties:[]}),
      line('request',{effect:'registration',operation:'demo.listen',invocation:'root',
        arguments:[['str','tick'],['ref','fn']],site:{start,end},
        payload:'["tick",{"$ownedCallback":"fn"}]',promise:'registration'}),
      line('return',{value:['num',1]}),line('end',{kind:'return'}),
      line('return',{value:['num',5]}),line('end',{kind:'return'})];
  let registrations=0;
  const bridge=new RegionExecutionHarness({sessionId:'late-callback',automaticDelivery:false,
    services:{'demo.listen':(_,meta)=>{registrations++;return meta.subscriptionId(1);}}});
  bridge.publishProgram({programId:'listener-source',source:lateCallbackSource,entry:'run',capabilities:['demo.listen']});
  bridge.admitInvocation({programId:'listener-source',invocationId:'root',trackId:'listener-track',
    realmId:'listener-realm',triggerId:'original-call',realmPolicy:'retained',args:[]});
  const initialPublic=bridge.exportEpisode(),contexts=[];
  for(let index=0;index<4;index++){
    const context=bridge.modelContext('root');contexts.push(structuredClone(context));
    commitCausalLmV8Selection(bridge,'root',records[index],{context});
    if(index===1)await bridge.dispatch('root','registration');
  }
  assert.equal(registrations,1);assert.equal(bridge.invocations.get('root').status,'completed');
  const rootPublic=bridge.exportEpisode(),checkpoint=bridge.checkpoint(),
    journal=new DurableHostIngressJournal({directory,streamId:'late-callback-arrivals'}),
    broker=new DurableHostIngressBroker({harness:bridge,journal});
  await bridge.postEvent({subscriptionId:'callback1',eventId:'after-checkpoint',args:[5],deliver:false});
  await broker.flush();
  const ingressReceipt=structuredClone(broker.receipt),
    restored=await RegionExecutionHarness.restoreDurable(checkpoint,{ingressJournal:journal,
      ingressLogReceipt:ingressReceipt});
  assert.deepEqual(restored.exportEpisode(),rootPublic);
  assert(!JSON.stringify(restored.modelContext('root')).includes('after-checkpoint'));
  restored.deliverReadyEvents('callback1');
  const admissionPublic=restored.exportEpisode(),callback=admissionPublic.timeline.at(-1).fields.invocationId;
  assert.equal(admissionPublic.timeline.at(-1).kind,'invocation');
  assert.equal(restored.handlers.get('callback1').state,'lost');
  for(let index=4;index<records.length;index++){
    const context=restored.modelContext(callback);contexts.push(structuredClone(context));
    commitCausalLmV8Selection(restored,callback,records[index],{context});
  }
  assert.equal(registrations,1);assert.equal(restored.invocations.get(callback).status,'completed');
  return {schema:'late-callback-original-input-fixture/1',source:lateCallbackSource,originalArguments:[],
    reference:{registrations:referenceRegistrations,root:referenceRoot,callback:referenceCallback(5)},
    registrations,initialPublic,rootPublic,admissionPublic,public:restored.exportEpisode(),contexts,records,
    rootInvocation:'root',callbackInvocation:callback,ingressReceipt,
    ingressRecords:await journal.readAll(ingressReceipt),rootCheckpoint:checkpoint,
    scope:{suppliedLexicalDecisions:true,learnedQuality:false,sourceAdmissionClaim:false,
      arrivalRecordedAfterCheckpoint:true,registrationRepeated:false}};
}
