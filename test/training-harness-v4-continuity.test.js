import test from 'node:test';
import assert from 'node:assert/strict';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
import {SelectedModelDriver} from '../src/training/model-driver.js';
import {SemanticController} from '../src/training/controller.js';
import {encodeWitness as w} from '../src/training/format.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';

const num=value=>['num',value];
const source='async function run(key){const a=host.readAsync(key);const b=host.readAsync("b");return (await a)+(await b);}function update(state){state.n++;return state.n;}';
const callSite=(text,operation,index=0)=>{
  const site=analyzeSemanticProgram(text).sites.filter(site=>site.operation===operation)[index];
  return {start:site.start,end:site.end};
};
function request(h,owner,effect,key,index=0){
  h.selected(owner,w('request',{effect,operation:'demo.readAsync',arguments:[['str',key]],
    invocation:owner,site:callSite(source,'demo.readAsync',index),payload:JSON.stringify([key]),promise:'p'+effect}));
}
function finish(h,owner,value){h.selected(owner,w('return',{value}));h.selected(owner,w('end',{kind:'return'}));}
function begin(h,{invocationId='first',args=[],...options}={}){
  if(!h.programs.has('p'))h.publishProgram({programId:'p',source,entry:'run',capabilities:['demo.readAsync']});
  h.admitInvocation({programId:'p',invocationId,trackId:'worker:'+invocationId,realmId:'shared',
    triggerId:'outside:'+invocationId,realmPolicy:'retained',completionPolicy:'await-returned-promise',args,...options});
}

test('await releases only its legal turn; retained controllers share cells, graphs and actual Promise state',async()=>{
  const arrivals={};
  const h=new SelectedExecutionHarness({services:{'demo.readAsync':([key])=>new Promise(resolve=>{arrivals[key]=resolve;})}});
  begin(h,{args:[{n:1}]});
  h.selected('first',w('promise',{action:'create',promise:'proot'}));
  request(h,'first','a','a');request(h,'first','b','b',1);
  const a=h.dispatch('first','a'),b=h.dispatch('first','b');
  h.selected('first',w('await',{promise:'pa',continuation:'ca',invocation:'first',returnPromise:'proot'}));
  assert.equal(h.realms.get('shared').running,null);
  assert.deepEqual(h.invocations.get('first').controller.callReturn,{kind:'return',value:['ref','proot']});
  begin(h,{invocationId:'other',entry:'update',inputGraph:{roots:[['ref','o0']],objects:[]}});
  const first=h.invocations.get('first').controller,other=h.invocations.get('other').controller;
  assert.equal(first.heap,other.heap);assert.equal(first.locals,other.locals);
  h.selected('other',w('write',{object:'o0',key:'n',value:num(2),present:true}));
  assert.throws(()=>h.selected('first',w('resume',{continuation:'ca',invocation:'first',result:num(2),status:'fulfilled'})),/another active/);
  finish(h,'other',num(2));
  await Promise.resolve();arrivals.b(4);await b;arrivals.a(2);await a;
  h.selected('first',w('resume',{continuation:'ca',invocation:'first',result:num(2),status:'fulfilled'}));
  assert.equal(first.readProperty('o0','n')[1],2);
  h.selected('first',w('await',{promise:'pb',continuation:'cb',invocation:'first'}));
  h.selected('first',w('resume',{continuation:'cb',invocation:'first',result:num(4),status:'fulfilled'}));
  h.selected('first',w('promise',{action:'resolve',promise:'proot',value:num(6)}));
  finish(h,'first',['ref','proot']);
  assert.deepEqual(first.completion,{kind:'return',value:num(6)});
  assert.deepEqual(SelectedExecutionHarness.replay(h.exportEpisode()).timeline,h.timeline);
});

