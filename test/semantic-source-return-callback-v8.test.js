import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {RETURN_CALLBACK_FIXTURES} from '../fixtures/semantic-regions/return-callbacks.js';
import {verifyRegionTrainingCase,recheckRegionEvidence} from '../src/semantic/compiler-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {DurableHostIngressBroker} from '../src/semantic/host-ingress-journal-v8.js';
import {DurableHostIngressJournal} from '../src/storage/host-ingress-journal.js';
import {decodeOwnedGraph} from '../src/host/graph-codec.js';

const certified=[];
test.before(async()=>{
  for(const fixture of RETURN_CALLBACK_FIXTURES){
    const result=await verifyRegionTrainingCase(fixture);
    assert(result.exported,JSON.stringify(result));certified.push(result.exported);
  }
});

test('ordinary source callback returns, throws and reentrant host work agree with four independent source runs',async()=>{
  for(const [index,artifact] of certified.entries()){
    const fixture=RETURN_CALLBACK_FIXTURES[index],h=RegionExecutionHarness.replay(artifact);
    assert.deepEqual(h.controller.completion,fixture.expected);
    const source=artifact.sidecar.sourceArtifact.sidecar;
    assert.equal(source.referenceStatus,'agreed');
    assert.equal(source.effects.filter(row=>row.kind==='callback-return').length,fixture.callbacks);
    assert.equal(source.effects.filter(row=>row.kind==='callback-completion').length,fixture.callbacks);
    assert.equal(source.compiler.certificates.filter(row=>row.rule==='owned-return-callback/8').length,fixture.callbacks);
    assert.equal(source.replay.nativeReplayDispatches,0);
    const checked=await recheckRegionEvidence(JSON.parse(JSON.stringify(artifact)));
    assert.equal(checked.sourceValidated,true);assert.equal(checked.projectionValidated,true);
    assert.equal(checked.native.status,'untested');
  }
});

