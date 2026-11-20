import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntime} from '../src/runtime.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {instrumentCompletionSource,COMPLETION_HOOK} from '../src/training/completion-reference.js';
import {createProtocolCompletionCapture,ownedProtocolSourceObservations,prepareProtocolObservationExtensionsV8} from '../src/semantic/protocol-source-observations-v8.js';
import {compareProtocolMetadata} from '../src/semantic/protocol-metadata-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

const source=body=>'"use strict";function run(x){'+body+'}';
function archive(text,args=[2]){const runtime=createRuntime().startEntry({text,functionName:'run',args});runtime.drive();return runtime.exportRun();}
function native(text,args=[2]){
  const extensions=prepareProtocolObservationExtensionsV8({source:text}),capture=createProtocolCompletionCapture({initialValues:args,adapters:extensions.metadataAdapters});
  const context=vm.createContext({...extensions.globals,__args:args,__result:undefined,[COMPLETION_HOOK]:capture.capture});
  capture.setIntrinsicPrototypes(vm.runInContext('[Object.prototype,Array.prototype,Function.prototype]',context));
  extensions.initializeRealm(expression=>vm.runInContext(expression,context));
  vm.runInContext(extensions.instrument(instrumentCompletionSource(text))+'\n__result=run(...__args);',context);
  return {capture,result:context.__result,extensionObservations:extensions.observations()};
}
async function qualified(body,{expected,args=[2]}={}){
  const text=source(body),result=await verifyProtocolRegionTrainingCase({source:text,entry:'run',args,family:'synchronous-generator-source'});
  assert(result.exported,result.reason);const artifact=result.exported;
  assert(artifact.sidecar.protocolExtensions.includes('synchronous-generator-source/1'));
  assert.equal(artifact.sidecar.sourceArtifact.sidecar.reference.metadataAudit.status,'agreed');
  if(expected)assert.deepEqual(RegionExecutionHarness.replay(artifact).controller.completion,expected);
  return artifact;
}

test('independent generator metadata observes callee receiver arguments and actual suspended lifecycle',()=>{
  const text=source('function* g(n){const sent=yield n;return sent+1;}const it=g(x);const first=it.next(99);const second=it.next(7);return first.value+second.value;');
  const owned=ownedProtocolSourceObservations(archive(text),text),observed=native(text).capture;
  assert.deepEqual(owned.completions,observed.observations);
  assert.equal(compareProtocolMetadata(owned.metadata,observed.metadata).status,'agreed');
  const states=owned.metadata.flatMap(row=>row.objects.filter(node=>node.kind==='generator').map(node=>node.annotations[0].data.phase));
  assert(states.includes('suspendedStart'));assert(states.includes('suspendedYield'));assert(states.includes('executing'));assert(states.includes('completed'));
});

test('source generator values and sent inputs recheck every causal context and checkpoint',async()=>{
  const artifact=await qualified('function* g(n){const sent=yield n;return sent+1;}const it=g(x);const first=it.next(99);const second=it.next(7);return first.value+second.value;',
    {expected:{kind:'return',value:['num',10]}});
  const lines=artifact.public.timeline.map(row=>row.fields?.line??'').join('\n');
  for(const kind of ['generator.create','generator.start','generator.resume','generator.receive','generator.yield','generator.finish'])assert(lines.includes(kind));
  assert.equal((await recheckProtocolRegionEvidence(artifact)).valid,true);
  assert(artifact.contexts.some(row=>row.state.heap.some(([,node])=>node.kind==='generator'&&node.phase==='suspendedYield')));
});