test('an inner async suspension does not release its still-running caller',()=>{
  const h=new SelectedExecutionHarness();begin(h);
  h.selected('first',w('promise',{action:'create',promise:'pinner'}));
  h.selected('first',w('call',{child:'inner',callee:'update',receiver:['undefined'],arguments:[]}));
  h.selected('first',w('await',{promise:'pinner',continuation:'ci',invocation:'inner'}));
  assert.equal(h.realms.get('shared').running,'first');
  assert.deepEqual(h.invocations.get('first').controller.stack,['first']);
  assert.throws(()=>begin(h,{invocationId:'other'}),/active guest turn/);
});

test('source eviction rejects generation until an exact checked reread',()=>{
  const h=new SelectedExecutionHarness();begin(h);
  h.evictSource('worker:first','p');
  assert.throws(()=>finish(h,'first',num(1)),/Source is unavailable/);
  assert.equal(h.invocations.get('first').controller.generated,0);
  assert.throws(()=>h.restoreSource('worker:first','p',{digest:'forged'}),/digest/);
  h.restoreSource('worker:first','p');finish(h,'first',num(1));
  assert.deepEqual(SelectedExecutionHarness.replay(h.exportEpisode()).timeline,h.timeline);
  assert.match(h.inspect().join('\n'),/checked source/);
});

test('module loading is inert and initialization is explicit, exactly once across JSON restore',()=>{
  const h=new SelectedExecutionHarness();
  h.publishProgram({programId:'module',source:'function initialize(){return 1;}function run(){return 2;}',
    entry:'initialize',module:true});
  const admit=(invocationId,activation,entry)=>h.admitInvocation({programId:'module',invocationId,
    activation,entry,trackId:'worker',realmId:'module',triggerId:invocationId,realmPolicy:'retained'});
  assert.equal(h.realms.size,0);
  assert.throws(()=>admit('early','call','run'),/initialization/);
  admit('init','module-init','initialize');finish(h,'init',num(1));
  assert.throws(()=>admit('again','module-init','initialize'),/cannot be repeated/);
  const restored=SelectedExecutionHarness.restore(JSON.parse(JSON.stringify(h.checkpoint())));
  restored.admitInvocation({programId:'module',invocationId:'call',entry:'run',trackId:'worker',
    realmId:'module',triggerId:'call',realmPolicy:'retained'});
  finish(restored,'call',num(2));assert.equal(restored.realms.get('module').initialized,true);
});

test('receiver aliases and idempotent ingress remain explicit',()=>{
  const h=new SelectedExecutionHarness(),object={n:1};
  const options={args:[object],receiver:object};begin(h,options);
  const a=h.invocations.get('first');
  assert.deepEqual(a.receiver,a.controller.input.graph.roots[0]);
  assert.equal(h.timeline.filter(event=>event.kind==='invocation').length,1);
  begin(h,options);
  assert.equal(h.timeline.filter(event=>event.kind==='invocation').length,1);
  assert.throws(()=>begin(h,{args:[{n:2}],receiver:object}),/Conflicting duplicate/);
});

test('durable intent acknowledgment precedes native action; JSON recovery never reexecutes an uncertain write',async()=>{
  let allowPersistence,resolveNative,calls=0;
  const service={'demo.readAsync':()=>{calls++;return new Promise(resolve=>{resolveNative=resolve;});}};
  const journal={append:()=>new Promise(resolve=>{allowPersistence=resolve;})};
  const h=new SelectedExecutionHarness({services:service,journal});begin(h);
  request(h,'first','a','a');const pending=h.dispatch('first','a');
  await Promise.resolve();assert.equal(calls,0);assert.equal(h.timeline.some(event=>event.kind==='dispatch'),false);
  allowPersistence();await Promise.resolve();await Promise.resolve();assert.equal(calls,1);
  h.selected('first',w('await',{promise:'pa',continuation:'ca',invocation:'first'}));
  const packet=JSON.parse(JSON.stringify(h.checkpoint()));
  const restored=SelectedExecutionHarness.restore(packet,{services:service});
  assert.throws(()=>restored.dispatch('first','a'),/uncertain/);
  assert.equal(calls,1);
  restored.reconcile('first','a',{disposition:'fulfilled',evidenceId:'service:receipt:1',value:9});
  restored.selected('first',w('resume',{continuation:'ca',invocation:'first',result:num(9),status:'fulfilled'}));
  finish(restored,'first',num(9));
  assert.deepEqual(SelectedExecutionHarness.replay(restored.exportEpisode()).timeline,restored.timeline);
  const damaged=structuredClone(packet);damaged.invocations[0][1].controller.heap=[];
  assert.throws(()=>SelectedExecutionHarness.restore(damaged),/integrity/);
  resolveNative(9);await pending;
});

