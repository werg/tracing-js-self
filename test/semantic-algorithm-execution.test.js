import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {AlgorithmExecutionHarness} from '../src/semantic/harness.js';
import {AlgorithmController} from '../src/semantic/controller.js';
import {defineAlgorithmProgram,validateAlgorithmProgram,hashAlgorithmData} from '../src/semantic/program.js';
import {evaluateTerm} from '../src/semantic/operations.js';
import {decodeAlgorithmRecord,encodeAlgorithmRecord} from '../src/semantic/trace-codec.js';
import {SelectedIntentJournal} from '../src/training/intent-journal.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';

const source='"use strict";async function run(){const current=await host.readAsync("counter");const next=current+1;host.store("counter",next);return next;}';
const capabilities=['demo.readAsync','demo.store'];
const fresh=options=>new AlgorithmExecutionHarness({source,entry:'run',capabilities,...options});
function nextRecord(harness){
  const step=harness.controller.nextStep(),environment=harness.controller.environment();
  assert(step,'expected a live step');
  if(step.kind==='compute')return {...step,result:evaluateTerm(step.term,environment)};
  if(step.kind==='request')return {...step,arguments:step.arguments.map(term=>evaluateTerm(term,environment))};
  if(['return','throw'].includes(step.kind))return {kind:step.kind,value:evaluateTerm(step.value,environment)};
  throw new Error('The next step needs an external observation: '+step.kind);
}
const selectNext=harness=>harness.select(nextRecord(harness));
function observation(harness,value,status='fulfilled'){
  const step=harness.controller.nextStep();
  return {kind:'observe',request:step.request,id:step.id,status,
    ...(status==='completed'?{}:{value})};
}
function rehash(packet){const {integrity,...body}=packet;return {...body,integrity:hashAlgorithmData(body)};}

test('the counter exposes read, observation, increment, store, observation and completion with exact effects',async()=>{
  const harness=fresh(),calls=[];
  const initialContext=harness.modelContext();
  assert(initialContext.program,'the consumer receives an actual immutable program definition');
  assert(initialContext.inputGraph,'the actual immutable input graph is initially available');
  const repeatedContext=harness.modelContext();
  assert.equal(repeatedContext.program,undefined,'the same available definition is not repeated');
  assert.equal(repeatedContext.inputGraph,undefined,'the same available input graph is not repeated');
  assert.equal(repeatedContext.input,initialContext.input);
  const first=selectNext(harness);
  assert.deepEqual(first.dispatch.arguments,[['str','counter']]);
  assert.equal(first.dispatch.operation,'demo.readAsync');
  await harness.dispatch('r0',async(args,context)=>{calls.push({args,context});return 7;});
  const beforeIncrement=harness.modelContext();
  assert.deepEqual(beforeIncrement.state.values,[['v0',['num',7]]]);
  selectNext(harness);
  assert.deepEqual(harness.modelContext().state.values,[['v1',['num',8]]],
    'the observation can leave the live state after its derived value commits');
  const store=selectNext(harness);
  assert.deepEqual(store.dispatch.arguments,[['str','counter'],['num',8]]);
  await harness.dispatch('r1',async(args,context)=>{calls.push({args,context});return undefined;});
  selectNext(harness);
  assert.deepEqual(harness.controller.completion,{kind:'return',value:['num',8]});
  assert.deepEqual(calls.map(row=>[row.context.operation,row.args]),[
    ['demo.readAsync',['counter']],['demo.store',['counter',8]]]);
  assert.equal(new Set(calls.map(row=>row.context.idempotencyKey)).size,2);
  const publicRecords=harness.timeline.filter(row=>row.line).map(row=>({mode:row.mode,record:decodeAlgorithmRecord(row.line)}));
  assert.deepEqual(publicRecords.map(row=>row.record.kind),['request','observe','compute','request','observe','return']);
  assert(publicRecords.every(row=>(row.record.kind==='observe')===(row.mode==='observed')));
  assert(publicRecords.filter(row=>row.record.kind==='request').every(row=>
    !Object.hasOwn(row.record,'payload')&&!Object.hasOwn(row.record,'site')&&!Object.hasOwn(row.record,'invocation')));
});

