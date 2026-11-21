import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SelectedExecutionLifecycleV8 as Lifecycle} from '../src/semantic/lifecycle-v8.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';
import {encodeDetailedRecord} from '../src/semantic/detail-v8.js';

const copy=value=>JSON.parse(JSON.stringify(value));
const digest=value=>createHash('sha256').update(value).digest('hex');
const selected=(host,kind,fields)=>host.selected('call',encodeDetailedRecord({kind,fields}));
const intent=packet=>packet.intents[0][1];
const handler=packet=>packet.handlers[0][1];
const callback=packet=>packet.callbacks[0][1];
function reseal(packet){
  const {integrity,...body}=packet;
  return {...body,integrity:digest(JSON.stringify(body))};
}
function begin(source,capabilities,options={}){
  const host=new Lifecycle({sessionId:'restore-authority',automaticDelivery:false,...options});
  host.publishProgram({programId:'p',source,entry:'run',capabilities});
  host.admitInvocation({programId:'p',invocationId:'call',trackId:'worker',realmId:'realm',
    triggerId:'outside',realmPolicy:'retained'});
  return host;
}
function request(host,source,operation,args,payload,promise=null){
  const {start,end}=analyzeSemanticProgram(source).sites.find(row=>row.operation===operation);
  selected(host,'request',{effect:'e',operation,invocation:'call',arguments:args,payload,site:{start,end},
    ...(promise?{promise}:{})});
}
function store(options={}){
  const source='"use strict";function run(){return host.store("key",1);}',
    host=begin(source,['demo.store'],options);
  request(host,source,'demo.store',[['str','key'],['num',1]],'["key",1]');
  return host;
}
async function pendingStore(t){
  let release;
  const host=store({services:{'demo.store':()=>new Promise(resolve=>{release=resolve;})}}),
    pending=host.dispatch('call','e');
  for(let index=0;index<20&&!release;index++)await Promise.resolve();
  assert.equal(typeof release,'function','the adapter must have started before capturing the checkpoint');
  t.after(async()=>{release(1);await pending;});
  return host;
}
async function listener(){
  const source='"use strict";function run(){return host.listen("tick",handler);}function handler(value){return value;}',
    host=begin(source,['demo.listen'],{services:{'demo.listen':(_,meta)=>meta.subscriptionId(1)}});
  selected(host,'allocate',{name:'fn',kind:'closure',code:'handler',captures:[],properties:[]});
  request(host,source,'demo.listen',[['str','tick'],['ref','fn']],
    '["tick",{"$ownedCallback":"fn"}]','registration');
  await host.dispatch('call','e');
  selected(host,'return',{value:['undefined']});selected(host,'end',{kind:'return'});
  return host;
}
async function rejectMutations(t,original,mutations){
  for(const [name,change]of mutations)await t.test(name,()=>{
    const altered=copy(original);change(altered);
    let adapterCalls=0;
    assert.throws(()=>Lifecycle.restore(reseal(altered),{services:{
      'demo.store':()=>{adapterCalls++;},'demo.listen':()=>{adapterCalls++;}
    }}),undefined,'private checkpoint metadata must not override source-owned public replay');
    assert.equal(adapterCalls,0,'validating a checkpoint cannot invoke a native service');
  });
}

test('direct restore keeps a committed request dispatchable only with its exact public intent',async t=>{
  const host=store(),original=copy(host.checkpoint());
  let calls=0;
  const restored=Lifecycle.restore(original,{services:{'demo.store':args=>{
    calls++;assert.deepEqual(args,['key',1]);return 1;
  }}});
  assert.equal(restored.intents.get('call/e').status,'committed');
  assert.equal(restored.intents.get('call/e').attempts,0);
  assert.equal(calls,0);
  await restored.dispatch('call','e');assert.equal(calls,1);
  assert.deepEqual(Lifecycle.replay(restored.exportEpisode(),{requireTerminal:false}).timeline,restored.timeline);
  await rejectMutations(t,original,[
    ['changed payload with a matching private digest',packet=>{
      intent(packet).payload='["different-key",99]';intent(packet).payloadDigest=digest(intent(packet).payload);
    }],
    ['changed payload digest',packet=>{intent(packet).payloadDigest='0'.repeat(64);}],
    ['changed source request witness',packet=>{intent(packet).witness+=' ';}],
    ['changed operation',packet=>{intent(packet).operation='demo.readNumber';}],
    ['changed effect identity',packet=>{intent(packet).effectId='another';}],
    ['changed owning invocation',packet=>{intent(packet).invocationId='another';}],
    ['changed task revision',packet=>{intent(packet).taskRevision++;}],
    ['invented public attempt',packet=>{intent(packet).attempts=1;}],
    ['unfinished private dispatch boundary',packet=>{intent(packet).status='dispatching';}],
    ['omitted committed intent',packet=>{packet.intents=[];}],
    ['duplicate intent map key',packet=>{packet.intents.push(copy(packet.intents[0]));}],
    ['invented additional intent key',packet=>{packet.intents.push(['call/other',copy(intent(packet))]);}]
  ]);
});