test('normal yield delegation checks its value read while the enclosing source determines the final return',async()=>{
  for(const [body,expected] of [['return yield* inner();',7],['yield* inner();return 99;',99]]){
    const artifact=await qualified('function* inner(){yield 2;return 7;}function* outer(){'+body+
      '}const it=outer();it.next();return it.next().value;',{expected:{kind:'return',value:['num',expected]}});
    const lines=artifact.public.timeline.map(row=>row.fields?.line??''),
      end=lines.findIndex(line=>line.includes('"kind":"generator.delegate.end"'));
    assert(end>0);
    assert(lines.slice(0,end).some(line=>line.includes('"kind":"property.get"')&&
      line.includes('"key":["str","value"]')&&line.includes('"result":["num",7]')));
    const forged=structuredClone(artifact),row=forged.public.timeline.find((row,index)=>index>0&&
      row.fields?.line===lines[end+1]);
    assert(row?.fields.line.includes('"kind":"generator.finish"'));
    row.fields.line=row.fields.line.replace('"value":["num",'+expected+']','"value":["num",123]');
    forged.sidecar.publicDigest=hashAlgorithmData(forged.public);
    await assert.rejects(recheckProtocolRegionEvidence(forged),/public differs|source-certified/);
  }
});

test('generator return and throw preserve exact abrupt inputs before and after initial execution',async()=>{
  for(const body of ['return it.return(7).value;','it.next();return it.return(7).value;'])
    await qualified('function* g(){yield 1;return 2;}const it=g();'+body,{expected:{kind:'return',value:['num',7]}});
  for(const body of ['it.throw(7);','it.next();it.throw(7);'])
    await qualified('function* g(){yield 1;return 2;}const it=g();'+body,{expected:{kind:'throw',value:['num',7]}});
});

test('retained generators observe live capture cells and preserve the original method receiver',async()=>{
  await qualified('let n=x;const g=function* generate(){yield n;n++;return n;};const it=g();const first=it.next();n=9;const last=it.next();return first.value+last.value;',
    {expected:{kind:'return',value:['num',12]}});
  await qualified('function* g(a){yield this.n+a;return this.n;}const o={n:4,g};const it=o.g(x);const first=it.next();return first.value+it.next().value;',
    {expected:{kind:'return',value:['num',10]}});
});

test('anonymous generator initializers retain independently observed inferred names',async()=>{
  for(const name of ['values','stream']){
    const body='const '+name+'=function*(){yield x;return x+1;};const it='+name+'();'+
      'const first=it.next(),last=it.next();return [first.value,first.done,last.value,last.done];';
    const text=source(body),bundle=archive(text),observed=native(text),owned=ownedProtocolSourceObservations(bundle,text);
    assert.equal(compareProtocolMetadata(owned.metadata,observed.capture.metadata).status,'agreed');
    const definition=observed.capture.metadata.flatMap(row=>row.objects).find(node=>node.kind==='function'&&
      node.prototype==='GeneratorFunction.prototype');
    assert.equal(definition.properties.find(row=>row.key[1]==='name').descriptor.value[1],name);
    const artifact=await qualified(body),controller=RegionExecutionHarness.replay(artifact).controller;
    assert.deepEqual(controller.materialize(controller.completion.value),[2,false,3,true]);
    const changed=structuredClone(bundle);
    function rename(value){if(!value||typeof value!=='object')return;
      if(value.generatorFunction&&value.properties?.name)value.properties.name.value=['str','wrong'];
      for(const child of Object.values(value))rename(child);}
    rename(changed);
    assert.equal(compareProtocolMetadata(ownedProtocolSourceObservations(changed,text).metadata,observed.capture.metadata).status,'mismatch');
  }
  const observed=native(source('const __proto__=function*(){yield x;};const it=__proto__();return it.next().value;'));
  assert.equal(observed.result,2);
  assert(observed.capture.metadata.some(row=>row.objects.some(node=>node.kind==='function'&&
    node.properties?.some(property=>property.key[1]==='name'&&property.descriptor.value[1]==='__proto__'))));
});

test('compact work surrounds generator suspension without replacing its shared identity',async()=>{
  const artifact=await qualified('function* g(){yield 1;}const before=x+2;const it=g();const first=it.next();const after=before*3;return first.value+after;',
    {expected:{kind:'return',value:['num',13]}});
  assert(artifact.sidecar.regionCoverage.compactRegions>=2);
});

