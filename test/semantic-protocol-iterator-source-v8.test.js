import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntime} from '../src/runtime.js';
import {instrumentCompletionSource,COMPLETION_HOOK} from '../src/training/completion-reference.js';
import {createProtocolCompletionCapture,ownedProtocolSourceObservations} from '../src/semantic/protocol-source-observations-v8.js';
import {compareProtocolMetadata} from '../src/semantic/protocol-metadata-v8.js';
import {createIteratorObservationAdapterV8} from '../src/semantic/protocol-iterator-observations-v8.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';

function bundle(source,args=[]){const runtime=createRuntime().startEntry({text:source,functionName:'run',args});
  const outcome=runtime.drive();assert.equal(outcome.kind,'terminated');return runtime.exportRun();}
function observed(source,args=[]){
  const adapter=createIteratorObservationAdapterV8({side:'native'}),capture=createProtocolCompletionCapture({initialValues:args,adapters:[adapter.metadataAdapter]});
  const context=vm.createContext({...adapter.globals,__args:args,__out:undefined,[COMPLETION_HOOK]:capture.capture});
  adapter.initializeRealm(expression=>vm.runInContext(expression,context));
  capture.setIntrinsicPrototypes(vm.runInContext('[Object.prototype,Array.prototype,Function.prototype]',context));
  const transformed=adapter.instrument(instrumentCompletionSource(source));
  vm.runInContext(transformed+'\n__out=run(...__args)',context);return {capture,result:context.__out,transformed};
}

test('independent iterator metadata tracks actual native calls, source aliases and live positions',()=>{
  for(const source of [
    '"use strict";function run(x){const a=[,x];const it=a.values();const first=it.next();a[2]=x+1;const second=it.next();const third=it.next();const end=it.next();a[3]=9;const again=it.next();return [first.value,second.value,third.value,end.done,again.done];}',
    '"use strict";function run(){const a=[1,2];const it=a.entries();const first=it.next();const second=it.next();return [first.value,second.value,it.next().done];}',
    '"use strict";function run(){const it="a😀\\ud800"[Symbol.iterator]();const first=it.next();const second=it.next();const third=it.next();return [first.value,second.value,third.value,it.next().done];}'
  ]){
    const args=[4],archive=bundle(source,args),native=observed(source,args),owned=ownedProtocolSourceObservations(archive,source,{adapters:[createIteratorObservationAdapterV8]});
    assert.deepEqual(owned.completions,native.capture.observations);
    const compared=compareProtocolMetadata(owned.metadata,native.capture.metadata);assert.equal(compared.status,'agreed',JSON.stringify(compared));
    assert(owned.metadata.some(row=>row.objects.some(node=>node.kind==='iterator')));
  }
});

test('iterator observation preserves nested calls, sequence receivers, lookup timing and argument effects',()=>{
  const source='"use strict";function run(){let log=[];const o={get next(){log[log.length]="lookup";return function(v){log[log.length]=this===o?"receiver":"wrong";return v;};}};function arg(){log[log.length]="argument";return 3;}const value=(0,o)[(log[log.length]="key","next")](arg());const nested=[7].values().next().value;return [value,nested,log];}';
  const original=vm.runInNewContext(source+';run()'),instrumented=observed(source).result;
  assert.deepEqual(JSON.parse(JSON.stringify(instrumented)),JSON.parse(JSON.stringify(original)));
  assert.deepEqual(JSON.parse(JSON.stringify(instrumented[2])),['key','lookup','argument','receiver']);
});

test('iterator observation leaves private, super and optional-chain call references intact',()=>{
  const source='"use strict";function run(){class A{next(){return 2;}}class B extends A{#next(){return 3;}read(){return super.next()+this.#next();}}const absent=null;return [new B().read(),absent?.value.next()];}';
  const original=vm.runInNewContext(source+';run()'),instrumented=observed(source).result;
  assert.deepEqual(JSON.parse(JSON.stringify(instrumented)),JSON.parse(JSON.stringify(original)));
});

test('unobserved iterator calls cannot be silently treated as ordinary metadata',()=>{
  const adapter=createIteratorObservationAdapterV8({side:'native'}),context=vm.createContext({});
  adapter.initializeRealm(expression=>vm.runInContext(expression,context));
  const capture=createProtocolCompletionCapture({adapters:[adapter.metadataAdapter]});
  const iterator=vm.runInContext('[1].values()',context);
  assert.throws(()=>capture.capture('site','initialize',iterator),/independently observed creation/);
});

test('independent metadata rejects a changed hidden cursor with unchanged source completion observations',()=>{
  const source='"use strict";function run(){const it=[7,8].values();it.next();return 3;}',archive=bundle(source),native=observed(source);
  const mutant=structuredClone(archive),id=Object.values(mutant.finalState.heap).find(node=>node.kind==='iterator').id;
  for(const state of [mutant.initialState,mutant.finalState])if(state.heap[id])state.heap[id].nextIndex++;
  for(const event of mutant.events)for(const change of event.stateChanges)if(change.table==='heap'&&change.id===id)
    for(const node of [change.before,change.after])if(node)node.nextIndex++;
  const receipts=ownedProtocolSourceObservations(mutant,source,{adapters:[createIteratorObservationAdapterV8]});
  assert.deepEqual(receipts.completions,native.capture.observations);
  assert.equal(compareProtocolMetadata(receipts.metadata,native.capture.metadata).status,'mismatch');
});