test('native cancellation is propagated and late observations retain their original owner',async()=>{
  let observedSignal,resolveNative;
  const h=new SelectedExecutionHarness({services:{'demo.readAsync':(_,meta)=>{
    observedSignal=meta.signal;return new Promise(resolve=>{resolveNative=resolve;});
  }}});begin(h);request(h,'first','a','a');const pending=h.dispatch('first','a');
  await Promise.resolve();h.cancelInvocation('first',{reason:'deadline'});
  assert.equal(observedSignal.aborted,true);assert.equal(h.intents.get('first/a').status,'uncertain');
  resolveNative(3);await pending;
  assert.equal(h.invocations.get('first').status,'cancelled');
  assert.equal(h.timeline.at(-1).invocationId,'first');
  assert.throws(()=>finish(h,'first',num(3)),/not runnable/);
  assert.deepEqual(SelectedExecutionHarness.replay(h.exportEpisode()).timeline,h.timeline);
});

test('same result redelivery is harmless while contradictory result bytes are rejected',async()=>{
  const value={number:1};value.self=value;
  const source='async function run(){return await host.natlangReadCell("a");}';
  const h=new SelectedExecutionHarness({services:{'natlang.readCell':()=>value}});
  h.publishProgram({programId:'p',source,entry:'run',capabilities:['natlang.readCell']});
  h.admitInvocation({programId:'p',invocationId:'first',trackId:'t',realmId:'r',triggerId:'start'});
  h.selected('first',w('request',{effect:'a',operation:'natlang.readCell',arguments:[['str','a']],
    invocation:'first',site:callSite(source,'natlang.readCell'),
    payload:'{"schema":"owned-graph/1","roots":[["str","a"]],"objects":[]}'}));
  const receipt=await h.dispatch('first','a');
  assert.deepEqual(h.deliverResult('first','a',{status:'fulfilled',value}),receipt);
  assert.throws(()=>h.deliverResult('first','a',{status:'fulfilled',value:2}),/Conflicting duplicate/);
  const result=h.invocations.get('first').controller.materialize(receipt.result);
  assert.equal(result.self,result);
  finish(h,'first',receipt.result);
  const restored=SelectedExecutionHarness.restore(JSON.parse(JSON.stringify(h.checkpoint())));
  const recovered=restored.invocations.get('first').controller.materialize(receipt.result);
  assert.equal(recovered.self,recovered);
});

test('Promise reactions execute owned closure frames and finally rejection overrides fulfillment',()=>{
  const text='function run(){return 1;}function cleanup(){return 2;}';
  const c=new SemanticController([w('code',{entry:'run',source:text,sites:analyzeSemanticProgram(text).sites}),
    w('input',{graph:{roots:[],objects:[]}})],{completionPolicy:'await-returned-promise'});
  c.commit(w('allocate',{name:'fn',kind:'closure',code:'cleanup',properties:[],captures:[]}));
  for(const promise of ['p','cleanup'])c.commit(w('promise',{action:'create',promise}));
  c.commit(w('promise',{action:'react',promise:'p',job:'j',reaction:'finally',closure:'fn',target:'derived'}));
  c.commit(w('promise',{action:'resolve',promise:'p',value:num(1)}));
  c.commit(w('return',{value:['ref','derived']}));
  c.commit(w('job',{action:'dispatch',job:'j',owner:'i1'}));
  assert.deepEqual(c.stack,['job:j']);
  c.commit(w('return',{value:['ref','cleanup'],invocation:'job:j'}));
  c.commit(w('job',{action:'complete',job:'j',owner:'i1'}));
  assert.equal(c.jobs.get('j').status,'waiting-cleanup');
  assert.deepEqual(c.pending.value,['ref','derived']);
  assert.throws(()=>c.commit(w('end',{kind:'return'})),/pending/);
  c.commit(w('promise',{action:'reject',promise:'cleanup',value:['str','cleanup failed']}));
  c.commit(w('end',{kind:'return'}));
  assert.deepEqual(c.completion,{kind:'throw',value:['str','cleanup failed']});
});