test('future observations cannot alter earlier public prefixes or source authorization',()=>{
  const left=fresh(),right=fresh();
  selectNext(left);selectNext(right);
  assert.deepEqual(left.exportEpisode().timeline,right.exportEpisode().timeline);
  assert.deepEqual(left.program,right.program);
  left.deliver(observation(left,['num',7]));right.deliver(observation(right,['num',99]));
  assert.deepEqual(left.timeline.slice(0,3),right.timeline.slice(0,3));
  selectNext(left);selectNext(right);
  assert.deepEqual(left.controller.values.get('v1'),['num',8]);
  assert.deepEqual(right.controller.values.get('v1'),['num',100]);
});

test('scalar observations preserve JavaScript concatenation instead of assuming numeric addition',()=>{
  const harness=fresh();selectNext(harness);
  harness.deliver(observation(harness,['str','7']));
  selectNext(harness);
  const requested=selectNext(harness).dispatch;
  assert.deepEqual(requested.arguments,[['str','counter'],['str','71']]);
  harness.deliver(observation(harness,null,'completed'));
  selectNext(harness);
  assert.deepEqual(harness.controller.completion,{kind:'return',value:['str','71']});
});

test('authorization binds the next boundary, source, capability, argument values and observation role',()=>{
  for(const mutate of [
    record=>({...record,boundary:'b1'}),record=>({...record,id:'r1'}),
    record=>({...record,operation:'demo.store'}),record=>({...record,arguments:[['str','different']]}),
    record=>({...record,arguments:[]}),record=>({...record,arguments:[...record.arguments,['num',1]]})
  ]){
    const harness=fresh();assert.throws(()=>harness.select(mutate(nextRecord(harness))));
    assert.equal(harness.intents.size,0);
  }
  const denied=fresh({capabilities:['demo.store']});assert.throws(()=>selectNext(denied),/authorization/);
  const harness=fresh();selectNext(harness);
  assert.throws(()=>harness.select(observation(harness,['num',7])),/Observations/);
  assert.throws(()=>harness.deliver({...observation(harness,['num',7]),request:'r1'}),/live selected/);
  assert.throws(()=>harness.deliver({...observation(harness,['num',7]),id:'v3'}),/pending request/);
  assert.throws(()=>harness.select(nextRecord(fresh())),/observation/);
  const modified=structuredClone(harness.program);modified.boundaries[0].source.start++;
  assert.throws(()=>validateAlgorithmProgram(modified),/authorization changed/);
  const changed=structuredClone(harness.program);changed.source=changed.source.replace('counter','different');
  assert.throws(()=>new AlgorithmController({program:changed,inputGraph:{roots:[],objects:[]},capabilities}),/authorization changed/);
});

test('a rejected strict request leaves a resumable committed prefix instead of an unrecorded violation',()=>{
  const harness=fresh(),before=harness.checkpoint();
  const wrong={...nextRecord(harness),arguments:[['str','wrong']]};
  assert.throws(()=>harness.select(wrong),/arguments differ/);
  assert.deepEqual(harness.checkpoint(),before,'rejected claims do not mutate committed state');
  const restored=AlgorithmExecutionHarness.restore(harness.checkpoint());
  assert.equal(restored.controller.firstViolation,null);
  assert.deepEqual(selectNext(restored).dispatch.arguments,[['str','counter']]);
});

