import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {SelectedExecutionLifecycleV8} from '../src/semantic/lifecycle-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {encodeDetailedRecord} from '../src/semantic/detail-v8.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';

const w=(kind,fields)=>encodeDetailedRecord({kind,fields});
const num=value=>['num',value];
const site=(source,operation)=>{
  const {start,end}=analyzeSemanticProgram(source).sites.find(row=>row.operation===operation);
  return {start,end};
};
const finish=(h,id,value)=>{
  h.selected(id,w('return',{value}));h.selected(id,w('end',{kind:'return'}));
};
function begin(h,source,capabilities,realmPolicy='fresh'){
  h.publishProgram({programId:'p',source,entry:'run',capabilities});
  h.admitInvocation({programId:'p',invocationId:'call',trackId:'worker',realmId:'realm',triggerId:'outside',realmPolicy});
}

test('direct V8 lifecycle retains callbacks across restore without replaying registration',async()=>{
  const source='"use strict";function run(){return host.listen("tick",handler);}function handler(value){return value;}';
  let registrations=0;
  const h=new SelectedExecutionLifecycleV8({services:{'demo.listen':(_,meta)=>{
    registrations++;return meta.subscriptionId(1);
  }}});
  begin(h,source,['demo.listen'],'retained');
  h.selected('call',w('allocate',{name:'fn',kind:'closure',code:'handler',captures:[],properties:[]}));
  h.selected('call',w('request',{effect:'registration',operation:'demo.listen',invocation:'call',
    arguments:[['str','tick'],['ref','fn']],site:site(source,'demo.listen'),
    payload:'["tick",{"$ownedCallback":"fn"}]',promise:'registration'}));
  await h.dispatch('call','registration');finish(h,'call',['undefined']);
  const packet=JSON.parse(JSON.stringify(h.checkpoint()));
  assert.equal(packet.schema,'semantic-checkpoint/8');
  assert.equal(packet.invocations[0][1].controller.schema,'semantic-continuation/8');
  const restored=SelectedExecutionLifecycleV8.restore(packet);
  assert.equal(restored.handlers.get('callback1').state,'lost');
  assert.throws(()=>restored.postEvent({subscriptionId:'callback1',eventId:'late',args:[1]}),/closed/);
  let fire;
  restored.reattachSubscription('callback1',{evidenceId:'existing-registration',attach:receive=>{fire=receive;}});
  fire('first',[2]);finish(restored,'event1',num(2));
  fire('second',[3]);finish(restored,'event2',num(3));
  restored.closeEventHandler('callback1');
  assert.equal(registrations,1);
  assert.deepEqual(SelectedExecutionLifecycleV8.replay(restored.exportEpisode()).timeline,restored.timeline);
  assert(!/semantic-(?:execution|trace|context|continuation|checkpoint)\/6/.test(JSON.stringify(restored.checkpoint())));
});

test('public replay retires call callbacks and failed subscriptions at the result boundary',async()=>{
  for(const operation of ['demo.withCallback','demo.listen'])for(const status of ['fulfilled','rejected']){
    const name=operation.slice('demo.'.length);
    const source='"use strict";function run(){return host.'+name+'("tick",handler);}function handler(value){return value;}';
    let calls=0;
    const h=new SelectedExecutionLifecycleV8({services:{[operation]:()=>{
      calls++;if(status==='rejected')throw new Error('registration failed');return undefined;
    }}});
    begin(h,source,[operation],'retained');
    h.selected('call',w('allocate',{name:'fn',kind:'closure',code:'handler',captures:[],properties:[]}));
    h.selected('call',w('request',{effect:'registration',operation,invocation:'call',
      arguments:[['str','tick'],['ref','fn']],site:site(source,operation),
      payload:'["tick",{"$ownedCallback":"fn"}]',promise:'registration'}));
    await h.dispatch('call','registration');
    const retained=operation==='demo.listen'&&status==='fulfilled';
    const exported=h.exportEpisode(),resultIndex=exported.public.timeline.findIndex(row=>row.kind==='result');
    assert(resultIndex>=0);
    const prefix=structuredClone(exported);prefix.public.timeline.length=resultIndex+1;
    const boundary=SelectedExecutionLifecycleV8.replay(prefix,{requireTerminal:false});
    assert.equal(boundary.callbacks.get('call/registration/1').state,retained?'active':'revoked');
    assert.equal(boundary.handlers.get('callback1').state,retained?'active':'closing');
    assert.equal(boundary.timeline.length,resultIndex+1,'replay must not invent queued arrivals or closure');
    const replayed=SelectedExecutionLifecycleV8.replay(exported,{requireTerminal:false});
    assert.deepEqual([...replayed.callbacks],[...h.callbacks]);
    assert.deepEqual([...replayed.handlers],[...h.handlers]);
    assert.equal(calls,1,'replay must not register native callbacks again');
  }
});