test('owned Promise adoption cycles and model settlement of external Promises fail atomically',()=>{
  const h=new SelectedExecutionHarness();begin(h);request(h,'first','a','a');
  assert.throws(()=>h.selected('first',w('promise',{action:'resolve',promise:'pa',value:num(3)})),/broker/);
  for(const promise of ['p','q'])h.selected('first',w('promise',{action:'create',promise}));
  h.selected('first',w('promise',{action:'adopt',promise:'p',target:'q'}));
  assert.throws(()=>h.selected('first',w('promise',{action:'adopt',promise:'q',target:'p'})),/cycle/);
  assert.equal(h.invocations.get('first').controller.promise('q').adopted,null);
});

test('actual model action requires committed-action receipt before native dispatch',async()=>{
  let native=0,committed=0;
  const text='function run(){return host.readNumber("x");}';
  const record=w('request',{effect:'effect',operation:'demo.readNumber',invocation:'call',
    site:callSite(text,'demo.readNumber'),arguments:[['str','x']],payload:'["x"]'});
  const select=async prefix=>{
    const n=prefix.committed.filter(item=>item.kind==='semantic').length;
    return {record:n===0?record:n===1?w('return',{value:num(7)}):w('end',{kind:'return'}),
      selection:{modelSelected:true,selectedEventId:'event'+n,meridian:n+1,modelTrack:'t1',ownerTrack:'worker'}};
  };
  select.commitRequest=async(prefix,receipt)=>{
    assert.equal(native,0);assert.equal(receipt.record,record);assert.equal(receipt.validation.invocationId,'call');
    assert.equal(prefix.schema,'selected-inference-prefix/2');committed++;
    return {schema:'semantic-native-action/4',actionKey:'1:event0',invocationId:'call',effectId:'effect',
      operation:'demo.readNumber',payload:'["x"]',ownerTrack:'worker',recordDigest:receipt.validation.payloadDigest};
  };
  const h=new SelectedExecutionHarness({services:{'demo.readNumber':(_,meta)=>{
    native++;assert.equal(meta.idempotencyKey,'1:event0');return 7;
  }}});
  const result=await new SelectedModelDriver({select,harness:h}).run({programId:'p',source:text,entry:'run',
    capabilities:['demo.readNumber'],invocationId:'call',trackId:'worker',realmId:'r',triggerId:'outside'});
  assert.equal(result.completion.value[1],7);assert.equal(committed,1);assert.equal(native,1);
  assert.deepEqual(SelectedExecutionHarness.replay(result.episode).timeline,h.timeline);
});