test('out-of-profile BigInt facts remain observations and produce an explicit unsupported disposition',async()=>{
  const harness=fresh();selectNext(harness);
  await harness.dispatch('r0',async()=>7n);
  assert.equal(harness.controller.completion.kind,'unsupported');
  assert.equal(harness.controller.completion.category,'unsupported.algorithm-observation');
  assert.equal(harness.intents.size,1);
  const observed=decodeAlgorithmRecord(harness.timeline.at(-1).line);
  assert.equal(harness.timeline.at(-1).mode,'observed');
  assert.deepEqual(observed.value,['bigint','7']);
  assert.throws(()=>harness.select({kind:'throw',value:['str','TypeError']}),/already complete/,
    'an unsupported profile never invents a guest exception');
  assert.throws(()=>harness.select({kind:'request',id:'r1',boundary:'b1',operation:'demo.store',
    arguments:[['str','counter'],['num',8]]}),/already complete/);
  const restored=AlgorithmExecutionHarness.restore(harness.checkpoint());
  assert.deepEqual(restored.controller.completion,harness.controller.completion);
  assert.equal(restored.intents.get('r0').status,'settled');
  assert.throws(()=>new AlgorithmExecutionHarness({source:'"use strict";async function run(x){await host.readAsync("counter");return x+1;}',
    entry:'run',args:[7n],capabilities}),error=>error.category==='unsupported.algorithm-input');
  assert.throws(()=>defineAlgorithmProgram({source:'"use strict";async function run(){await host.readAsync("counter");return 1n+2n;}',entry:'run'}),
    error=>error.category==='unsupported.algorithm-profile');
});

test('a false intermediate remains visible and cannot authorize a later store even with a correct final answer',()=>{
  const harness=fresh();selectNext(harness);harness.deliver(observation(harness,['num',7]));
  const selected={...nextRecord(harness),result:['num',123]};
  const result=harness.select(selected);
  assert.equal(result.claim.consistent,false);
  assert.deepEqual(harness.controller.values.get('v1'),['num',123]);
  assert.throws(()=>harness.select({kind:'request',id:'r1',boundary:'b1',operation:'demo.store',
    arguments:[['str','counter'],['num',8]]}),/false earlier claim/);
  assert.equal(harness.intents.size,1,'the false claim never creates the store intent');
  const restored=AlgorithmExecutionHarness.restore(harness.checkpoint());
  assert(restored.controller.firstViolation);
  assert.deepEqual(restored.controller.values.get('v1'),['num',123]);
});

test('alternative valid subexpression claims are checked without requiring canonical teacher bytes',()=>{
  let harness=new AlgorithmExecutionHarness({source:'"use strict";function run(a,b,c,d){return (a+b)*(c+d)+1;}',
    entry:'run',args:[1,2,3,4]});
  const step=harness.controller.nextStep(),term=step.term;
  const left=term.args[0].args[0],right=term.args[0].args[1];
  harness.select({kind:'compute',id:'extraLeft',term:left,result:['num',3]});
  harness.select({kind:'compute',id:'extraRight',term:right,result:['num',7]});
  assert.deepEqual(harness.modelContext().state.symbols.map(([id])=>id),['extraLeft','extraRight'],
    'live alternative values retain their checked definitions');
  harness=AlgorithmExecutionHarness.restore(harness.checkpoint());
  const decomposed={op:'add',args:[{op:'multiply',args:[{op:'ref',id:'extraLeft'},{op:'ref',id:'extraRight'}]},term.args[1]]};
  harness.select({kind:'compute',id:step.id,term:decomposed,result:['num',22]});
  selectNext(harness);
  assert.deepEqual(harness.controller.completion,{kind:'return',value:['num',22]});
  assert.equal(harness.controller.firstViolation,null);
  assert.equal(harness.controller.claims.length,4);
  const wrong=new AlgorithmExecutionHarness({source:'"use strict";function run(a,b){return a+b;}',entry:'run',args:[2,2]});
  assert.throws(()=>wrong.select({kind:'compute',id:'v0',term:{op:'multiply',args:[
    {op:'input',id:'a0'},{op:'input',id:'a1'}]},result:['num',4]}),/certified computation/);
});