test('generator catch and cleanup preserve injected completion and can suspend before it survives',async()=>{
  const artifact=await qualified('function* g(){try{yield 1;}catch(e){yield e;}finally{yield 3;}return 4;}const it=g();const a=it.next();const b=it.throw(2);const c=it.return(7);const d=it.next();return [a.value,b.value,c.value,d.value];');
  const controller=RegionExecutionHarness.replay(artifact).controller;
  assert.deepEqual(controller.materialize(controller.completion.value),[1,2,3,7]);
  assert(artifact.contexts.some(row=>row.state.heap.some(([,node])=>node.kind==='generator'&&node.phase==='suspendedYield'&&
    node.handlers.some(handler=>handler.phase==='finally'&&handler.pending?.kind==='return'&&handler.pending.value[1]===7))));
  assert.equal((await recheckProtocolRegionEvidence(artifact)).valid,true);
});

test('nested cleanup preserves normal continuation and overriding return precedence',async()=>{
  await qualified('function* g(){try{try{yield 1;}finally{yield 2;}yield 3;}finally{yield 4;}return 5;}const it=g();const a=it.next();const b=it.next();const c=it.next();const d=it.next();const e=it.next();return a.value+b.value+c.value+d.value+e.value;',
    {expected:{kind:'return',value:['num',15]}});
  await qualified('function* g(){try{return 3;}finally{yield 4;return 5;}}const it=g();const a=it.next();return a.value+it.next().value;',
    {expected:{kind:'return',value:['num',9]}});
});

test('independent lifecycle evidence rejects hidden state mutants with unchanged returned values',()=>{
  const text=source('function* g(){yield 1;}const it=g();it.next();return 3;'),bundle=archive(text),observed=native(text).capture;
  const mutant=structuredClone(bundle),id=Object.values(mutant.finalState.heap).find(node=>node.kind==='generator').id;
  for(const event of mutant.events)for(const change of event.stateChanges)if(change.table==='heap'&&change.id===id)
    for(const node of [change.before,change.after])if(node?.state==='suspendedYield')node.state='completed';
  mutant.finalState.heap[id].state='completed';
  const owned=ownedProtocolSourceObservations(mutant,text);
  assert.deepEqual(owned.completions,observed.observations);
  assert.equal(compareProtocolMetadata(owned.metadata,observed.metadata).status,'mismatch');
});

test('independent resume receipts retain an abrupt input even when cleanup replaces its result',()=>{
  const text=source('function* g(){try{yield 1;}finally{return 5;}}const it=g();it.next();return it.return(7).value;'),
    bundle=archive(text),observed=native(text),owned=ownedProtocolSourceObservations(bundle,text);
  assert.equal(observed.result,5);assert.deepEqual(owned.extensionObservations,observed.extensionObservations);
  const mutant=structuredClone(bundle),resume=mutant.events.find(event=>event.operation==='call.enter'&&
    event.operands[0]?.[0]==='method'&&event.operands[0][1]?.[1]==='Generator.return');
  resume.operands[1]=['num',99];
  assert.notDeepEqual(ownedProtocolSourceObservations(mutant,text).extensionObservations,observed.extensionObservations);
});

test('generator call observation composes with builtin iterator observation without duplicate calls',()=>{
  const text=source('let calls=0;function* g(){calls++;yield 3;}const a=[x].values(),it=g();const first=it.next();return [a.next().value,first.value,calls];');
  const owned=ownedProtocolSourceObservations(archive(text),text),observed=native(text);
  assert.deepEqual(JSON.parse(JSON.stringify(observed.result)),[2,3,1]);
  assert.deepEqual(owned.completions,observed.capture.observations);
  assert.equal(compareProtocolMetadata(owned.metadata,observed.capture.metadata).status,'agreed');
});

