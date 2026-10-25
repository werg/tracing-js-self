import assert from 'node:assert/strict';
import test from 'node:test';
import {SelectedModelDriver,selectedWitnessFromGroup} from '../src/training/model-driver.js';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
import {encodeWitness} from '../src/training/format.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';

const source='function run(){const a=host.readAsync("a");const b=host.readAsync("b");return 1;}';
const calls=analyzeSemanticProgram(source).sites.filter(x=>x.operation==='demo.readAsync');
const request=(fx,key,index)=>encodeWitness('request',{effect:fx,operation:'demo.readAsync',
  invocation:'call1',promise:'p'+fx,site:{start:calls[index].start,end:calls[index].end},
  arguments:[['str',key]],payload:JSON.stringify([key])});
const returns=encodeWitness('return',{value:['num',1]});
const end=encodeWitness('end',{kind:'return'});

test('selected supplier issues two effects before waiting and observes reverse settlement',async()=>{
  let readA,reads=0;
  const broker=new SelectedExecutionHarness({services:{
    'demo.readAsync':([key])=>{
      reads++;
      return key==='a'?new Promise(resolve=>{readA=resolve;}):Promise.resolve(20);
    }
  }});
  let polls=0;
  const selector=async prefix=>{
    assert.equal(prefix.schema,'selected-inference-prefix/2');
    assert.equal(prefix.programId,'p');
    assert.equal(prefix.entry,'run');
    assert(!JSON.stringify(prefix).includes('fixtureReplies'));
    const selected=prefix.committed.filter(x=>x.kind==='semantic');
    const observed=prefix.committed.filter(x=>x.kind==='result');
    if(!selected.length)return request('fx1','a',0);
    if(selected.length===1)return request('fx2','b',1);
    if(observed.length!==2){
      polls++;
      if(observed.some(x=>x.effectId==='fx2')&&typeof readA==='function'){
        readA(10);readA=null;
      }
      return {wait:true};
    }
    if(selected.length===2)return returns;
    if(selected.length===3)return end;
    throw new Error('Unexpected model context');
  };
  const driver=new SelectedModelDriver({select:selector,harness:broker});
  const outcome=await driver.run({programId:'p',source,entry:'run',
    capabilities:['demo.readAsync'],invocationId:'call1',realmId:'r1',
    trackId:'worker1',triggerId:'outside1'});
  assert.equal(outcome.completion.value[1],1);
  assert.equal(reads,2);
  assert(polls>=1);
  assert.deepEqual(broker.timeline.filter(x=>x.kind==='result')
    .map(x=>x.effectId),['fx2','fx1']);
  assert.equal(driver.rejections.length,0);
  assert.equal(outcome.episode.sidecar.admission,'locally_verified');
});

test('invalid model output is audited before committing any native effect',async()=>{
  let calls=0;
  const driver=new SelectedModelDriver({select:async()=> 'observe {"effect":"fx1","status":"fulfilled","result":["num",2]}',
    harness:new SelectedExecutionHarness({services:{
      'demo.readAsync':()=>{calls++;return 4;}
    }})});
  await assert.rejects(driver.run({programId:'p',source,entry:'run',
    capabilities:['demo.readAsync'],invocationId:'i',trackId:'w',
    realmId:'r',triggerId:'outside1'}),/cannot|Host observations/i);
  assert.equal(calls,0);assert.equal(driver.rejections.length,1);
});

test('model group bridge reads one committed owner from its actual selected tape',()=>{
  const line=encodeWitness('return',{value:['num',1]});
  const group={tape:{payloads:[line],valid:[true],modalities:['text'],
    tracks:['worker1'],event_ids:['e1'],meridian_id:1}};
  assert.equal(selectedWitnessFromGroup(group,'worker1'),line);
  assert.throws(()=>selectedWitnessFromGroup(group,'other'),/owner/);
  assert.throws(()=>selectedWitnessFromGroup({...group,
    tape:{...group.tape,valid:[false]}},'worker1'),/complete/);
  assert.throws(()=>selectedWitnessFromGroup({...group,
    tape:{...group.tape,payloads:['observe {}']}},'worker1'),/Invalid|missing/i);
});

test('retained model prefixes expose earlier public realm history without unrelated realms or private broker data',async()=>{
  const harness=new SelectedExecutionHarness(),select=prefix=>
    prefix.committed.some(item=>item.kind==='semantic')?end:returns;
  const driver=new SelectedModelDriver({harness,select});
  try{
    for(const [invocationId,realmId] of [['first','shared'],['foreign','other'],['next','shared']])
      await driver.run({programId:'pure',source:'function run(){return 1;}',entry:'run',
        invocationId,trackId:'track:'+invocationId,realmId,triggerId:'input:'+invocationId,realmPolicy:'retained'});
    const prefix=driver.prefix('next');
    assert.deepEqual(prefix.realmCommitted.filter(item=>item.kind==='invocation').map(item=>item.invocationId),['first','next']);
    assert.equal(prefix.realmCommitted.filter(item=>item.kind==='program').length,1);
    assert(prefix.realmCommitted.some(item=>item.invocationId==='first'&&item.kind==='semantic'));
    assert(!prefix.committed.some(item=>item.invocationId==='first'));
    assert(!prefix.realmCommitted.some(item=>item.invocationId==='foreign'));
    assert(prefix.realmCommitted.every(item=>item.sequence<=harness.globalSequence));
    assert.equal(Object.hasOwn(prefix,'intents'),false);
    const before=harness.timeline[0].source;
    prefix.realmCommitted[0].source='mutated model context';
    assert.equal(harness.timeline[0].source,before);
  }finally{driver.close();}
});

test('back-to-back callbacks wait for the previous native completion acknowledgement without blocking suspended parents',async()=>{
  const harness=new SelectedExecutionHarness(),selected=[];
  let release,acknowledgeStarted;
  const acknowledgementStarted=new Promise(resolve=>{acknowledgeStarted=resolve;});
  const acknowledgement=new Promise(resolve=>{release=resolve;});
  const select=prefix=>{
    selected.push(prefix.invocationId);
    const count=prefix.committed.filter(item=>item.kind==='semantic').length;
    if(prefix.invocationId==='owner')return [
      encodeWitness('allocate',{name:'closure',kind:'closure',properties:[],code:'later',captures:[]}),
      encodeWitness('return',{value:['ref','closure']}),end][count];
    return [returns,end][count];
  };
  select.complete=async prefix=>{
    if(prefix.invocationId==='callbackinvoke1'){acknowledgeStarted();await acknowledgement;}
  };
  const driver=new SelectedModelDriver({harness,select});
  try{
    let owner=await driver.run({programId:'closures',source:'function run(){return function later(){return 1;};}',
      entry:'run',invocationId:'owner',realmId:'retained',realmPolicy:'retained',trackId:'worker',triggerId:'outside'});
    if(owner.taskCompletion)owner=await owner.taskCompletion;
    const first=driver.invokeClosure({ownerInvocationId:'owner',closureId:'closure'});
    const second=driver.invokeClosure({ownerInvocationId:'owner',closureId:'closure'});
    await acknowledgementStarted;
    await new Promise(resolve=>setImmediate(resolve));
    assert(selected.includes('callbackinvoke1'));
    assert(!selected.includes('callbackinvoke2'),'next callback cannot consume native capacity before close acknowledgement');
    release();await first;await second;
    await Promise.all([...driver.running.values()].map(run=>run.task));
    assert(selected.includes('callbackinvoke2'));
  }finally{release();driver.close();}
});
