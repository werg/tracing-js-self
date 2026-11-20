import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {auditProtocolSourceV8} from '../src/semantic/protocol-source-reference-v8.js';
import {encodeDetailedRecord} from '../src/semantic/detailed-v7.js';
import {createProtocolCompletionCapture} from '../src/semantic/protocol-source-observations-v8.js';

const getter='"use strict";function run(x){const before=x+2;const s=Symbol("key");const o={};let calls=0;Object.defineProperty(o,s,{get:()=>{calls++;return x+3;}});const a=o[s];return before+a+calls;}';
function build(source,args=[]){const runtime=createRuntime({maxSteps:10000}).startEntry({text:source,functionName:'run',args});runtime.drive();
  const bundle=runtime.exportRun(),compiled=compileProtocolSourceV8(bundle);return {bundle,compiled};}
async function checked(source,args=[]){const {bundle,compiled}=build(source,args);
  const audit=await auditProtocolSourceV8({bundle,referenceInput:{source,entry:'run',inputGraph:encodeNativeGraph(args)},outcome:compiled.outcome});
  assert.equal(audit.status,'agreed');return {bundle,compiled,audit};}

test('source Symbol getter retains rich state, live captures and independently checked arithmetic on both sides',async()=>{
  const {compiled,audit}=await checked(getter,[4]);
  assert.deepEqual(compiled.outcome.graph.roots.at(-1),['num',14]);
  const protocols=compiled.claims.filter(row=>row.kind==='protocol').map(row=>row.record);
  assert(protocols.some(row=>row.kind==='property.define'&&row.key[0]==='symbol'&&row.descriptor.kind==='accessor'));
  assert.equal(protocols.filter(row=>row.kind==='property.get.call').length,1);
  assert.equal(protocols.filter(row=>row.kind==='property.finish').length,1);
  assert.equal(audit.operationAudit.checked,5);assert.equal(audit.completionAudit.checked,11);
  const call=compiled.claims.findIndex(row=>row.record.kind==='property.get.call'),finish=compiled.claims.findIndex(row=>row.record.kind==='property.finish');
  assert(compiled.claims.slice(0,call).some(row=>row.kind==='detail'&&row.record.kind==='compute'));
  assert(compiled.claims.slice(finish+1).some(row=>row.kind==='detail'&&row.record.kind==='compute'));
  assert(compiled.claims.every(row=>!row.line.includes('journalEvents')&&!row.line.includes('sourceId')));
});

test('source Symbol identities, registry keys and reflective key enumeration remain distinct',async()=>{
  const source='"use strict";function run(){const a=Symbol("same"),b=Symbol("same");const r=Symbol.for("registry"),again=Symbol.for("registry");const o={};o[a]=3;o[b]=4;o["\\0symbol:o2"]=5;const keys=Reflect.ownKeys(o);return [a===b,r===again,Symbol.keyFor(r),a.description,keys.length,o[a],o[b],o["\\0symbol:o2"]];}';
  const {compiled}=await checked(source);
  assert.equal(compiled.claims.filter(row=>row.record.kind==='symbol.for').length,2);
  assert(compiled.claims.some(row=>row.record.kind==='property.keys'));
  assert(compiled.claims.some(row=>row.record.kind==='symbol.read'&&row.record.operation==='keyFor'));
});

test('source setter has dynamic this, a live capture, and assignment completion independent of setter return',async()=>{
  const source='"use strict";function run(){let calls=0;const s=Symbol("x");const o={value:1};Object.defineProperty(o,s,{set:function(v){calls++;this.value=v;return 999;}});const result=(o[s]=7);return [result,o.value,calls];}';
  const {compiled}=await checked(source);
  const finish=compiled.claims.find(row=>row.record.kind==='property.finish').record;
  assert.deepEqual(finish.completion,{kind:'normal',value:['num',7]});
  assert(compiled.claims.some(row=>row.record.kind==='allocate'&&row.record.functionKind==='ordinary'));
});

test('new source observation identity protocol does not widen historical public values',()=>{
  const a=Symbol('x'),b=Symbol('x'),capture=createProtocolCompletionCapture();
  capture.capture('one','initialize',a);capture.capture('two','initialize',b);capture.capture('three','return',a);
  assert.deepEqual(capture.observations.map(row=>row.value),[['identity','symbol',1],['identity','symbol',2],['identity','symbol',1]]);
  assert.throws(()=>encodeDetailedRecord({kind:'bind',fields:{name:'s',value:['symbol','o1']}},{role:'generated'}),/value|scalar|Symbol|tag/i);
});

test('source projection retains unused Proxy target and handler identities behind a scalar result',async()=>{
  const source='"use strict";function run(){const s=Symbol("x");const o=new Proxy({x:3},{});return 3;}',
    {compiled,audit}=await checked(source),allocation=compiled.claims.find(row=>row.record.kind==='proxy.create');
  assert(allocation);
  assert.notDeepEqual(allocation.record.target,allocation.record.handler);
  assert.deepEqual(compiled.outcome.graph.roots.at(-1),['num',3]);
  assert.equal(audit.extensionAudit.status,'agreed');
  assert(audit.observations.metadata.some(row=>row.objects.some(node=>node.kind==='proxy')));
});