test('direct restore cannot rewind dispatch authority or attempts through rehashed private metadata',async t=>{
  const host=await pendingStore(t),original=copy(host.checkpoint());
  let calls=0;
  const restored=Lifecycle.restore(original,{services:{'demo.store':()=>{calls++;return 1;}}});
  assert.equal(restored.intents.get('call/e').status,'uncertain');
  assert.equal(restored.intents.get('call/e').attempts,1);
  assert.throws(()=>restored.dispatch('call','e'),/uncertain|committed/);
  const again=Lifecycle.restore(copy(restored.checkpoint()));
  assert.equal(again.intents.get('call/e').status,'uncertain');
  assert.equal(calls,0);
  await rejectMutations(t,original,[
    ['dispatch reset to an apparently unattempted request',packet=>{
      intent(packet).status='committed';intent(packet).attempts=0;
    }],
    ['dispatch reset while retaining its attempt number',packet=>{intent(packet).status='committed';}],
    ['erased dispatch attempt',packet=>{intent(packet).attempts=0;}],
    ['invented extra dispatch attempt',packet=>{intent(packet).attempts=2;}],
    ['unobserved lost disposition',packet=>{intent(packet).status='lost';}],
    ['unobserved cancellation',packet=>{intent(packet).status='cancelled';}],
    ['unobserved terminal settlement',packet=>{intent(packet).status='settled';}]
  ]);
});

test('direct restore binds settled duplicate results to the exact observed receipt',async t=>{
  const host=store({services:{'demo.store':()=>1}});await host.dispatch('call','e');
  const original=copy(host.checkpoint()),restored=Lifecycle.restore(original),
    receipt=copy(host.intents.get('call/e').result);
  assert.deepEqual(restored.deliverResult('call','e',{status:'fulfilled',value:1}),receipt);
  await rejectMutations(t,original,[
    ['settled request made dispatchable again',packet=>{intent(packet).status='committed';}],
    ['settled request made uncertain again',packet=>{intent(packet).status='uncertain';}],
    ['duplicate-result receipt changed without changing its digest',packet=>{
      intent(packet).result.line=encodeDetailedRecord({kind:'observe',fields:{effect:'e',result:['num',99],status:'fulfilled'}});
    }],
    ['duplicate-result receipt owner changed',packet=>{intent(packet).result.track='other';}],
    ['duplicate-result receipt removed',packet=>{intent(packet).result=null;}]
  ]);
});

test('direct restore preserves public handler and callback descriptors while losing only native attachment',async t=>{
  const host=await listener(),original=copy(host.checkpoint()),restored=Lifecycle.restore(original);
  assert.equal(restored.handlers.get('callback1').state,'lost');
  assert.equal(restored.callbacks.get('call/e/1').state,'lost');
  const again=Lifecycle.restore(copy(restored.checkpoint()));
  assert.equal(again.handlers.get('callback1').state,'lost');
  assert.equal(again.callbacks.get('call/e/1').state,'lost');
  assert.deepEqual(again.timeline,host.timeline);
  await rejectMutations(t,original,[
    ['handler source entry changed',packet=>{handler(packet).entry='run';}],
    ['handler owner changed',packet=>{handler(packet).ownerInvocationId=null;}],
    ['handler track changed',packet=>{handler(packet).trackId='other';}],
    ['handler realm changed',packet=>{handler(packet).realmId='other';}],
    ['handler closure changed',packet=>{handler(packet).closureId=null;}],
    ['handler lifetime changed',packet=>{handler(packet).lifetime='call';}],
    ['handler realm policy changed',packet=>{handler(packet).realmPolicy='fresh';}],
    ['handler queue bound changed',packet=>{handler(packet).queueLimit++;}],
    ['unobserved handler retirement',packet=>{handler(packet).state='closed';}],
    ['missing observed handler',packet=>{packet.handlers=[];}],
    ['duplicate handler map key',packet=>{packet.handlers.push(copy(packet.handlers[0]));}],
    ['invented additional handler identity',packet=>{packet.handlers.push(['invented',copy(handler(packet))]);}],
    ['callback source entry changed',packet=>{callback(packet).entry='run';}],
    ['callback owner changed',packet=>{callback(packet).ownerInvocationId='other';}],
    ['callback slot changed',packet=>{callback(packet).slot=0;}],
    ['callback subscription changed',packet=>{callback(packet).subscriptionId='other';}],
    ['callback closure changed',packet=>{callback(packet).closureId='other';}],
    ['callback lifetime changed',packet=>{callback(packet).lifetime='call';}],
    ['unobserved callback revocation',packet=>{callback(packet).state='revoked';}],
    ['missing observed callback',packet=>{packet.callbacks=[];}],
    ['duplicate callback map key',packet=>{packet.callbacks.push(copy(packet.callbacks[0]));}]
  ]);
});