test('call-return exposes the owned Promise immediately while selected task execution continues',async()=>{
  let settle;
  const h=new SelectedExecutionHarness({services:{'demo.readAsync':()=>new Promise(resolve=>{settle=resolve;})}});
  const select=prefix=>{
    const owner=prefix.invocationId,count=prefix.committed.filter(item=>item.kind==='semantic').length;
    const actions=[
      ()=>w('promise',{action:'create',promise:'root'}),
      ()=>w('request',{effect:'effect',operation:'demo.readAsync',arguments:[['str','x']],
        invocation:owner,site:callSite(source,'demo.readAsync'),payload:'["x"]',promise:'read'}),
      ()=>w('await',{promise:'read',continuation:'continuation',invocation:owner,returnPromise:'root'}),
      ()=>w('resume',{continuation:'continuation',invocation:owner,status:'fulfilled',result:num(13)}),
      ()=>w('promise',{action:'resolve',promise:'root',value:num(13)}),
      ()=>w('return',{value:['ref','root']}),()=>w('end',{kind:'return'})
    ];return actions[count]();
  };
  const driver=new SelectedModelDriver({select,harness:h});
  const immediate=await driver.run({programId:'p',source,entry:'run',capabilities:['demo.readAsync'],
    invocationId:'call',trackId:'worker',realmId:'realm',triggerId:'outside',completionPolicy:'call-return'});
  assert.equal(immediate.pending,true);assert.deepEqual(immediate.completion.value,['ref','root']);
  assert.equal(h.invocations.get('call').status,'suspended');
  settle(13);await immediate.taskCompletion;
  assert.equal(h.invocations.get('call').status,'completed');
  assert.deepEqual(h.invocations.get('call').controller.promise('root').result,num(13));
  driver.close();
});

test('a restored persistent listener requires reattachment and never reruns registration',async()=>{
  const text='function run(){return host.listen("tick",handler);}function handler(value){return value;}';
  let callbacks=0;
  const h=new SelectedExecutionHarness({services:{'demo.listen':(_,meta)=>{
    callbacks++;return meta.subscriptionId(1);
  }}});
  h.publishProgram({programId:'p',source:text,entry:'run',capabilities:['demo.listen']});
  h.admitInvocation({programId:'p',invocationId:'call',trackId:'worker',realmId:'shared',
    triggerId:'outside',realmPolicy:'retained'});
  h.selected('call',w('allocate',{name:'fn',kind:'closure',code:'handler',captures:[],properties:[]}));
  h.selected('call',w('request',{effect:'registration',operation:'demo.listen',invocation:'call',
    arguments:[['str','tick'],['ref','fn']],site:callSite(text,'demo.listen'),
    payload:'["tick",{"$ownedCallback":"fn"}]',promise:'registration'}));
  await h.dispatch('call','registration');finish(h,'call',['undefined']);
  const restored=SelectedExecutionHarness.restore(JSON.parse(JSON.stringify(h.checkpoint())));
  assert.equal(restored.handlers.get('callback1').state,'lost');
  assert.throws(()=>restored.postEvent({subscriptionId:'callback1',eventId:'late',args:[1]}),/closed/);
  let fire;
  restored.reattachSubscription('callback1',{evidenceId:'native-registration:1',attach:receive=>{fire=receive;}});
  fire('first',[2]);finish(restored,'event1',num(2));
  fire('second',[3]);finish(restored,'event2',num(3));
  restored.closeEventHandler('callback1');
  assert.throws(()=>fire('third',[4]),/closed/);assert.equal(callbacks,1);
  assert.deepEqual(SelectedExecutionHarness.replay(restored.exportEpisode()).timeline,restored.timeline);
});

test('Promise readiness across two retained tracks uses one legal delivery order',async()=>{
  const arrivals={};const h=new SelectedExecutionHarness({services:{'demo.readAsync':([key])=>
    new Promise(resolve=>{arrivals[key]=resolve;})}});
  begin(h);request(h,'first','first','a');const first=h.dispatch('first','first');
  h.selected('first',w('await',{promise:'pfirst',continuation:'first',invocation:'first'}));
  begin(h,{invocationId:'second'});request(h,'second','second','b');const second=h.dispatch('second','second');
  h.selected('second',w('await',{promise:'psecond',continuation:'second',invocation:'second'}));
  await Promise.resolve();arrivals.a(1);await first;arrivals.b(2);await second;
  assert.throws(()=>h.selected('second',w('resume',{continuation:'second',invocation:'second',
    status:'fulfilled',result:num(2)})),/global ready order/);
  h.selected('first',w('resume',{continuation:'first',invocation:'first',status:'fulfilled',result:num(1)}));
  finish(h,'first',num(1));
  h.selected('second',w('resume',{continuation:'second',invocation:'second',status:'fulfilled',result:num(2)}));
  finish(h,'second',num(2));
  assert.deepEqual(SelectedExecutionHarness.replay(h.exportEpisode()).timeline,h.timeline);
});