test('source projection refuses unmodeled hidden state even when the final scalar would match',()=>{
  for(const source of [
    '"use strict";function run(){const s=Symbol("x");return s;}',
    '"use strict";async function run(){const s=Symbol("x");return 3;}',
    '"use strict";function run(){const s=Symbol("x");const o={};o[s]=3;return o;}'
  ])assert.throws(()=>build(source),/protocol|boundary|Symbol|primitive|Unsupported|source|data|strict owned/i);
});

test('direct protocol region artifacts mix compact arithmetic, retain causal contexts and recheck exact source',async()=>{
  const {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence}=await import('../src/semantic/protocol-source-v8.js');
  const {RegionExecutionHarness}=await import('../src/semantic/region-harness.js');
  const {sharedRegionState}=await import('../src/semantic/regions.js');
  const fixture={source:getter,entry:'run',args:[4],family:'protocol-getter'},result=await verifyProtocolRegionTrainingCase(fixture);
  assert(result.exported,result.reason);assert.equal(result.exported.sidecar.schema,'semantic-protocol-region-evidence/1');
  const artifact=result.exported,replayed=RegionExecutionHarness.replay(artifact);
  assert.equal(artifact.contexts[0].state.protocol,null);
  assert(artifact.contexts.some(context=>context.state.protocol?.pendingCalls.length));
  assert.equal(artifact.contexts.length,artifact.public.timeline.filter(row=>row.mode==='generated').length);
  const generated=artifact.public.timeline.filter(row=>row.mode==='generated'),first=generated.findIndex(row=>row.kind==='protocol'),last=generated.findLastIndex(row=>row.kind==='protocol'&&row.fields.line.includes('property.finish'));
  assert(generated.slice(0,first).some(row=>row.kind==='region'));
  assert(generated.slice(last+1).some(row=>row.kind==='region'));
  assert.deepEqual(replayed.controller.completion,{kind:'return',value:['num',14]});
  const resumed=RegionExecutionHarness.restore(replayed.checkpoint());
  assert.deepEqual(sharedRegionState(resumed.controller),sharedRegionState(replayed.controller));
  const checked=await recheckProtocolRegionEvidence(artifact);
  assert(checked.sourceValidated&&checked.projectionValidated&&checked.replayValidated);
  assert.equal(checked.native.admitted,false);
  await assert.rejects(()=>recheckProtocolRegionEvidence(artifact,{requireNative:true}),/pinned consumer/);
});

test('source context, descriptor and completion tampering cannot survive a fresh source recheck',async()=>{
  const {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence}=await import('../src/semantic/protocol-source-v8.js');
  const {hashAlgorithmData}=await import('../src/semantic/program.js');
  const {exported}=await verifyProtocolRegionTrainingCase({source:getter,entry:'run',args:[4],family:'protocol-tamper'});
  const context=structuredClone(exported);context.contexts.at(-1).state.protocol.symbols.find(row=>row.kind==='unique').description=['str','changed'];
  context.sidecar.contextDigest=hashAlgorithmData(context.contexts);
  await assert.rejects(()=>recheckProtocolRegionEvidence(context),/contexts differs/);
  const target=structuredClone(exported);target.sidecar.sourceArtifact.public.claims.find(row=>row.line.includes('property.define')).line+=' ';
  target.sidecar.sourceArtifactDigest=hashAlgorithmData(target.sidecar.sourceArtifact);
  await assert.rejects(()=>recheckProtocolRegionEvidence(target),/source, owned archive|target|projection/);
  const source=structuredClone(exported);source.sidecar.sourceArtifact.sidecar.referenceInput.source=getter.replace('return x+3','return x+9');
  source.sidecar.sourceArtifactDigest=hashAlgorithmData(source.sidecar.sourceArtifact);
  await assert.rejects(()=>recheckProtocolRegionEvidence(source),/source, owned archive|source target|source-certified/);
});

test('source null-prototype reads and abrupt setters preserve protocol distinctions',async()=>{
  const {verifyProtocolRegionTrainingCase}=await import('../src/semantic/protocol-source-v8.js');
  const {RegionExecutionHarness}=await import('../src/semantic/region-harness.js');
  for(const [source,completion]of [
    ['"use strict";function run(){const s=Symbol("x");const o=Object.create(null);o[s]=3;return o.toString;}',{kind:'return',value:['undefined']}],
    ['"use strict";function run(){const s=Symbol("x");const o={};Object.defineProperty(o,s,{set:function(v){throw "no";}});o[s]=7;return 1;}',{kind:'throw',value:['str','no']}]
  ]){
    const result=await verifyProtocolRegionTrainingCase({source,entry:'run',family:'protocol-completion'});
    assert(result.exported,result.reason);assert.deepEqual(RegionExecutionHarness.replay(result.exported).controller.completion,completion);
  }
});