test('source-produced receiver aliases and captured cells survive queued and active durable child restoration',async t=>{
  const artifact=certified[0],rows=artifact.public.timeline;
  const cut=rows.findIndex(row=>row.kind==='invocation'&&row.fields.activation==='callback');
  const first=rows[cut].fields,source=artifact.sidecar.sourceArtifact.sidecar.archive;
  const arrivals=new Map(source.events.filter(e=>e.operation==='external.callback.enqueue').map(event=>{
    const job=event.stateChanges.find(p=>p.table==='control').after.queue.at(-1);return [job.returnId,job];
  }));
  const directory=await mkdtemp(join(tmpdir(),'v8-source-callback-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const journal=new DurableHostIngressJournal({directory,streamId:'source'});
  let h=RegionExecutionHarness.replay({...artifact.public,timeline:rows.slice(0,cut)},{requireTerminal:false});
  const beforeArrival=JSON.parse(JSON.stringify(h.checkpoint()));
  let broker=new DurableHostIngressBroker({harness:h,journal}),adapterCalls=0;
  const enqueue=async fields=>{
    const arrival=arrivals.get(fields.invocationId),[receiver,...args]=decodeOwnedGraph(JSON.stringify(arrival.inputGraph));
    await broker.receiveCallback({ownerInvocationId:fields.parentInvocationId,parentEffectId:arrival.effectId,
      closureId:fields.closureId,invocationId:fields.invocationId,receiver,args,deliver:false});
    await broker.flush();
  };
  await enqueue(first);
  h=await RegionExecutionHarness.restoreDurable(beforeArrival,{ingressJournal:journal,
    ingressLogReceipt:broker.receipt,services:{'natlang.call':()=>{adapterCalls++;}}});
  broker=h.inner.hostIngressBroker;
  assert.equal(h.inner.closureQueue.length,1);assert.equal(h.inner.completionWaiters.size,0);
  assert.equal(h.timeline.length,cut,'restoration must not publish a private arrival');
  let activeRestored=false,completedChildren=0;
  for(const row of rows.slice(cut)){
    if(row.kind==='invocation'&&row.fields.activation==='callback'){
      if(row.fields.invocationId!==first.invocationId)await enqueue(row.fields);
      h.inner.activateQueuedClosures(row.fields.realmId);h.sync();
      assert.deepEqual(h.timeline.at(-1),row,'durable admission must reproduce the source-derived invocation');
    }else if(row.mode==='observed'){
      if(row.kind==='result'){
        assert.equal(completedChildren,2);
        assert.equal(h.intents.get(first.parentInvocationId+'/'+arrivals.get(first.invocationId).effectId).status,'uncertain',
          'guest callback completion must not infer the external parent result');
      }
      h.importObserved(row); // A retained, independently checked external receipt.
    }else{
      h.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
      const activation=h.invocations.get(row.fields.invocationId);
      if(activation.activation==='callback'&&activation.status==='completed')completedChildren++;
      if(!activeRestored&&row.fields.invocationId===first.invocationId&&activation.status!=='completed'){
        const checkpoint=JSON.parse(JSON.stringify(h.checkpoint())),count=h.timeline.length;
        h=await RegionExecutionHarness.restoreDurable(checkpoint,{ingressJournal:journal,
          ingressLogReceipt:broker.receipt,services:{'natlang.call':()=>{adapterCalls++;}}});
        broker=h.inner.hostIngressBroker;activeRestored=true;
        assert.equal(h.timeline.length,count);assert.equal(h.inner.closureQueue.length,0);
        assert.equal(h.inner.completionWaiters.size,0);
        await assert.rejects(h.dispatch(first.parentInvocationId,arrivals.get(first.invocationId).effectId),/uncertain/);
      }
    }
  }
  assert(activeRestored);assert.equal(completedChildren,2);assert.equal(adapterCalls,0);
  assert.deepEqual(h.controller.completion,RETURN_CALLBACK_FIXTURES[0].expected);
  assert.deepEqual(h.exportEpisode(),artifact.public);
});

test('a source-derived callback resumes in a fresh process with no native waiter or parent redispatch',async t=>{
  const artifact=certified[1],rows=artifact.public.timeline;
  const cut=rows.findIndex(row=>row.kind==='invocation'&&row.fields.activation==='callback');
  const fields=rows[cut].fields,source=artifact.sidecar.sourceArtifact.sidecar.archive;
  const arrival=source.events.find(e=>e.operation==='external.callback.enqueue').stateChanges[0].after.queue.at(-1);
  const directory=await mkdtemp(join(tmpdir(),'v8-source-callback-process-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const journal=new DurableHostIngressJournal({directory,streamId:'source'});
  const h=RegionExecutionHarness.replay({...artifact.public,timeline:rows.slice(0,cut)},{requireTerminal:false});
  const checkpoint=h.checkpoint(),broker=new DurableHostIngressBroker({harness:h,journal});
  const [receiver,...args]=decodeOwnedGraph(JSON.stringify(arrival.inputGraph));
  await broker.receiveCallback({ownerInvocationId:fields.parentInvocationId,parentEffectId:arrival.effectId,
    closureId:fields.closureId,invocationId:fields.invocationId,receiver,args,deliver:false});await broker.flush();
  const packet=join(directory,'source-prefix.json');
  await writeFile(packet,JSON.stringify({checkpoint,receipt:broker.receipt,suffix:rows.slice(cut),
    expected:RETURN_CALLBACK_FIXTURES[1].expected,parent:fields.parentInvocationId,effect:arrival.effectId}));
  const script=`import {readFile} from 'node:fs/promises';
    import assert from 'node:assert/strict';
    import {RegionExecutionHarness as H} from ${JSON.stringify(new URL('../src/semantic/region-harness.js',import.meta.url).href)};
    import {DurableHostIngressJournal as J} from ${JSON.stringify(new URL('../src/storage/host-ingress-journal.js',import.meta.url).href)};
    const p=JSON.parse(await readFile(process.argv[1],'utf8'));let calls=0;
    const h=await H.restoreDurable(p.checkpoint,{ingressJournal:new J({directory:process.argv[2],streamId:'source'}),
      ingressLogReceipt:p.receipt,services:{'natlang.call':()=>{calls++;}}});
    assert.equal(h.inner.completionWaiters.size,0);assert.equal(h.inner.closureQueue.length,1);
    await assert.rejects(h.dispatch(p.parent,p.effect),/uncertain/);
    for(const row of p.suffix){
      if(row.kind==='invocation'&&row.fields.activation==='callback'){
        h.inner.activateQueuedClosures(row.fields.realmId);h.sync();assert.deepEqual(h.timeline.at(-1),row);
      }else if(row.mode==='observed'){
        if(row.kind==='result')assert.equal(h.intents.get(p.parent+'/'+p.effect).status,'uncertain');
        h.importObserved(row);
      }else h.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
    }
    assert.deepEqual(h.controller.completion,p.expected);assert.equal(calls,0);
    process.stdout.write('source callback restored without native redispatch');`;
  const child=spawnSync(process.execPath,['--input-type=module','--eval',script,packet,directory],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/source callback restored/);
});

test('fresh-process source recovery preserves nested callback host waits without inferring either parent result',async t=>{
  const artifact=certified[3],rows=artifact.public.timeline;
  const childRows=rows.filter(row=>row.kind==='invocation'&&row.fields.activation==='callback');
  assert.equal(childRows.length,2);
  const firstCut=rows.indexOf(childRows[0]),grandchildCut=rows.indexOf(childRows[1]);
  const source=artifact.sidecar.sourceArtifact.sidecar.archive;
  const arrivals=new Map(source.events.filter(e=>e.operation==='external.callback.enqueue').map(event=>{
    const job=event.stateChanges.find(p=>p.table==='control').after.queue.at(-1);return [job.returnId,job];
  }));
  const directory=await mkdtemp(join(tmpdir(),'v8-source-nested-process-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const journal=new DurableHostIngressJournal({directory,streamId:'nested'});
  const h=RegionExecutionHarness.replay({...artifact.public,timeline:rows.slice(0,firstCut)},{requireTerminal:false});
  const broker=new DurableHostIngressBroker({harness:h,journal});
  const enqueue=async row=>{
    const fields=row.fields,arrival=arrivals.get(fields.invocationId);
    const [receiver,...args]=decodeOwnedGraph(JSON.stringify(arrival.inputGraph));
    await broker.receiveCallback({ownerInvocationId:fields.parentInvocationId,parentEffectId:arrival.effectId,
      closureId:fields.closureId,invocationId:fields.invocationId,receiver,args,deliver:false});
    await broker.flush();
  };
  await enqueue(childRows[0]);
  h.inner.activateQueuedClosures(childRows[0].fields.realmId);h.sync();
  assert.deepEqual(h.timeline.at(-1),childRows[0]);
  for(const row of rows.slice(firstCut+1,grandchildCut)){
    if(row.mode==='observed')h.importObserved(row);
    else h.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  }
  assert.equal(h.invocations.get(childRows[0].fields.invocationId).status,'suspended');
  const checkpoint=h.checkpoint(); // The later grandchild arrival is journal-only.
  await enqueue(childRows[1]);
  const parentKeys=childRows.map(row=>row.fields.parentInvocationId+'/'+arrivals.get(row.fields.invocationId).effectId);
  const packet=join(directory,'nested-source-prefix.json');
  await writeFile(packet,JSON.stringify({checkpoint,receipt:broker.receipt,suffix:rows.slice(grandchildCut),
    expected:RETURN_CALLBACK_FIXTURES[3].expected,parentKeys,first:childRows[0].fields.invocationId,
    grandchild:childRows[1].fields.invocationId,public:artifact.public}));
  const script=`import {readFile} from 'node:fs/promises';
    import assert from 'node:assert/strict';
    import {RegionExecutionHarness as H} from ${JSON.stringify(new URL('../src/semantic/region-harness.js',import.meta.url).href)};
    import {DurableHostIngressJournal as J} from ${JSON.stringify(new URL('../src/storage/host-ingress-journal.js',import.meta.url).href)};
    const p=JSON.parse(await readFile(process.argv[1],'utf8'));let calls=0,receipts=0;
    const h=await H.restoreDurable(p.checkpoint,{ingressJournal:new J({directory:process.argv[2],streamId:'nested'}),
      ingressLogReceipt:p.receipt,services:{'natlang.call':()=>{calls++;}}});
    assert.deepEqual(h.exportEpisode(),p.checkpoint.public);
    assert.equal(h.invocations.get(p.first).status,'suspended');assert.equal(h.inner.completionWaiters.size,0);
    assert.deepEqual(h.inner.closureQueue.map(row=>row.invocationId),[p.grandchild]);
    for(const key of p.parentKeys){
      const intent=h.intents.get(key);assert.equal(intent.status,'uncertain');
      await assert.rejects(h.dispatch(intent.invocationId,intent.effectId),/uncertain/);
    }
    for(const row of p.suffix){
      if(row.kind==='invocation'&&row.fields.activation==='callback'){
        h.inner.activateQueuedClosures(row.fields.realmId);h.sync();assert.deepEqual(h.timeline.at(-1),row);
      }else if(row.mode==='observed'){
        if(row.kind==='result'){
          assert.equal(h.intents.get(p.parentKeys[0]).status,'uncertain');
          assert.equal(h.inner.callbackOutcome(receipts===0?p.grandchild:p.first).status,'fulfilled');
          if(receipts===0)assert.equal(h.intents.get(p.parentKeys[1]).status,'uncertain');
          receipts++;
        }
        h.importObserved(row); // Recorded external evidence, not an inferred guest result.
      }else h.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
    }
    assert.equal(receipts,2);assert.equal(h.invocations.size,3);assert.equal(calls,0);
    assert.deepEqual(h.controller.completion,p.expected);assert.deepEqual(h.exportEpisode(),p.public);
    process.stdout.write('nested source callbacks restored once with both parents reconciled by recorded receipts');`;
  const child=spawnSync(process.execPath,['--input-type=module','--eval',script,packet,directory],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/nested source callbacks restored once/);
});