test('private queued arrivals survive closing registration and deliver only at an authorized checkpoint',async()=>{
  const h=new SelectedExecutionHarness({automaticDelivery:false});begin(h);
  h.registerEventHandler({subscriptionId:'subscription',programId:'p',realmId:'shared',
    trackId:'worker',entry:'update',lifetime:'call',ownerInvocationId:'first'});
  const receipt=h.postEvent({subscriptionId:'subscription',eventId:'arrival',args:[{n:1}],deliver:false});
  assert.equal(receipt.status,'buffered');assert.equal(h.timeline.some(item=>item.kind==='event'),false);
  finish(h,'first',num(1));
  h.handlers.get('subscription').state='closing';
  assert.equal(h.timeline.some(item=>item.kind==='event'),false);
  h.deliverReadyEvents('subscription');finish(h,'event1',num(2));
  assert.equal(h.timeline.filter(item=>item.kind==='event').length,1);
});

test('two-handler then selects its rejection closure only after observed settlement',()=>{
  const text='function run(){return value.then(success,recover);}function success(value){return 0;}function recover(value){return value+1;}';
  const c=new SemanticController([w('code',{entry:'run',source:text,sites:[]}),
    w('input',{graph:{roots:[],objects:[]}})],{completionPolicy:'await-returned-promise'});
  for(const name of ['success','recover'])c.commit(w('allocate',{name,kind:'closure',code:name,properties:[],captures:[]}));
  c.commit(w('promise',{action:'create',promise:'source'}));
  c.commit(w('promise',{action:'react',promise:'source',job:'reaction',reaction:'then',
    closure:'success',rejectionClosure:'recover',target:'result'}));
  assert.equal(c.ready.length,0);
  c.commit(w('promise',{action:'reject',promise:'source',value:num(4)}));
  c.commit(w('return',{value:['ref','result']}));
  c.commit(w('job',{action:'dispatch',job:'reaction',owner:'i1'}));
  assert.equal(c.frameFunctions.get('job:reaction'),'recover');
  c.commit(w('compute',{expr:{op:'binary',operator:'+',left:{op:'local',name:'value'},
    right:{op:'literal',value:num(1)}},result:num(5)}));
  c.commit(w('return',{value:num(5),invocation:'job:reaction'}));
  c.commit(w('job',{action:'complete',job:'reaction',owner:'i1'}));
  c.commit(w('end',{kind:'return'}));assert.deepEqual(c.completion,{kind:'return',value:num(5)});
});

test('queueMicrotask has an owned callback frame and quiescence reports uncaught job failure',()=>{
  const c=new SemanticController([w('code',{entry:'run',source:'function run(){return 1;}function tick(){throw "failure";}',sites:[]}),
    w('input',{graph:{roots:[],objects:[]}})],{completionPolicy:'owned-quiescence'});
  c.commit(w('allocate',{name:'callback',kind:'closure',code:'tick',properties:[],captures:[]}));
  c.commit(w('job',{action:'enqueue',job:'microtask',owner:'i1',closure:'callback'}));
  assert.throws(()=>c.commit(w('job',{action:'dispatch',job:'microtask',owner:'i1'})),/stack unwinds/);
  c.commit(w('return',{value:num(1)}));
  c.commit(w('job',{action:'dispatch',job:'microtask',owner:'i1'}));
  c.commit(w('throw',{value:['str','failure'],invocation:'job:microtask'}));
  c.commit(w('job',{action:'complete',job:'microtask',owner:'i1'}));
  assert.deepEqual(c.pending.value,num(1));
  assert.throws(()=>c.commit(w('end',{kind:'return'})),/does not match/);
  c.commit(w('end',{kind:'throw'}));assert.deepEqual(c.completion,{kind:'throw',value:['str','failure']});
});