test('committed source-region fixture rechecks its full public contexts and private source evidence',async()=>{
  const {readFileSync}=await import('node:fs');
  const {recheckProtocolRegionEvidence}=await import('../src/semantic/protocol-source-v8.js');
  const fixtures=JSON.parse(readFileSync(new URL('./fixtures/semantic-protocol-region-v8.json',import.meta.url),'utf8'));
  assert.equal(fixtures.schema,'semantic-protocol-region-fixtures/1');
  for(const row of fixtures.cases)assert.equal((await recheckProtocolRegionEvidence(row.artifact)).valid,true,row.id);
});

test('independent metadata receipts reject descriptor, prototype and Symbol mutants with an identical scalar result',async()=>{
  const {ownedProtocolSourceObservations}=await import('../src/semantic/protocol-source-observations-v8.js');
  const {compareProtocolMetadata}=await import('../src/semantic/protocol-metadata-v8.js');
  const {ownedEffectfulOutcome}=await import('../src/training/effectful-compiler.js');
  const source='"use strict";function run(){const s=Symbol("key");const o={};o[s]=3;return 7;}';
  const {bundle,compiled,audit}=await checked(source);
  assert.equal(audit.metadataAudit.status,'agreed');assert(audit.metadataAudit.checked>0);
  const target=Object.values(bundle.finalState.heap).find(node=>Object.keys(node.properties??{}).some(key=>key.startsWith('\0symbol:'))).id;
  const symbol=Object.values(bundle.finalState.heap).find(node=>node.kind==='symbol').id;
  const transforms=[
    node=>{if(node.id===target)for(const key of Object.keys(node.properties??{})){node.dataAttributes??={};node.dataAttributes[key]={writable:false,enumerable:true,configurable:true};}},
    node=>{if(node.id===target)node.prototype=null;},
    node=>{if(node.id===target)node.prototype='Array.prototype';},
    node=>{if(node.id===symbol)node.description=['str','different'];}
  ];
  for(const transform of transforms){
    const mutant=structuredClone(bundle);
    for(const state of [mutant.initialState,mutant.finalState])for(const node of Object.values(state.heap))transform(node);
    for(const event of mutant.events)for(const change of event.stateChanges.filter(change=>change.table==='heap'))
      for(const node of [change.before,change.after])if(node)transform(node);
    assert.deepEqual(ownedEffectfulOutcome(mutant),compiled.outcome,'scalar outcome alone must not detect this mutant');
    const observed=ownedProtocolSourceObservations(mutant,source);
    assert.deepEqual(observed.completions,audit.observations.completions,'identity/scalar receipts alone must not detect this mutant');
    assert.equal(compareProtocolMetadata(observed.metadata,audit.observations.metadata).status,'mismatch');
  }
});

test('independent metadata inspection never invokes getters and rejects Proxy traps before observation',()=>{
  const {capture,metadata}=createProtocolCompletionCapture();let getters=0,traps=0;
  const object={get x(){getters++;return 3;}};capture('one','initialize',object);
  assert.equal(getters,0);assert.equal(metadata[0].objects[0].properties[0].descriptor.kind,'accessor');
  const proxy=new Proxy({}, {ownKeys(){traps++;return [];},getPrototypeOf(){traps++;return Object.prototype;},getOwnPropertyDescriptor(){traps++;return undefined;}});
  assert.throws(()=>capture('two','initialize',proxy),/Proxy metadata/);assert.equal(traps,0);
});

test('a consistently faulty teacher can replay its metadata bug, but the independent source gate rejects it',async()=>{
  const {Runtime}=await import('../src/runtime.js');
  const source='"use strict";function run(){const s=Symbol("key");const o={};Object.defineProperty(o,s,{get:function(){return 3;},enumerable:false});return 7;}';
  for(const mode of ['enumerable','prototype']){
    const original=Runtime.prototype.commit,seen=new WeakSet();let mutant;
    try{
      Runtime.prototype.commit=function(operation,callback,options){return original.call(this,operation,(draft,eventId)=>{
        const result=callback(draft,eventId);
        if(mode==='prototype'&&operation==='object.allocate'&&!seen.has(this)){
          draft.heap[result.result[1]].prototype=null;seen.add(this);
        }
        const callee=result?.operands?.[0],name=callee?.[0]==='method'?callee[1]?.[1]:null;
        if(mode==='enumerable'&&operation==='call.enter'&&name==='Object.defineProperty'){
          const target=draft.heap[result.operands[1][1]];
          for(const descriptor of Object.values(target.accessors??{}))descriptor.enumerable=true;
        }
        return result;
      },options);};
      mutant=build(source); // Includes validateBundle, exact owned replay, and public machine claims.
    }finally{Runtime.prototype.commit=original;}
    assert.deepEqual(mutant.compiled.outcome.graph.roots.at(-1),['num',7]);
    await assert.rejects(()=>auditProtocolSourceV8({bundle:mutant.bundle,
      referenceInput:{source,entry:'run',inputGraph:encodeNativeGraph([])},outcome:mutant.compiled.outcome}),/metadataAudit.*mismatch/);
  }
});
