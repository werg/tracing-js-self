#!/usr/bin/env node
// Controlled selections through production parsing, state, dispatch and replay.
// These fixtures certify engineering behavior; they are not learned rollouts.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
import {encodeWitness as w} from '../src/training/format.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';

const output=resolve(process.argv[2]??'artifacts/selected-continuity-v4');
await mkdir(output,{recursive:true});
const fixtures=[];
const num=value=>['num',value];
function site(source,operation,index=0){
  const selected=analyzeSemanticProgram(source).sites.filter(item=>item.operation===operation)[index];
  return {start:selected.start,end:selected.end};
}
function finish(h,invocationId,value){
  h.selected(invocationId,w('return',{value}));h.selected(invocationId,w('end',{kind:'return'}));
}
async function save(name,h){
  const document=h.exportEpisode({sourceLineage:'controlled:continuity:'+name});
  assert.deepEqual(SelectedExecutionHarness.replay(document).timeline,h.timeline);
  await writeFile(join(output,name+'.json'),JSON.stringify(document)+'\n');
  await writeFile(join(output,name+'.txt'),h.inspect().join('\n')+'\n');
  fixtures.push({name,records:h.timeline.length,selectionOrigin:'controlled-test-injected'});
}

{
  const source='async function run(){const a=host.readAsync("a");const b=host.readAsync("b");return (await a)+(await b);}';
  const pending={};const h=new SelectedExecutionHarness({sessionId:'pair',services:{
    'demo.readAsync':([key])=>new Promise(resolve=>{pending[key]=resolve;})}});
  h.publishProgram({programId:'p',source,entry:'run',capabilities:['demo.readAsync']});
  h.admitInvocation({programId:'p',invocationId:'call',trackId:'worker:9',realmId:'r',triggerId:'outside',
    completionPolicy:'await-returned-promise'});
  h.selected('call',w('promise',{action:'create',promise:'root'}));
  for(const [index,key] of ['a','b'].entries())h.selected('call',w('request',{
    effect:key,operation:'demo.readAsync',invocation:'call',arguments:[['str',key]],
    payload:JSON.stringify([key]),site:site(source,'demo.readAsync',index),promise:'p'+key}));
  const a=h.dispatch('call','a'),b=h.dispatch('call','b');
  h.selected('call',w('await',{promise:'pa',continuation:'ca',invocation:'call',returnPromise:'root'}));
  await Promise.resolve();pending.b(4);await b;pending.a(2);await a;
  h.selected('call',w('resume',{continuation:'ca',invocation:'call',status:'fulfilled',result:num(2)}));
  h.selected('call',w('await',{promise:'pb',continuation:'cb',invocation:'call'}));
  h.selected('call',w('resume',{continuation:'cb',invocation:'call',status:'fulfilled',result:num(4)}));
  h.selected('call',w('compute',{expr:{op:'binary',operator:'+',left:{op:'literal',value:num(2)},
    right:{op:'literal',value:num(4)}},result:num(6)}));
  h.selected('call',w('promise',{action:'resolve',promise:'root',value:num(6)}));
  finish(h,'call',['ref','root']);await save('async-pair',h);
}

{
  const source='function run(){return Promise.resolve(1).finally(cleanup);}function cleanup(){return host.readAsync("cleanup");}';
  let reject;
  const h=new SelectedExecutionHarness({sessionId:'finally',services:{
    'demo.readAsync':()=>new Promise((_,failed)=>{reject=failed;})}});
  h.publishProgram({programId:'p',source,entry:'run',capabilities:['demo.readAsync']});
  h.admitInvocation({programId:'p',invocationId:'call',trackId:'worker',realmId:'r',triggerId:'outside',
    completionPolicy:'await-returned-promise'});
  h.selected('call',w('allocate',{name:'fn',kind:'closure',code:'cleanup',properties:[],captures:[]}));
  h.selected('call',w('promise',{action:'create',promise:'original'}));
  h.selected('call',w('promise',{action:'resolve',promise:'original',value:num(1)}));
  h.selected('call',w('promise',{action:'react',promise:'original',job:'cleanup',reaction:'finally',closure:'fn',target:'result'}));
  h.selected('call',w('return',{value:['ref','result']}));
  h.selected('call',w('job',{action:'dispatch',job:'cleanup',owner:'call'}));
  h.selected('call',w('request',{effect:'cleanup',operation:'demo.readAsync',invocation:'job:cleanup',
    arguments:[['str','cleanup']],payload:'["cleanup"]',site:site(source,'demo.readAsync'),promise:'native'}));
  const native=h.dispatch('call','cleanup');
  h.selected('call',w('return',{value:['ref','native'],invocation:'job:cleanup'}));
  h.selected('call',w('job',{action:'complete',job:'cleanup',owner:'call'}));
  await Promise.resolve();reject(new Error('cleanup failed'));await native;
  h.selected('call',w('end',{kind:'return'}));
  assert.deepEqual(h.invocations.get('call').controller.completion,{kind:'throw',value:['str','cleanup failed']});
  await save('promise-finally',h);
}