test('actual model driver finishes reaction jobs after the closure return without clobbering cells',async()=>{
  const source='async function run(){return await Promise.resolve(3).then(increment);}function increment(value){return value+1;}';
  const records=[
    w('allocate',{name:'fn',kind:'closure',code:'increment',properties:[],captures:[]}),
    w('bind',{name:'jreactionp0',value:num(99)}),
    w('promise',{action:'create',promise:'root'}),
    w('promise',{action:'create',promise:'source'}),
    w('promise',{action:'react',promise:'source',job:'reaction',reaction:'then',closure:'fn',target:'derived'}),
    w('promise',{action:'resolve',promise:'source',value:num(3)}),
    w('await',{promise:'derived',continuation:'resume',invocation:'call',returnPromise:'root'}),
    w('job',{action:'dispatch',job:'reaction',owner:'call'}),
    w('compute',{expr:{op:'binary',operator:'+',left:{op:'local',name:'value'},
      right:{op:'literal',value:num(1)}},result:num(4),invocation:'job:reaction'}),
    w('return',{value:num(4),invocation:'job:reaction'}),
    w('job',{action:'complete',job:'reaction',owner:'call'}),
    w('resume',{continuation:'resume',invocation:'call',status:'fulfilled',result:num(4)}),
    w('promise',{action:'resolve',promise:'root',value:num(4)}),
    w('return',{value:['ref','root']}),w('end',{kind:'return'})
  ];
  let closed;
  const select=async prefix=>records[prefix.committed.filter(item=>item.kind==='semantic').length];
  select.complete=async prefix=>{closed=prefix.selectedState;};
  const driver=new SelectedModelDriver({select});
  const result=await driver.run({programId:'p',source,entry:'run',invocationId:'call',
    trackId:'worker',realmId:'realm',triggerId:'start',completionPolicy:'await-returned-promise'});
  assert.deepEqual(result.completion,{kind:'return',value:num(4)});
  assert.deepEqual(driver.harness.invocations.get('call').controller.locals.get('jreactionp0'),num(99));
  assert.deepEqual(closed.completion,result.completion);
  assert.equal(closed.pending,null);
  assert.equal(result.selectedRecords,records.length);
  driver.close();
});

test('actual model driver completes queued call callbacks and closes drained registrations',async()=>{
  const source='async function run(){await host.withCallback("x",callback);return 0;}function callback(value){return value;}';
  const harness=new SelectedExecutionHarness({services:{'demo.withCallback':(_,meta)=>{
    const callback=meta.callback(1);callback(3);callback(4);return undefined;
  }}});
  const root=[
    w('allocate',{name:'fn',kind:'closure',code:'callback',properties:[],captures:[]}),
    w('request',{effect:'call',operation:'demo.withCallback',arguments:[['str','x'],['ref','fn']],
      invocation:'root',site:callSite(source,'demo.withCallback'),
      payload:'["x",{"$ownedCallback":"fn"}]',promise:'result'}),
    w('await',{promise:'result',continuation:'resume',invocation:'root'}),
    w('resume',{continuation:'resume',invocation:'root',status:'fulfilled',result:['undefined']}),
    w('return',{value:num(0)}),w('end',{kind:'return'})
  ];
  const driver=new SelectedModelDriver({harness,select:async prefix=>{
    const count=prefix.committed.filter(item=>item.kind==='semantic').length;
    if(prefix.invocationId==='root')return root[count];
    return count===0?w('return',{value:prefix.committed.find(item=>item.kind==='invocation').inputGraph.roots[0]}):
      w('end',{kind:'return'});
  }});
  const result=await driver.run({programId:'p',source,entry:'run',capabilities:['demo.withCallback'],
    invocationId:'root',trackId:'worker',realmId:'realm',triggerId:'start',
    completionPolicy:'await-returned-promise',deadline:Date.now()+2000});
  assert.deepEqual(result.completion,{kind:'return',value:num(0)});
  const callbacks=[...harness.invocations.values()].filter(item=>item.activation==='callback');
  assert.equal(callbacks.length,2);assert(callbacks.every(item=>item.status==='completed'));
  assert.equal(harness.handlers.get('callback1').state,'closed');
  assert.equal(harness.timeline.filter(item=>item.kind==='handler-close').length,1);
  assert.deepEqual(SelectedExecutionHarness.replay(harness.exportEpisode()).timeline,harness.timeline);
  driver.close();
});