test('direct restore cannot reactivate a publicly closed callback through a newly hashed checkpoint',async t=>{
  const host=await listener();host.closeEventHandler('callback1');
  const original=copy(host.checkpoint()),restored=Lifecycle.restore(original);
  assert.equal(restored.handlers.get('callback1').state,'closed');
  assert.equal(restored.callbacks.get('call/e/1').state,'revoked');
  await rejectMutations(t,original,[
    ['closed handler reset to active',packet=>{handler(packet).state='active';}],
    ['closed handler reset to lost',packet=>{handler(packet).state='lost';}],
    ['revoked callback reset to active',packet=>{callback(packet).state='active';}],
    ['revoked callback reset to lost',packet=>{callback(packet).state='lost';}],
    ['both resource records reset to active',packet=>{
      handler(packet).state='active';callback(packet).state='active';
    }]
  ]);
});

test('direct restore derives activation, source availability and routing metadata from exact public replay',async t=>{
  const host=store({maxGenerated:73,maxOutstanding:11}),original=copy(host.checkpoint());
  assert.equal(Lifecycle.restore(original).invocations.get('call').controller.maxGenerated,73);
  await rejectMutations(t,original,[
    ['changed session identity',packet=>{packet.sessionId='another';}],
    ['changed global sequence',packet=>{packet.globalSequence++;}],
    ['changed owner sequence',packet=>{packet.ownerSequences[1][1]++;}],
    ['removed owner sequence',packet=>{packet.ownerSequences.pop();}],
    ['removed committed ingress identity',packet=>{packet.ingress=[];}],
    ['reassigned committed ingress identity',packet=>{packet.ingress[0][1]='other';}],
    ['lost observed source availability',packet=>{packet.sourceAvailability[0][1]=[];}],
    ['invented source availability',packet=>{packet.sourceAvailability.push(['other',['p']]);}],
    ['erased public program',packet=>{packet.programs=[];}],
    ['erased public realm',packet=>{packet.realms=[];}],
    ['erased public activation',packet=>{packet.invocations=[];}],
    ['duplicated public activation identity',packet=>{packet.invocations.push(copy(packet.invocations[0]));}],
    ['changed activation status',packet=>{packet.invocations[0][1].status='completed';}],
    ['changed activation track',packet=>{packet.invocations[0][1].trackId='other';}],
    ['changed activation trigger',packet=>{packet.invocations[0][1].triggerId='other';}],
    ['changed activation parent',packet=>{packet.invocations[0][1].parentInvocationId='other';}],
    ['changed activation deadline',packet=>{packet.invocations[0][1].deadline=999;}],
    ['changed activation task revision',packet=>{packet.invocations[0][1].taskRevision++;}],
    ['changed activation delivery fingerprint',packet=>{packet.invocations[0][1].ingressDigest='0'.repeat(64);}],
    ['changed selected completion policy',packet=>{packet.invocations[0][1].controller.policy='owned-quiescence';}],
    ['erased selected request blocking state',packet=>{packet.invocations[0][1].controller.blockedSync=null;}],
    ['reset selected generated-record count',packet=>{packet.invocations[0][1].controller.generated=0;}],
    ['changed selected budget without matching embedding policy',packet=>{packet.invocations[0][1].controller.maxGenerated++;}],
    ['invented notification callback counter',packet=>{packet.nextCallback++;}]
  ]);
});