test('rejections complete as throws without issuing later effects and preserve observation authority across restore',async()=>{
  const harness=fresh();selectNext(harness);
  await harness.dispatch('r0',async()=>{throw 'denied';});
  assert.equal(harness.controller.nextStep().kind,'throw');
  const restored=AlgorithmExecutionHarness.restore(harness.checkpoint());
  assert.deepEqual(restored.controller.nextStep(),{kind:'throw',value:{op:'literal',value:['str','denied']}});
  selectNext(restored);
  assert.deepEqual(restored.controller.completion,{kind:'throw',value:['str','denied']});
  assert.equal(restored.intents.size,1);
  assert.throws(()=>selectNext(restored));
  const packet=harness.checkpoint();
  packet.controller.history.find(row=>row.mode==='observed').mode='generated';
  packet.controller=rehash(packet.controller);
  assert.throws(()=>AlgorithmExecutionHarness.restore(rehash(packet)),/Observations/);
});

test('concurrent dispatch, settled checkpoints and resume never duplicate a host effect',async()=>{
  const harness=fresh();selectNext(harness);let calls=0;
  const adapter=async()=>{calls++;return 7;};
  const [first,second]=await Promise.all([harness.dispatch('r0',adapter),harness.dispatch('r0',adapter)]);
  assert.deepEqual(first,second);assert.equal(calls,1);
  const restored=AlgorithmExecutionHarness.restore(harness.checkpoint());
  await restored.dispatch('r0',async()=>{calls++;return 100;});
  assert.equal(calls,1);
  selectNext(restored);selectNext(restored);
  await restored.dispatch('r1',async(args)=>{calls++;assert.deepEqual(args,['counter',8]);});
  selectNext(restored);assert.equal(calls,2);
});