test('direct V8 effects require durable intent acknowledgment and restore never redispatches uncertain work',async()=>{
  const source='"use strict";function run(){return host.readNumber("x");}';
  let calls=0,acknowledged=false,resolve;
  const h=new SelectedExecutionLifecycleV8({journal:{append:async()=>{acknowledged=true;}},
    services:{'demo.readNumber':()=>{assert(acknowledged);calls++;return new Promise(done=>{resolve=done;});}}});
  begin(h,source,['demo.readNumber']);
  const line=w('request',{effect:'e',operation:'demo.readNumber',invocation:'call',
    arguments:[['str','x']],site:site(source,'demo.readNumber'),payload:'["x"]'});
  h.selected('call',line);
  assert.equal(h.intents.get('call/e').witness,line);assert.equal(calls,0);
  const pending=h.dispatch('call','e');
  for(let index=0;index<10&&!resolve;index++)await Promise.resolve();
  assert.equal(calls,1);
  const restored=SelectedExecutionLifecycleV8.restore(JSON.parse(JSON.stringify(h.checkpoint())),{
    services:{'demo.readNumber':()=>{calls++;return 9;}}
  });
  assert.equal(restored.intents.get('call/e').status,'uncertain');
  assert.throws(()=>restored.dispatch('call','e'),/uncertain|reconcil|committed/);
  assert.equal(calls,1);
  restored.reconcile('call','e',{disposition:'fulfilled',value:7,evidenceId:'broker-recovery'});
  finish(restored,'call',num(7));
  assert.equal(calls,1);
  assert.equal(restored.intents.get('call/e').result.schema,'semantic-lifecycle/8');
  assert(restored.intents.get('call/e').result.line.startsWith('detail '));
  resolve(7);await pending;
});

test('mixed V8 checkpoints contain direct lifecycle state and reject altered selected state',()=>{
  const h=new RegionExecutionHarness();
  h.publishProgram({programId:'p',source:'"use strict";function run(x){let y=x+1;return y*2;}',entry:'run'});
  h.admitInvocation({programId:'p',invocationId:'call',trackId:'t',realmId:'r',triggerId:'outside',args:[3]});
  h.select('call',h.preview('call','r0'));
  const packet=h.checkpoint();
  assert.equal(packet.selected.schema,'semantic-checkpoint/8');
  assert(packet.selected.timeline.filter(row=>row.line).every(row=>row.line.startsWith('detail ')));
  const forged=structuredClone(packet);
  forged.selected.invocations[0][1].controller.pending.value[1]=99;
  const {integrity:innerIntegrity,...innerBody}=forged.selected;
  forged.selected.integrity=createHash('sha256').update(JSON.stringify(innerBody)).digest('hex');
  const {integrity,...body}=forged;forged.integrity=hashAlgorithmData(body);
  assert.throws(()=>RegionExecutionHarness.restore(forged),/contradicts committed public history/);
  const restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(packet)));
  restored.select('call',{kind:'end',fields:{kind:'return'}});
  assert.deepEqual(restored.controller.completion.value,num(8));
});

test('mixed V8 selection, rendering and restore run with the legacy wire stack unavailable',()=>{
  const loader='export async function resolve(specifier,context,next){'+
    'if(/(?:training\\/(?:format|trace-text|harness-v4|controller|render)|detailed-v7)\\.js/.test(specifier))'+
    'throw new Error("legacy dependency: "+specifier);return next(specifier,context);}';
  const module=new URL('../src/semantic/region-harness.js',import.meta.url).href;
  const source='import {RegionExecutionHarness as H} from '+JSON.stringify(module)+';'+
    'let h=new H();h.publishProgram({programId:"p",source:"\\\"use strict\\\";function run(x){let y=x+1;return y*2;}",entry:"run"});'+
    'h.admitInvocation({programId:"p",invocationId:"i",trackId:"t",realmId:"r",triggerId:"outside",args:[3]});'+
    'h.select("i",h.preview("i","r0"));h=H.restore(h.checkpoint());'+
    'h.select("i",{kind:"end",fields:{kind:"return"}});'+
    'if(h.controller.completion.value[1]!==8||!h.inner.inspect().length)throw new Error("execution");';
  const result=spawnSync(process.execPath,['--no-warnings','--experimental-loader',
    'data:text/javascript,'+encodeURIComponent(loader),'--input-type=module','--eval',source],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});

test('live V8 driver selects and acknowledges original records with legacy codecs unavailable',()=>{
  const loader='export async function resolve(specifier,context,next){'+
    'if(/(?:training\\/(?:format|trace-text|harness-v4|controller|render|model-driver)|detailed-v7)\\.js/.test(specifier))'+
    'throw new Error("legacy dependency: "+specifier);return next(specifier,context);}';
  const harness=new URL('../src/semantic/region-harness.js',import.meta.url).href;
  const driver=new URL('../src/semantic/selected-execution-v8.js',import.meta.url).href;
  const source='import {RegionExecutionHarness as H} from '+JSON.stringify(harness)+';'+
    'import {runSelectedRegionExecution as run} from '+JSON.stringify(driver)+';'+
    'const h=new H();h.publishProgram({programId:"p",source:"\\\"use strict\\\";function run(x){let y=x+1;return y*2;}",entry:"run"});'+
    'h.admitInvocation({programId:"p",invocationId:"i",trackId:"t",realmId:"r",triggerId:"outside",args:[3]});'+
    'const initialPublic=h.exportEpisode();h.select("i",h.preview("i","r0"));h.select("i",{kind:"end",fields:{kind:"return"}});'+
    'const lines=h.timeline.filter(row=>row.mode==="generated").map(row=>row.fields.line);'+
    'let acknowledged=0;const select=async()=>({record:lines.shift()});select.initialize=async request=>request;'+
    'select.commit=async()=>{acknowledged++;return {committed:true};};'+
    'const result=await run({initialPublic,select,checkpointIdentity:"a".repeat(64),tokenizerIdentity:"b".repeat(64),origin:"engineering"});'+
    'if(!result.publicCompleted||result.completion.value[1]!==8||acknowledged!==2)throw new Error(JSON.stringify(result));';
  const result=spawnSync(process.execPath,['--no-warnings','--experimental-loader',
    'data:text/javascript,'+encodeURIComponent(loader),'--input-type=module','--eval',source],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