test('duplicate invocation input remains identical after public replay and JSON restoration',()=>{
  const host=new Lifecycle(),source='"use strict";function run(value){return value;}';
  host.publishProgram({programId:'p',source,entry:'run'});
  const object={value:17};object.self=object;
  const options={programId:'p',invocationId:'callbackinvoke9',trackId:'worker',realmId:'realm',
    triggerId:'outside',realmPolicy:'retained',args:[object,object],receiver:object},
    admitted=host.admitInvocation(options),original=copy(host.checkpoint()),
    replayed=Lifecycle.replay(host.exportEpisode(),{requireTerminal:false}),
    restored=Lifecycle.restore(original);
  assert.equal(host.nextCallback,0,'ordinary invocation spellings do not reserve notification IDs');
  assert.equal(restored.nextCallback,0);
  assert.equal(host.invocations.get(options.invocationId).ingressDigest,
    replayed.invocations.get(options.invocationId).ingressDigest);
  assert.deepEqual(restored.admitInvocation(options),admitted);
  assert.deepEqual(restored.admitInvocation({...options,args:[],receiver:undefined,
    entry:admitted.entry,inputGraph:admitted.inputGraph,receiverValue:admitted.receiver}),admitted);
  assert.deepEqual(restored.timeline,host.timeline);
  assert.throws(()=>restored.admitInvocation({...options,args:[{value:99},object]}),/Conflicting duplicate/);
  assert.deepEqual(restored.timeline,host.timeline);
});

test('direct restore refuses private input that has no independently retained checked ingress receipt',async t=>{
  const host=await listener(),original=copy(host.checkpoint());
  await rejectMutations(t,original,[
    ['private registered arrival inserted behind a public handler',packet=>{
      handler(packet).seen.push('private');handler(packet).queue.push({eventId:'private',arrivalSequence:1,
        completionPolicy:'call-return',argsGraph:{objects:[],roots:[['num',17]]}});
      packet.nextIngressSequence=2;
    }],
    ['native pre-registration callback inserted',packet=>{callback(packet).queued.push({eventId:'private',args:[17]});}],
    ['return callback inserted without its arrival receipt',packet=>{
      packet.closureQueue.push({ownerInvocationId:'call',closureId:'fn',invocationId:'private',
        inputGraph:{objects:[],roots:[['num',17]]},receiverValue:['undefined']});
    }]
  ]);
});

test('native dispatch replay and restoration retain the exact selected request binding',async t=>{
  const host=store({services:{'demo.store':()=>1}}),selected=host.intents.get('call/e'),
    receipt={schema:'semantic-native-action/4',actionKey:'original-action',invocationId:'call',effectId:'e',
      operation:selected.operation,payload:selected.payload,recordDigest:digest(selected.witness),ownerTrack:'worker'};
  await host.dispatch('call','e',{beforeDispatch:async()=>receipt});
  const replayed=Lifecycle.replay(host.exportEpisode(),{requireTerminal:false}),
    original=copy(host.checkpoint()),restored=Lifecycle.restore(original),
    dispatch=host.timeline.find(row=>row.kind==='dispatch');
  assert.deepEqual(replayed.intents.get('call/e').nativeAction,receipt);
  assert.deepEqual(restored.intents.get('call/e').nativeAction,receipt);
  await rejectMutations(t,original,[
    ['private native action key changed',packet=>{intent(packet).nativeAction.actionKey='other';}],
    ['private native receipt removed',packet=>{delete intent(packet).nativeAction;}],
    ['private native ownership changed',packet=>{intent(packet).nativeAction.ownerTrack='other';}]
  ]);
  for(const [name,change]of [
    ['operation',value=>{value.operation='demo.readNumber';}],
    ['payload',value=>{value.payload='["different",2]';}],
    ['request bytes',value=>{value.recordDigest='0'.repeat(64);}],
    ['invocation',value=>{value.invocationId='other';}],
    ['effect',value=>{value.effectId='other';}],
    ['owner',value=>{value.ownerTrack='other';}],
    ['receipt schema',value=>{value.schema='unrelated';}],
    ['empty action identity',value=>{value.actionKey='';}]
  ])await t.test('public native binding rejects changed '+name,()=>{
    const prefix=host.exportEpisode();prefix.public.timeline.length=dispatch.sequence-1;
    const waiting=Lifecycle.replay(prefix,{requireTerminal:false}),before=copy(waiting.checkpoint()),
      changed=copy(dispatch);change(changed.nativeAction);
    assert.throws(()=>waiting.replayRecord(changed),/Native selected-action/);
    assert.deepEqual(copy(waiting.checkpoint()),before,'binding refusal must precede dispatch mutation');
  });
  for(const nativeAction of [null,false,{},Object.assign(copy(receipt),{extra:undefined})]){
    const prefix=host.exportEpisode();prefix.public.timeline.length=dispatch.sequence-1;
    const waiting=Lifecycle.replay(prefix,{requireTerminal:false}),before=copy(waiting.checkpoint());
    assert.throws(()=>waiting.replayRecord({...dispatch,nativeAction}),/Native selected-action/);
    assert.deepEqual(copy(waiting.checkpoint()),before);
  }
});