test('independent yield delegation observes implicit generator resumes and original result identities',()=>{
  const text=source('function* inner(){try{yield 2;}finally{yield 3;}}function* g(){return yield* inner();}const it=g();const a=it.next();const b=it.return(7);const c=it.next();return [a.value,b.value,c.value];'),
    observed=native(text),owned=ownedProtocolSourceObservations(archive(text),text);
  assert.deepEqual([...observed.result],[2,3,7]);
  assert.deepEqual(owned.completions,observed.capture.observations);
  assert.deepEqual(owned.extensionObservations,observed.extensionObservations);
  assert.equal(compareProtocolMetadata(owned.metadata,observed.capture.metadata).status,'agreed');
});

test('delegation observation caches next once and preserves lookup order receiver and result identity',()=>{
  const text=source('let log="";const first={value:1,done:false};const iterator={'+
    '[Symbol.iterator](){log+="i";return this;},get next(){log+="g";return function(v){log+=(this===iterator?"r":"x")+v;return first;};},'+
    'get return(){log+="t";return function(v){log+=(this===iterator?"r":"x")+v;return {value:v,done:true};};}};'+
    'function* g(){yield* iterator;}const it=g();const a=it.next(9);Object.defineProperty(iterator,"next",{value:()=>{throw 99;}});'+
    'const b=it.next(3);const c=it.return(7);return [log,a===first,b===first,c.value,c.done];');
  const plain=vm.runInNewContext(text+';run();'),extensions=prepareProtocolObservationExtensionsV8({source:text}),
    context=vm.createContext({...extensions.globals});extensions.initializeRealm(expression=>vm.runInContext(expression,context));
  const observed=vm.runInContext(extensions.instrument(text)+';run();',context);
  assert.deepEqual([...observed],[...plain]);assert.deepEqual([...observed],['igrundefinedr3tr7',true,true,7,true]);
});

test('source delegation qualifies arrays strings and generator cleanup through every public checkpoint',async()=>{
  for(const body of [
    'function* g(){yield* [1,2];}const it=g();const a=it.next();const b=it.next(7);return a.value+b.value+it.next().done;',
    'function* g(){yield* "a😀";}const it=g();const a=it.next();const b=it.next();return a.value+b.value+it.next().done;',
    'function* g(){try{yield* [1,2];}finally{yield 3;}}const it=g();const a=it.next();const b=it.return(7);return a.value+b.value+it.next().value;',
    'function* inner(){try{yield 2;}finally{yield 3;}}function* g(){return yield* inner();}const it=g();const a=it.next();const b=it.return(7);return a.value+b.value+it.next().value;'
  ]){
    const artifact=await qualified(body);
    assert(artifact.contexts.some(row=>row.state.heap.some(([,node])=>node.kind==='generator'&&node.delegation?.phase==='yielded')));
    assert.equal((await recheckProtocolRegionEvidence(artifact)).valid,true);
  }
});

test('delegated throw is consumed by the inner catch outer catch or exact terminal completion',async()=>{
  await qualified('function* inner(){try{yield 1;}catch(e){yield e;return 4;}}function* g(){return yield* inner();}const it=g();const a=it.next();const b=it.throw(7);return a.value+b.value+it.next().value;',
    {expected:{kind:'return',value:['num',12]}});
  await qualified('function* inner(){yield 1;throw 4;}function* g(){try{yield* inner();}catch(e){yield e;return 9;}}const it=g();const a=it.next();const b=it.next();return a.value+b.value+it.next().value;',
    {expected:{kind:'return',value:['num',14]}});
  await qualified('function* inner(){yield 1;}function* g(){yield* inner();}const it=g();it.next();it.throw(7);',
    {expected:{kind:'throw',value:['num',7]}});
});