{
  const source='function run(){return host.listen("tick",onTick);}function onTick(delta){counter+=delta;host.store("counter",counter);return counter;}function close(token){return host.unlisten(token);}';
  let fire;const writes=[];
  const h=new SelectedExecutionHarness({sessionId:'listeners',services:{
    'demo.listen':(_,meta)=>{fire=meta.callback(1);return meta.subscriptionId(1);},
    'demo.store':args=>writes.push(args),
    'demo.unlisten':([token],meta)=>{meta.closeSubscription(token);}}});
  h.publishProgram({programId:'p',source,entry:'run',capabilities:['demo.listen','demo.store','demo.unlisten']});
  h.admitInvocation({programId:'p',invocationId:'register',trackId:'worker',realmId:'shared',triggerId:'outside',realmPolicy:'retained'});
  h.selected('register',w('bind',{name:'counter',value:num(0)}));
  h.selected('register',w('allocate',{name:'fn',kind:'closure',code:'onTick',properties:[],captures:[{binding:'counter',cell:'counter'}]}));
  h.selected('register',w('request',{effect:'listen',operation:'demo.listen',invocation:'register',
    arguments:[['str','tick'],['ref','fn']],payload:'["tick",{"$ownedCallback":"fn"}]',
    site:site(source,'demo.listen'),promise:'listen'}));
  await h.dispatch('register','listen');finish(h,'register',['str','callback1']);
  for(const [ordinal,delta,total] of [[1,2,2],[2,3,5]]){
    fire(delta);const owner='event'+ordinal;
    h.selected(owner,w('compute',{expr:{op:'binary',operator:'+',left:{op:'local',name:'counter'},
      right:{op:'local',name:'delta'}},result:num(total),bind:'counter'}));
    h.selected(owner,w('request',{effect:'write',operation:'demo.store',invocation:owner,
      arguments:[['str','counter'],num(total)],payload:JSON.stringify(['counter',total]),site:site(source,'demo.store')}));
    await h.dispatch(owner,'write');finish(h,owner,num(total));
  }
  h.admitInvocation({programId:'p',invocationId:'close',entry:'close',trackId:'worker',realmId:'shared',
    triggerId:'outside-close',realmPolicy:'retained',args:['callback1']});
  h.selected('close',w('request',{effect:'close',operation:'demo.unlisten',invocation:'close',
    arguments:[['str','callback1']],payload:'["callback1"]',site:site(source,'demo.unlisten'),promise:'closed'}));
  await h.dispatch('close','close');finish(h,'close',['undefined']);
  assert.deepEqual(writes,[['counter',2],['counter',5]]);
  assert.throws(()=>fire(9),/revoked/);await save('retained-events',h);
}

{
  const source='async function run(){return await host.readAsync("durable");}';
  let resolveNative,calls=0;
  const h=new SelectedExecutionHarness({sessionId:'restore',services:{'demo.readAsync':()=>{
    calls++;return new Promise(resolve=>{resolveNative=resolve;});}}});
  h.publishProgram({programId:'p',source,entry:'run',capabilities:['demo.readAsync']});
  h.admitInvocation({programId:'p',invocationId:'call',trackId:'worker',realmId:'shared',triggerId:'outside',realmPolicy:'retained'});
  h.selected('call',w('request',{effect:'read',operation:'demo.readAsync',invocation:'call',
    arguments:[['str','durable']],payload:'["durable"]',site:site(source,'demo.readAsync'),promise:'pending'}));
  const pending=h.dispatch('call','read');await Promise.resolve();
  h.selected('call',w('await',{promise:'pending',continuation:'resume',invocation:'call'}));
  const restored=SelectedExecutionHarness.restore(JSON.parse(JSON.stringify(h.checkpoint())));
  restored.evictSource('worker','p');restored.restoreSource('worker','p');
  restored.reconcile('call','read',{disposition:'fulfilled',evidenceId:'service:lookup:read',value:7});
  restored.selected('call',w('resume',{continuation:'resume',invocation:'call',status:'fulfilled',result:num(7)}));
  finish(restored,'call',num(7));assert.equal(calls,1);await save('checkpoint-recovery',restored);
  resolveNative(7);await pending;
}
await writeFile(join(output,'manifest.json'),JSON.stringify({schema:'selected-engineering-fixtures/4',fixtures},null,2)+'\n');
process.stdout.write(JSON.stringify({directory:output,fixtures})+'\n');
