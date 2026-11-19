import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntime} from '../src/runtime.js';
import {instrumentCompletionSource,COMPLETION_HOOK} from '../src/training/completion-reference.js';
import {createProtocolCompletionCapture,ownedProtocolSourceObservations} from '../src/semantic/protocol-source-observations-v8.js';
import {compareProtocolMetadata} from '../src/semantic/protocol-metadata-v8.js';
import {createIteratorObservationAdapterV8} from '../src/semantic/protocol-iterator-observations-v8.js';

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