test('delegated return and throw guards reuse checked method selection without inventing source logical choices',()=>{
  for(const body of [
    'function* g(){yield* [1,2];}const it=g();it.next();return it.return(7).value;',
    'function* inner(){try{yield 2;}finally{yield 3;}}function* g(){return yield* inner();}const it=g();it.next();it.return(7);return it.next().value;',
    'function* inner(){try{yield 1;}catch(e){return e;}}function* g(){return yield* inner();}const it=g();it.next();return it.throw(7).value;'
  ]){
    const {claims,outcome}=compileProtocolSourceV8(archive(source(body)));
    assert.deepEqual(outcome.graph.roots.at(-1),['num',7]);
    assert(!claims.some(row=>row.certificate.rule==='owned-source-logical-choice/1'));
    assert(claims.some(row=>['generator.delegate.call','generator.delegate.absent'].includes(row.record.kind)));
  }
});

test('generator own data preserves Symbol keys aliases and mutations across suspended checkpoints',async()=>{
  const artifact=await qualified('function* g(n){yield n;return n+1;}const it=g(x),alias=it,key=Symbol("state"),shared={value:4};'+
    'it.extra=1;it[key]=shared;it.extra+=it.next().value;shared.value=7;return alias.extra+it[key].value+it.next().value;',
    {expected:{kind:'return',value:['num',13]}});
  const timeline=artifact.public.timeline,cut=timeline.findIndex(row=>row.fields?.line?.includes('"kind":"generator.yield"'))+1;
  assert(cut>0);
  const prefix=RegionExecutionHarness.replay({...artifact.public,timeline:timeline.slice(0,cut)},{requireTerminal:false}),
    packet=JSON.parse(JSON.stringify(prefix.checkpoint())),restored=RegionExecutionHarness.restore(packet),
    generator=[...restored.controller.heap.values()].find(node=>node.kind==='generator');
  assert.equal(generator.phase,'suspendedYield');assert.deepEqual(generator.properties.get('extra'),['num',1]);
  assert([...generator.properties].some(([key,value])=>Array.isArray(key)&&key[0]==='symbol'&&value[0]==='ref'));
  for(const row of timeline.slice(cut))restored.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  assert.deepEqual(restored.exportEpisode(),artifact.public);
  assert.equal((await recheckProtocolRegionEvidence(artifact)).valid,true);
});

test('independent generator metadata rejects an altered own descriptor when all scalar observations agree',()=>{
  const text=source('function* g(){yield 1;}const it=g();it.extra=3;return 1;'),
    bundle=archive(text),mutant=structuredClone(bundle),observed=native(text),
    id=Object.values(bundle.finalState.heap).find(node=>node.kind==='generator').id;
  for(const event of mutant.events)for(const change of event.stateChanges)if(change.table==='heap'&&change.id===id)
    for(const node of [change.before,change.after])if(node?.properties.extra)
      (node.dataAttributes??={}).extra={writable:true,enumerable:false,configurable:true};
  mutant.finalState.heap[id].dataAttributes={extra:{writable:true,enumerable:false,configurable:true}};
  const owned=ownedProtocolSourceObservations(mutant,text);
  assert.deepEqual(owned.completions,observed.capture.observations);
  assert.equal(compareProtocolMetadata(owned.metadata,observed.capture.metadata).status,'mismatch');
});

test('custom delegation missing-throw errors and intrinsic method overrides retain explicit source refusals',async()=>{
  for(const body of [
    'function* g(){yield* {[Symbol.iterator](){return {next(){return {done:true,value:1};}};}};}const it=g();return it.next().value;',
    'function* g(){yield* [1,2];}const it=g();it.next();it.throw(7);'
  ]){
    const result=await verifyProtocolRegionTrainingCase({source:source(body),entry:'run',args:[2],family:'generator-refusal'});
    assert.equal(result.status,'unsupported');assert(!result.exported);
  }
  assert.throws(()=>compileProtocolSourceV8(archive(source('function* g(){yield 1;}const it=g();it.next=()=>({value:9,done:false});return it.next().value;'))),/intrinsic.*callable profile|intrinsic.*callable protocol/);
});