test('a durable intent makes an older selected checkpoint uncertain and requires explicit reconciliation',async t=>{
  const directory=await mkdtemp(join(process.cwd(),'.algorithm-intents-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const journal=new SelectedIntentJournal({directory}),harness=fresh({journal,sessionId:'durable1'});
  selectNext(harness);const old=harness.checkpoint();let calls=0;
  await harness.dispatch('r0',async()=>{calls++;return 7;});
  const restored=AlgorithmExecutionHarness.restore(old,{journal});
  await assert.rejects(()=>restored.dispatch('r0',async()=>{calls++;return 7;}),/durable intent already exists/);
  assert.equal(calls,1);
  assert.equal(restored.intents.get('r0').status,'uncertain');
  assert.throws(()=>restored.deliver(observation(restored,['num',7])),/reconciliation evidence/);
  restored.deliver(observation(restored,['num',7]),{evidence:'verified-service-result-1'});
  selectNext(restored);selectNext(restored);
  await restored.dispatch('r1',async()=>{calls++;return undefined;});
  selectNext(restored);assert.equal(calls,2);
});

test('persisted checkpoints restore selected work and preserve settled dispatch deduplication',async t=>{
  const directory=await mkdtemp(join(process.cwd(),'.algorithm-checkpoints-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const journal=new SelectedIntentJournal({directory}),harness=fresh({journal,sessionId:'persisted1'});
  selectNext(harness);
  const selectedReceipt=await harness.persistCheckpoint();
  assert.match(selectedReceipt.key,/^[a-f0-9]{64}$/);
  assert.equal(selectedReceipt.checkpointSchema,'semantic-algorithm-checkpoint/2');
  assert(selectedReceipt.bytes>0);
  let calls=0;
  const selected=await AlgorithmExecutionHarness.restoreFromJournal({journal,key:selectedReceipt.key});
  assert.equal(selected.intents.get('r0').status,'selected');
  assert.deepEqual(selected.controller.pending,harness.controller.pending);
  assert.equal(calls,0,'restoring durable state does not invoke an adapter');
  await selected.dispatch('r0',async args=>{calls++;assert.deepEqual(args,['counter']);return 7;});
  const settledReceipt=await selected.persistCheckpoint();
  assert.notEqual(settledReceipt.key,selectedReceipt.key);
  const settled=await AlgorithmExecutionHarness.restoreFromJournal({journal,key:settledReceipt.key});
  await settled.dispatch('r0',async()=>{calls++;return 99;});
  assert.equal(calls,1,'a settled result is returned from durable state without another read');
  selectNext(settled);selectNext(settled);
  await settled.dispatch('r1',async args=>{calls++;assert.deepEqual(args,['counter',8]);});
  selectNext(settled);
  const completedReceipt=await settled.persistCheckpoint();
  const completed=await AlgorithmExecutionHarness.restoreFromJournal({journal,key:completedReceipt.key});
  assert.deepEqual(completed.controller.completion,{kind:'return',value:['num',8]});
  await completed.dispatch('r1',async()=>{calls++;});
  assert.equal(calls,2,'the settled store is not duplicated after a complete durable restore');
});

test('an in-flight checkpoint restores as uncertain and cannot silently redispatch',async()=>{
  const harness=fresh();selectNext(harness);
  let complete,started;
  const hasStarted=new Promise(resolve=>{started=resolve;});
  const pending=harness.dispatch('r0',()=>{started();return new Promise(resolve=>{complete=resolve;});});
  await hasStarted;
  const restored=AlgorithmExecutionHarness.restore(harness.checkpoint());
  assert.equal(restored.intents.get('r0').status,'uncertain');
  await assert.rejects(()=>restored.dispatch('r0',async()=>99),/uncertain/);
  complete(7);await pending;
  restored.deliver(observation(restored,['num',7]),{evidence:'observed-original-completion'});
  assert.deepEqual(restored.controller.values.get('v0'),['num',7]);
});

test('a selected checkpoint without durable dispatch evidence restores conservatively as uncertain',async()=>{
  const harness=fresh();selectNext(harness);
  const restored=AlgorithmExecutionHarness.restore(harness.checkpoint());let calls=0;
  assert.equal(restored.intents.get('r0').status,'uncertain');
  await assert.rejects(()=>restored.dispatch('r0',async()=>{calls++;return 7;}),/uncertain/);
  assert.equal(calls,0);
  assert.throws(()=>restored.deliver(observation(restored,['num',7])),/reconciliation evidence/);
});

test('checkpoint lifecycle replay rejects dispatch downgrades, forged timeline authority and alternate codecs',async()=>{
  const harness=fresh();selectNext(harness);
  let complete,started,calls=0;
  const hasStarted=new Promise(resolve=>{started=resolve;});
  const pending=harness.dispatch('r0',()=>{calls++;started();return new Promise(resolve=>{complete=resolve;});});
  await hasStarted;
  try{
    for(const mutate of [
      packet=>{packet.intents[0][1].status='selected';},
      packet=>{packet.intents[0][1].status='committing';},
      packet=>{packet.timeline.push(structuredClone(packet.timeline.find(row=>row.kind==='dispatch')));},
      packet=>{const index=packet.timeline.findIndex(row=>row.kind==='dispatch');packet.timeline.splice(2,0,...packet.timeline.splice(index,1));},
      packet=>{packet.timeline.find(row=>row.kind==='dispatch').mode='generated';},
      packet=>{packet.timeline.find(row=>row.kind==='dispatch').key='other/r0';},
      packet=>{packet.timeline.find(row=>row.kind==='dispatch').attempt=2;},
      packet=>{packet.timeline.push({mode:'generated',kind:'untrusted',line:'request forged'});},
      packet=>{packet.timeline[0].program.source='forged source';},
      packet=>{packet.timeline[1].graph.roots=[['num',7]];},
      packet=>{packet.intents[0][1].untrustedAuthority=true;},
      packet=>{
        const intent=packet.intents[0][1];intent.codec='owned-graph/1';
        intent.payload=JSON.stringify(encodeNativeGraph(['counter']));
        intent.payloadDigest=hashAlgorithmData(intent.payload);
      }
    ]){
      const packet=harness.checkpoint();mutate(packet);
      assert.throws(()=>AlgorithmExecutionHarness.restore(rehash(packet)));
    }
    assert.equal(calls,1,'forged checkpoints never become a second dispatch authorization');
  }finally{complete(7);await pending;}
});

test('checkpoint reconciliation evidence must agree with the observed timeline and settled intent',()=>{
  const harness=fresh();selectNext(harness);
  const restored=AlgorithmExecutionHarness.restore(harness.checkpoint());
  restored.deliver(observation(restored,['num',7]),{evidence:'verified-external-result'});
  assert.doesNotThrow(()=>AlgorithmExecutionHarness.restore(restored.checkpoint()));
  for(const mutate of [
    packet=>{packet.intents[0][1].reconciliation='different-evidence';},
    packet=>{delete packet.timeline.at(-1).reconciliation;},
    packet=>{packet.timeline.at(-1).reconciliation='';packet.intents[0][1].reconciliation='';},
    packet=>{packet.timeline.at(-1).reconciliation=false;packet.intents[0][1].reconciliation=false;}
  ]){
    const packet=restored.checkpoint();mutate(packet);
    assert.throws(()=>AlgorithmExecutionHarness.restore(rehash(packet)));
  }
});

test('rehashed checkpoint edits cannot alter pending payloads, observation claims or request identities',()=>{
  const harness=fresh();selectNext(harness);
  for(const change of [
    packet=>{packet.intents[0][1].arguments=[['str','different']];},
    packet=>{packet.intents[0][1].payload='["different"]';packet.intents[0][1].payloadDigest=hashAlgorithmData('["different"]');},
    packet=>{packet.intents[0][1].boundary='b1';},
    packet=>{packet.intents[0][1].attempt=2;},
    packet=>{packet.intents.push(structuredClone(packet.intents[0]));},
    packet=>{packet.timeline.find(row=>row.kind==='semantic').mode='observed';}
  ]){
    const packet=harness.checkpoint();change(packet);
    assert.throws(()=>AlgorithmExecutionHarness.restore(rehash(packet)));
  }
  harness.deliver(observation(harness,['num',7]));
  const packet=harness.checkpoint();
  packet.controller.history[1].line=encodeAlgorithmRecord({kind:'observe',request:'r0',id:'v0',status:'fulfilled',value:['num',9]});
  packet.controller=rehash(packet.controller);
  assert.throws(()=>AlgorithmExecutionHarness.restore(rehash(packet)),/checked prefix/);
});

test('unproved scheduling, cleanup, callbacks and out-of-order forms keep explicit detailed dispositions',()=>{
  const bodies=[
    'async function run(){try{return await host.readAsync("counter");}finally{host.store("cleanup",1);}}',
    'async function run(){const a=host.readAsync("a");const b=host.readAsync("b");return await b;}',
    'async function run(){return host.readAsync("counter").then(x=>x+1);}',
    'async function run(){const x=await host.readAsync("counter");if(x)host.store("counter",x);return x;}',
    'let retained=0;async function run(){retained++;return await host.readAsync("counter");}'
  ];
  for(const body of bodies)assert.throws(()=>defineAlgorithmProgram({source:'"use strict";'+body,entry:'run'}),
    error=>error.category==='unsupported.algorithm-profile');
});

test('v7 algorithm profiles reject earlier undifferentiated continuations and checkpoints',()=>{
  const harness=fresh();
  assert.equal(harness.exportEpisode().representation,'algorithm');
  assert.equal(harness.exportEpisode().profile,'algorithm-execution/1');
  assert.equal(harness.modelContext().representation,'algorithm');
  const old=harness.controller.checkpoint();
  delete old.representation;delete old.integrity;old.integrity=hashAlgorithmData(old);
  assert.throws(()=>AlgorithmController.restore(old),/continuation|fields/);
  const wrong=harness.controller.checkpoint();wrong.representation='detailed';
  delete wrong.integrity;wrong.integrity=hashAlgorithmData(wrong);
  assert.throws(()=>AlgorithmController.restore(wrong),/continuation/);
  const checkpoint=harness.checkpoint();checkpoint.schema='semantic-algorithm-checkpoint/1';
  delete checkpoint.integrity;checkpoint.integrity=hashAlgorithmData(checkpoint);
  assert.throws(()=>AlgorithmExecutionHarness.restore(checkpoint),/checkpoint/);
});