test('source-qualified iterators interleave compact arithmetic with checked cursor operations and causal contexts',async()=>{
  const source='"use strict";function run(x){const before=x+2;const a=[,x];const it=a.values();const first=it.next();a[2]=x+1;const second=it.next();const third=it.next();const end=it.next();const av=second.value;const bv=third.value;const after=av+bv;return before+after+1;}';
  const result=await verifyProtocolRegionTrainingCase({source,entry:'run',args:[4],family:'builtin-iterator-mixed'});
  assert(result.exported,result.reason);const artifact=result.exported;
  assert.deepEqual(artifact.sidecar.protocolExtensions,['builtin-iterator/1']);
  assert(artifact.sidecar.regionCoverage.compactRegions>=2);assert(artifact.public.timeline.some(row=>row.fields.line?.includes('iterator.next')));
  const cursorStates=artifact.contexts.flatMap(row=>row.state.heap.filter(([,node])=>node.kind==='iterator').map(([,node])=>node));
  assert(cursorStates.some(node=>node.nextIndex===0));assert(cursorStates.some(node=>node.nextIndex===3&&node.done));
  assert.deepEqual(RegionExecutionHarness.replay(artifact).controller.completion,{kind:'return',value:['num',16]});
  const verified=await recheckProtocolRegionEvidence(artifact);assert(verified.valid&&verified.sourceValidated&&verified.replayValidated);
  await assert.rejects(()=>recheckProtocolRegionEvidence(artifact,{requireNative:true}),/pinned consumer/);
  const {hashAlgorithmData}=await import('../src/semantic/program.js'),mutant=structuredClone(artifact);
  const context=mutant.contexts.find(row=>row.state.heap.some(([,node])=>node.kind==='iterator'));
  context.state.heap.find(([,node])=>node.kind==='iterator')[1].nextIndex++;
  mutant.sidecar.contextDigest=hashAlgorithmData(mutant.contexts);
  await assert.rejects(()=>recheckProtocolRegionEvidence(mutant),/contexts differs/);
});

test('source iterator qualification covers entry pairs, input-array methods, strings, helpers and standard array loops',async()=>{
  const fixtures=[
    {source:'"use strict";function run(){const a=[8,9];const it=a.entries();const first=it.next();const second=it.next();return first.value[0]+first.value[1]+second.value[0]+second.value[1];}',args:[],value:18},
    {source:'"use strict";function run(a){const it=a.values();return it.next().value+it.next().value;}',args:[[5,6]],value:11},
    {source:'"use strict";function run(){const it="a😀"[Symbol.iterator]();const a=it.next();const b=it.next();return a.value+b.value;}',args:[],value:'a😀'},
    {source:'"use strict";function run(){function make(a){return a.values();}const it=make([7,8]);return it.next().value+it.next().value;}',args:[],value:15},
    {source:'"use strict";function run(x){let total=x+1;const a=[1,2];for(const value of a){total+=value;if(value===1)a[2]=3;}return total+2;}',args:[4],value:13}
  ];
  for(const [index,fixture]of fixtures.entries()){
    const result=await verifyProtocolRegionTrainingCase({...fixture,entry:'run',family:'builtin-iterator-source-'+index});
    assert(result.exported,result.reason);const actual=RegionExecutionHarness.replay(result.exported).controller.completion.value;
    assert.deepEqual(actual,[typeof fixture.value==='number'?'num':'str',fixture.value]);
    assert.equal(result.exported.sidecar.sourceArtifact.sidecar.reference.metadataAudit.status,'agreed');
  }
});

test('unrepresented iterator behavior remains an explicit source refusal',async()=>{
  for(const source of [
    '"use strict";function run(){return [1].values();}',
    '"use strict";function run(){const it=[1].values();const next=it.next;return next();}',
    '"use strict";function run(){const it={[Symbol.iterator]:function(){return this;},next:function(){return 3;}};for(const value of it){}return 3;}'
  ]){
    const result=await verifyProtocolRegionTrainingCase({source,entry:'run',family:'iterator-refusal'});
    assert.equal(result.status,'unsupported');assert.equal(result.regionDisposition,'source-unqualified');assert(!result.exported);
  }
});

test('frozen source iterator artifact rechecks original execution, metadata, public contexts and replay',async()=>{
  const {readFile}=await import('node:fs/promises');
  const fixtures=JSON.parse(await readFile(new URL('./fixtures/semantic-iterator-region-v8.json',import.meta.url),'utf8'));
  for(const {artifact}of fixtures.cases)assert.equal((await recheckProtocolRegionEvidence(artifact)).valid,true);
});