test('callback input hooks admit explicit resource data graphs and preserve retained references',async()=>{
  class Resource {constructor(id){this.id=id;}}
  const resource=new Resource('native:one');
  const h=new SelectedExecutionHarness({prepareCallbackInput:request=>{
    assert.equal(request.args[0],resource);assert.equal(request.realmId,'realm');
    return {inputGraph:{roots:[['ref','resource']],objects:[{id:'resource',kind:'object',
      properties:[{key:'handle',value:['str','native:one']},{key:'owner',value:['ref','retained']}]}]}};
  }});
  h.publishProgram({programId:'p',source:'function run(){return 0;}function callback(value){return value;}',entry:'run'});
  h.admitInvocation({programId:'p',invocationId:'root',trackId:'worker',realmId:'realm',
    triggerId:'start',realmPolicy:'retained'});
  h.selected('root',w('allocate',{name:'retained',kind:'object',properties:[]}));
  h.selected('root',w('allocate',{name:'fn',kind:'closure',code:'callback',properties:[],captures:[]}));
  const pending=h.enqueueClosure({ownerInvocationId:'root',closureId:'fn',args:[resource]});
  const second=h.enqueueClosure({ownerInvocationId:'root',closureId:'fn',args:[resource]});
  assert.equal(h.closureQueue.length,2);
  assert.doesNotThrow(()=>JSON.stringify(h.checkpoint()));
  finish(h,'root',num(0));
  const [callbackId]=[...h.invocations].find(([,item])=>item.activation==='callback');
  finish(h,callbackId,['ref','resource']);
  const result=await pending;
  assert.equal(result.handle,'native:one');assert.deepEqual(result.owner,{});
  const [nextId,next]=[...h.invocations].find(([id,item])=>item.activation==='callback'&&id!==callbackId);
  const root=next.controller.input.graph.roots[0];
  assert.notDeepEqual(root,['ref','resource'],'queued input identities are rebased when an earlier callback allocated them');
  finish(h,nextId,root);
  const nextResult=await second;assert.equal(nextResult.handle,'native:one');
  assert.deepEqual(next.controller.heap.get(root[1]).properties.get('owner'),['ref','retained']);
});

test('synchronous native callback reentry is refused before queueing guest work',async()=>{
  const source='function run(){return host.natlangCallSync("x",null,callback);}function callback(){return 1;}';
  let attempted=0;
  const h=new SelectedExecutionHarness({services:{'natlang.callSync':(_,meta)=>{
    attempted++;return meta.invokeClosure('fn',[]);
  }}});
  h.publishProgram({programId:'p',source,entry:'run',capabilities:['natlang.callSync']});
  h.admitInvocation({programId:'p',invocationId:'root',trackId:'worker',realmId:'realm',triggerId:'start'});
  h.selected('root',w('allocate',{name:'fn',kind:'closure',code:'callback',properties:[],captures:[]}));
  h.selected('root',w('request',{effect:'call',operation:'natlang.callSync',
    arguments:[['str','x'],['null'],['ref','fn']],invocation:'root',site:callSite(source,'natlang.callSync'),
    payload:'{"schema":"owned-graph/1","roots":[["str","x"],["null"],["callback","fn"]],"objects":[]}'}));
  const result=await h.dispatch('root','call');
  assert.equal(attempted,1);assert.equal(result.status,'rejected');
  assert.match(result.result[1],/Synchronous native calls/);
  assert.equal(h.closureQueue.length,0);assert.equal(h.invocations.size,1);
});
