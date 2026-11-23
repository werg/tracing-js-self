import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from 'acorn';
import {Runtime} from '../src/runtime.js';
import {gitBlobSha} from '../src/test262-baseline.js';
import {buildTest262Catalog} from '../src/conformance/test262-catalog.js';
import {discoverTest262ModuleDependencies} from '../src/conformance/test262-acquisition.js';
import {ownedTest262Profile,executeOfficialTest262Variant,prepareOfficialTest262Variant} from '../src/conformance/test262-runner.js';
import {executeOfficialTest262Reference} from '../src/conformance/test262-reference.js';
import {freeTest262Identifiers} from '../src/conformance/test262-capabilities.js';
import {replayExact} from '../src/replay.js';

const revision='1'.repeat(40);
const official=Object.fromEntries(['assert.js','sta.js','doneprintHandle.js','compareArray.js'].map(name=>
  ['harness/'+name,readFileSync(new URL('../fixtures/test262-harness/'+name,import.meta.url),'utf8')]));
const source=(body,metadata='')=>`/*---\ndescription: original-runner qualification control\n${metadata}---*/\n${body}`;
function fixture(body,{metadata='',extra={},profile=ownedTest262Profile()}={}){
  const sources={...official,...extra,'test/control.js':source(body,metadata)};
  const snapshot={repository:'tc39/test262',revision,
    files:Object.fromEntries(Object.entries(sources).map(([path,text])=>[path,gitBlobSha(text)]))};
  const catalog=buildTest262Catalog({snapshot,sources,profile});
  return catalog.variants.map(variant=>({variant,profile,suiteRevision:revision,sources}));
}
function both(body,settings={}){
  return fixture(body,settings).map(options=>({options,owned:executeOfficialTest262Variant(options),
    reference:executeOfficialTest262Reference(options)}));
}
function moduleFixture(body,{metadata='',dependencies={},profile=ownedTest262Profile(),flags='module',
  moduleDependencies=null}={}){
  const sources={...official,...dependencies,'test/control.js':source(body,'flags: ['+flags+']\n'+metadata)};
  const snapshot={repository:'tc39/test262',revision,
    files:Object.fromEntries(Object.entries(sources).map(([path,text])=>[path,gitBlobSha(text)]))};
  const catalog=buildTest262Catalog({snapshot,sources,profile,
    moduleDependencies:moduleDependencies??discoverTest262ModuleDependencies(sources)});
  return catalog.variants.map(variant=>({variant,profile,suiteRevision:revision,sources}));
}
function rawHashbangModule(){
  const path='test/hashbang-module.js',text='#!\n/*---\nflags: [module, raw]\n---*/\n';
  const sources={[path]:text};
  const profile=ownedTest262Profile();
  const snapshot={repository:'tc39/test262',revision,
    files:{[path]:gitBlobSha(text)}};
  const catalog=buildTest262Catalog({snapshot,sources,profile,
    moduleDependencies:discoverTest262ModuleDependencies(sources)});
  const variant=catalog.variants[0];
  return {variant,profile,suiteRevision:revision,sources};
}
const statuses=(rows,status)=>{for(const row of rows){assert.equal(row.owned.status,status,row.owned.reason);assert.equal(row.reference.status,status,row.reference.reason);}};

test('original scripts run both required variants with original assert/sta/includes and source suffix',()=>{
  const rows=both('assert.compareArray([1,2],[1,2]);',{metadata:'includes: [compareArray.js]\n'});
  statuses(rows,'passed');
  assert.deepEqual(rows.map(row=>row.options.variant.mode),['sloppy','strict']);
  for(const {options,owned} of rows){
    const prepared=prepareOfficialTest262Variant(options);
    assert.deepEqual(prepared.harness.map(file=>file.path),['harness/assert.js','harness/sta.js','harness/compareArray.js']);
    assert.equal(prepared.code,(options.variant.mode==='strict'?'"use strict";\n':'')+options.sources['test/control.js']);
    assert.equal(owned.trace.structurallyValidated,true);assert.equal(owned.trace.exactlyReplayed,true);
    assert.equal(owned.claims.publicSemanticReplay,false);
  }
});

test('real assertion failures, wrong error constructor and missing throw remain failures',()=>{
  for(const body of ['assert.sameValue(1,2);','assert.throws(TypeError,function(){});',
    'assert.throws(TypeError,function(){throw new RangeError("wrong");});'])statuses(both(body),'failed');
  statuses(both('assert.throws(TypeError,function(){throw new TypeError("right");});'),'passed');
});

test('runtime negatives require actual owned error identity and cannot use names or host diagnostics',()=>{
  const metadata='negative:\n  phase: runtime\n  type: TypeError\n';
  statuses(both('throw new TypeError("right");',{metadata}),'passed');
  for(const body of ['throw "TypeError";','throw {name:"TypeError"};','throw new RangeError("wrong");','assert.sameValue(1,1);'])
    statuses(both(body,{metadata}),'failed');
  const missing=fixture('eval("unknownName");',{metadata:'negative:\n  phase: runtime\n  type: ReferenceError\n'});
  for(const options of missing)assert.equal(executeOfficialTest262Variant(options).status,'unsupported');
});

test('unsupported Object.defineProperty object storage cannot satisfy runtime-negative TypeError',()=>{
  const metadata='negative:\n  phase: runtime\n  type: TypeError\n';
  for(const body of [
    'Object.defineProperty(function(){},"x",{value:1});',
    'Object.defineProperty(Object.is,"x",{value:1});',
    'Object.defineProperty({},"x",function(){});'
  ])for(const {owned,reference} of both(body,{metadata})){
    assert.equal(owned.status,'unsupported',owned.reason);
    assert.match(owned.reason,/Object.defineProperty (?:descriptor )?requires owned ordinary storage/);
    assert.equal(reference.status,'failed',reference.reason);
  }
});

test('implemented Promise descriptors preserve the original false-negative counterexamples as genuine completions',()=>{
  const metadata='negative:\n  phase: runtime\n  type: TypeError\n';
  for(const body of [
    'Object.defineProperty(Promise.resolve(0),"constructor",{value:Promise});',
    'var define=Object.defineProperty;define(Promise.resolve(0),"x",{value:1});',
    'Object.defineProperty({},"x",Promise.resolve(0));'
  ])statuses(both(body,{metadata}),'failed');
  statuses(both('var p=Promise.resolve(0),caught=false;try{Object.defineProperty(p,"x",{value:1});}catch(error){caught=true;}'+
    'assert.sameValue(caught,false);assert.sameValue(p.x,1);'),'passed');
});

test('Object.defineProperty primitive targets and descriptors retain genuine guest TypeErrors',()=>{
  const metadata='negative:\n  phase: runtime\n  type: TypeError\n';
  for(const primitive of ['undefined','null','false','0','"value"','0n','Symbol("key")']){
    statuses(both('Object.defineProperty('+primitive+',"x",{});',{metadata}),'passed');
    statuses(both('Object.defineProperty({},"x",'+primitive+');',{metadata}),'passed');
  }
});

test('catching unsupported Object.defineProperty storage cannot manufacture a passing original script',()=>{
  statuses(both('try{Object.defineProperty(Promise.resolve(0),"x",{value:1});}catch(error){}'),'passed');
  for(const {owned,reference} of both('try{Object.defineProperty(function(){},"x",{value:1});}catch(error){}')){
    assert.equal(owned.status,'unsupported',owned.reason);
    assert.equal(reference.status,'passed',reference.reason);
  }
});

test('unsupported prototype and extensibility storage cannot manufacture runtime-negative TypeErrors',()=>{
  const metadata='negative:\n  phase: runtime\n  type: TypeError\n';
  for(const body of [
    'Object.getPrototypeOf(0);',
    'Object.getPrototypeOf(Object);',
    'Object.create(Object);',
    'var object={};Object.preventExtensions(object);'+
      'if(!Object.isFrozen(new Proxy(object,{})))throw new TypeError();'
  ])for(const {owned,reference} of both(body,{metadata})){
    assert.equal(owned.status,'unsupported',owned.reason);
    assert.match(owned.reason,/requires owned ordinary storage/);
    assert.equal(reference.status,'failed',reference.reason);
  }
});

test('implemented Promise prototype and extensibility operations cannot satisfy a negative TypeError',()=>{
  const metadata='negative:\n  phase: runtime\n  type: TypeError\n';
  for(const body of [
    'Object.getPrototypeOf(Promise.resolve(0));',
    'Object.setPrototypeOf(Promise.resolve(0),null);',
    'Object.create(Promise.resolve(0));',
    'Object.setPrototypeOf({},Promise.resolve(0));',
    'Object.preventExtensions(Promise.resolve(0));',
    'if(!Object.isExtensible(Promise.resolve(0)))throw new TypeError();'
  ]){
    statuses(both(body,{metadata}),'failed');
    statuses(both('var caught=false;try{'+body+'}catch(error){caught=true;}assert.sameValue(caught,false);'),'passed');
  }
});

test('prototype primitive errors, invalid prototypes and ordinary invariants remain genuine guest errors',()=>{
  const metadata='negative:\n  phase: runtime\n  type: TypeError\n';
  for(const body of [
    'Object.create(undefined);','Object.create(0);','Object.create(Symbol("key"));',
    'Object.getPrototypeOf(null);','Object.getPrototypeOf(undefined);',
    'Object.setPrototypeOf(null,null);','Object.setPrototypeOf(undefined,null);',
    'Object.setPrototypeOf({},0);','Object.setPrototypeOf(1,0);',
    'Object.setPrototypeOf(Promise.resolve(0),0);',
    'var object={};Object.setPrototypeOf(object,object);',
    'var object={};Object.preventExtensions(object);Object.setPrototypeOf(object,null);'
  ])statuses(both(body,{metadata}),'passed');
  statuses(both('assert.sameValue(Object.setPrototypeOf(1,null),1);'+
    'assert.sameValue(Object.setPrototypeOf(false,{}),false);'+
    'assert.sameValue(Object.setPrototypeOf("value",Object.prototype),"value");'+
    'assert.sameValue(Object.setPrototypeOf(0n,null),0n);'+
    'var key=Symbol("key");assert.sameValue(Object.setPrototypeOf(key,null),key);'),'passed');
});

test('prototype and extensibility implementation refusals cannot be caught by original source',()=>{
  for(const body of [
    'Object.getPrototypeOf(Object);',
    'Object.create(Object);',
    'Object.isFrozen(new Proxy({},{}));'
  ])for(const {owned,reference} of both('try{'+body+'}catch(error){}')){
    assert.equal(owned.status,'unsupported',owned.reason);
    assert.match(owned.reason,/requires owned ordinary storage/);
    assert.equal(reference.status,'passed',reference.reason);
  }
});

test('namespace Reflect.defineProperty distinguishes unsupported descriptors from primitive errors',()=>{
  const metadata='negative:\n  phase: runtime\n  type: TypeError\n',
    dependencies={'test/dep_FIXTURE.js':'export const value=1;'};
  for(const descriptor of ['Promise.resolve(0)','function(){}','0','null']){
    const [options]=moduleFixture('import * as ns from "./dep_FIXTURE.js";Reflect.defineProperty(ns,"value",'+descriptor+');',
      {metadata,dependencies});
    const owned=executeOfficialTest262Variant(options),reference=executeOfficialTest262Reference(options);
    const primitive=['0','null'].includes(descriptor);
    assert.equal(owned.status,primitive?'passed':'unsupported',owned.reason);
    assert.equal(reference.status,primitive?'passed':'failed',reference.reason);
    if(!primitive)assert.match(owned.reason,/Reflect.defineProperty descriptor requires owned ordinary storage/);
  }
});

test('unowned callable and prototype-named accessor definitions cannot manufacture guest outcomes',()=>{
  const metadata='negative:\n  phase: runtime\n  type: TypeError\n';
  for(const body of [
    'Object.defineProperty({},"x",{get:Object.is});',
    'Object.defineProperty({},"x",{set:Number});',
    'Object.defineProperty({},"x",{get:Object.getPrototypeOf(function(){})});',
    'Object.defineProperty({},"__proto__",{get:function(){return 1;}});',
    'Object.defineProperty({},"__proto__",{set:function(value){}});'
  ]){
    for(const {owned,reference} of both(body,{metadata})){
      assert.equal(owned.status,'unsupported',owned.reason);
      assert.match(owned.reason,/Accessor definition requires owned (?:callable|prototype-named) storage/);
      assert.equal(reference.status,'failed',reference.reason);
    }
    for(const {owned,reference} of both('try{'+body+'}catch(error){}')){
      assert.equal(owned.status,'unsupported',owned.reason);
      assert.equal(reference.status,'passed',reference.reason);
    }
  }
});

test('invalid accessor types and non-configurable property invariants retain genuine guest TypeErrors',()=>{
  const metadata='negative:\n  phase: runtime\n  type: TypeError\n';
  for(const body of [
    'Object.defineProperty({},"x",{get:0});',
    'Object.defineProperty({},"x",{set:{}});',
    'Object.defineProperty({},"x",{get:Promise.resolve(0)});',
    'Object.defineProperty({},"x",{get:function(){},value:0});',
    'Object.defineProperty([],"length",{get:function(){}});',
    'Object.defineProperty([],"length",{get:Object.is});',
    'var object={};Object.defineProperty(object,"x",{get:function(){}});'+
      'Object.defineProperty(object,"x",{get:Object.is});',
    'var object={};Object.defineProperty(object,"__proto__",{value:1});'+
      'Object.defineProperty(object,"__proto__",{get:function(){}});'
  ])statuses(both(body,{metadata}),'passed');
});

test('incomplete function descriptors cannot manufacture a frozen-object runtime-negative pass',()=>{
  const metadata='negative:\n  phase: runtime\n  type: TypeError\n';
  for(const initializer of ['function(){}','async function(){}','()=>{}']){
    const body='var f='+initializer+';Object.preventExtensions(f);if(Object.isFrozen(f))throw new TypeError();';
    for(const {owned,reference} of both(body,{metadata})){
      assert.equal(owned.status,'unsupported',owned.reason);
      assert.match(owned.reason,/Object.isFrozen requires owned complete function descriptors/);
      assert.equal(reference.status,'failed',reference.reason);
    }
    for(const {owned,reference} of both('try{'+body+'}catch(error){}')){
      assert.equal(owned.status,'unsupported',owned.reason);
      assert.equal(reference.status,'passed',reference.reason);
    }
  }
  statuses(both('var f=function*(){};Object.preventExtensions(f);assert.sameValue(Object.isFrozen(f),false);'),'passed');
});

test('unmodeled Proxy object storage cannot manufacture constructor-negative or caught-error passes',()=>{
  const metadata='negative:\n  phase: runtime\n  type: TypeError\n';
  for(const body of [
    'new Proxy(function(){},{});',
    'new Proxy(Promise.resolve(0),{});',
    'new Proxy(Object.is,{});',
    'new Proxy({},function(){});',
    'new Proxy({},Promise.resolve(0));',
    'new Proxy({},new Proxy({},{}));'
  ]){
    for(const {owned,reference} of both(body,{metadata})){
      assert.equal(owned.status,'unsupported',owned.reason);
      assert.match(owned.reason,/Proxy construction requires owned ordinary target and handler storage/);
      assert.equal(reference.status,'failed',reference.reason);
    }
    for(const {owned,reference} of both('try{'+body+'}catch(error){}')){
      assert.equal(owned.status,'unsupported',owned.reason);
      assert.equal(reference.status,'passed',reference.reason);
    }
  }
  for(const primitive of ['undefined','null','false','0','"value"','0n','Symbol("key")']){
    statuses(both('new Proxy('+primitive+',{});',{metadata}),'passed');
    statuses(both('new Proxy({},'+primitive+');',{metadata}),'passed');
  }
  statuses(both('new Proxy(function(){},0);',{metadata}),'passed');
});

test('raw preserves exact bytes and loads no implicit harness or wrapper',()=>{
  const [options]=fixture('if(typeof assert!=="undefined")throw 1;', {metadata:'flags: [raw]\n'});
  assert.equal(options.variant.mode,'raw');
  const result=executeOfficialTest262Variant({...options,includeBundle:true});
  assert.equal(result.status,'passed',result.reason);
  assert.deepEqual(result.bundle.sources.map(item=>item.text),[options.sources['test/control.js']]);
  assert.equal(result.bundle.sources.length,1);
  assert.equal(executeOfficialTest262Reference(options).status,'passed');
});

test('strict variants preserve an original hashbang before inserting the directive',()=>{
  for(const lineEnding of ['\n','\r\n','\r','\u2028','\u2029']){
    const path='test/hashbang.js';
    const original='#!/usr/bin/env node'+lineEnding+'/*---\nflags: [onlyStrict]\n---*/\n'+
      'assert.sameValue((function(){return this;})(),undefined);';
    const sources={...official,[path]:original};
    const snapshot={repository:'tc39/test262',revision,
      files:Object.fromEntries(Object.entries(sources).map(([file,text])=>[file,gitBlobSha(text)]))};
    const profile=ownedTest262Profile();
    const catalog=buildTest262Catalog({snapshot,sources,profile});
    const [variant]=catalog.variants;
    const options={variant,profile,suiteRevision:revision,sources};
    const prepared=prepareOfficialTest262Variant(options);
    assert.equal(prepared.code,'#!/usr/bin/env node'+lineEnding+'"use strict";'+lineEnding+
      original.slice(original.indexOf(lineEnding)+lineEnding.length));
    assert.equal(executeOfficialTest262Variant(options).status,'passed');
    assert.equal(executeOfficialTest262Reference(options).status,'passed');
  }
});

test('parse negatives execute neither original body nor harness and strict prefix affects early syntax',()=>{
  const metadata='flags: [onlyStrict]\nnegative:\n  phase: parse\n  type: SyntaxError\n';
  const [options]=fixture('$DONOTEVALUATE();with({}){}',{metadata});
  delete options.sources['harness/assert.js'];
  const result=executeOfficialTest262Variant(options);
  assert.equal(result.status,'passed');assert.equal(result.executionPerformed,false);assert.equal(result.parseOnly,true);
  assert.equal(result.stages.ownedExecution,undefined);
  assert.equal(executeOfficialTest262Reference(options).status,'passed');
  statuses(both('const f=()=>1;',{metadata:'negative:\n  phase: parse\n  type: SyntaxError\n'}),'failed');
  for(const row of both('let = ;',{metadata:'negative:\n  phase: early\n  type: SyntaxError\n'})){
    assert.equal(row.owned.status,'unsupported');assert.equal(row.reference.status,'unsupported');
  }
});

test('async uses original doneprintHandle with exact completion and meaningful failure controls',()=>{
  const settings={metadata:'flags: [async]\n'};
  statuses(both('Promise.resolve(3).then(function(value){assert.sameValue(value,3);$DONE();});',settings),'passed');
  statuses(both('$DONE(new Error("bad"));',settings),'failed');
  statuses(both('$DONE();$DONE();',settings),'failed');
  statuses(both('Promise.resolve(1);',settings),'resource_limited');
  statuses(both('function $DONE(){print("Test262:AsyncTestComplete");}$DONE();',settings),'failed');
  statuses(both('print("Test262:AsyncTestComplete");',settings),'failed');
  statuses(both('__consolePrintHandle__=function(){};$DONE();print("Test262:AsyncTestComplete");',settings),'failed');
  statuses(both('var done=$DONE;$DONE=function(){};done();',settings),'passed');
  statuses(both('new $DONE();',settings),'passed');
  statuses(both('var n=0;__consolePrintHandle__=function(){if(++n===1)print("Test262:AsyncTestComplete");};$DONE();$DONE();',settings),'failed');
});

test('module reference async completion requires the original harness call and its output',()=>{
  for(const [body,status] of [
    ['await Promise.resolve();$DONE();','passed'],
    ['print("Test262:AsyncTestComplete");','failed'],
    ['$DONE=function(){print("Test262:AsyncTestComplete");};$DONE();','failed'],
    ['__consolePrintHandle__=function(){};$DONE();print("Test262:AsyncTestComplete");','failed'],
    ['var done=$DONE;$DONE=function(){};done();','passed'],
    ['new $DONE();','passed'],
    ['var n=0;__consolePrintHandle__=function(){if(++n===1)print("Test262:AsyncTestComplete");};$DONE();$DONE();','failed']
  ]){
    const [options]=moduleFixture(body,{flags:'module, async'});
    const result=executeOfficialTest262Reference(options);
    assert.equal(result.status,status,body+': '+result.reason);
  }
});

test('async error arguments and caught completion exceptions cannot be rewritten into success',()=>{
  const controls=[
    '__consolePrintHandle__=function(){print("Test262:AsyncTestComplete");};$DONE(new Error("bad"));',
    '__consolePrintHandle__=function(){print("Test262:AsyncTestComplete");};new $DONE("bad");',
    '__consolePrintHandle__=function(){print("Test262:AsyncTestComplete");throw new Error("print failed");};try{$DONE();}catch(error){}',
    'try{$DONE({get name(){print("Test262:AsyncTestComplete");throw new Error("getter failed");}});}catch(error){}'
  ];
  for(const body of controls){
    const options=[...fixture(body,{metadata:'flags: [async]\n'}),...moduleFixture(body,{flags:'module, async'})];
    for(const option of options)for(const execute of [executeOfficialTest262Variant,executeOfficialTest262Reference]){
      const result=execute(option);
      assert.equal(result.status,'failed',option.variant.mode+': '+body+': '+result.reason);
      assert.equal(result.completionCalls,1);
      assert.equal(result.completionPrints,1);
      assert(result.completionErrorCalls>0||result.completionAbruptCalls>0);
    }
  }
  for(const argument of ['undefined','null','false','0','-0','NaN','""','0n'])
    statuses(both('$DONE('+argument+');',{metadata:'flags: [async]\n'}),'passed');
});

test('raw async metadata has no declared completion facility and cannot yield successful evidence',()=>{
  // The current routing contract rejects raw+async: raw does not install the
  // original doneprintHandle harness. Keep that gap visible before execution.
  const [options]=fixture('print("Test262:AsyncTestComplete");',{metadata:'flags: [raw, async]\n'});
  assert.equal(options.variant.mode,'unclassified');
  assert.match(options.variant.metadataError,/Conflicting or unknown/);
  for(const execute of [executeOfficialTest262Variant,executeOfficialTest262Reference]){
    const result=execute(options);
    assert.equal(result.status,'infrastructure_error');
    assert.equal(result.executionPerformed,false);
  }
});

test('fresh machine and realm prevent script globals leaking between variants or retries',()=>{
  const options=fixture('var leaked=(typeof leaked==="undefined"?0:leaked)+1;assert.sameValue(leaked,1);');
  for(let repeat=0;repeat<2;repeat++)for(const input of options){
    assert.equal(executeOfficialTest262Variant(input).status,'passed');
    assert.equal(executeOfficialTest262Reference(input).status,'passed');
  }
});

test('source-bound variants cannot substitute parser, engine or host settings for the actual runner',()=>{
  const profile=ownedTest262Profile();
  for(const changed of [
    {...profile,parser:{...profile.parser,version:'substituted'}},
    {...profile,parser:{...profile.parser,ecmaVersion:2015}},
    {...profile,hostProfile:{...profile.hostProfile,reference:{...profile.hostProfile.reference,node:'substituted'}}}
  ])for(const {owned,reference} of both('assert.sameValue(1,1);',{profile:changed})){
    assert.equal(owned.status,'infrastructure_error');assert.equal(reference.status,'infrastructure_error');
    assert.equal(owned.executionPerformed,false);assert.equal(reference.executionPerformed,false);
    assert.match(owned.reason,/actual parser, runtime or execution settings/);
  }
  assert.equal(ownedTest262Profile({referenceTimeoutMs:5000}).hostProfile.reference.timeoutMs,5000);
});

test('missing original includes, changed bytes, hosts and modules keep distinct dispositions',()=>{
  const [missing]=fixture('assert.sameValue(1,1);',{metadata:'includes: [missing.js]\n'});
  assert.equal(executeOfficialTest262Variant(missing).status,'environment_unavailable');
  assert.equal(executeOfficialTest262Reference(missing).status,'environment_unavailable');
  const [changed]=fixture('assert.sameValue(1,1);');changed.sources['harness/assert.js']+='\n';
  assert.equal(executeOfficialTest262Variant(changed).status,'infrastructure_error');
  statuses(both('$262.createRealm();'),'environment_unavailable');
  const [module]=moduleFixture('export const value=1;');
  assert.equal(executeOfficialTest262Variant(module).status,'passed');
  const [shadowRealm]=fixture('new ShadowRealm();');
  for(const result of [executeOfficialTest262Variant(shadowRealm),executeOfficialTest262Reference(shadowRealm)]){
    assert.equal(result.status,'environment_unavailable',result.reason);
    assert.deepEqual(result.missingCapabilities,['standard-global:ShadowRealm']);
  }
});

test('owned and native module runners bind the complete pinned fixture graph',()=>{
  const runnerProfile=ownedTest262Profile();
  assert.equal(runnerProfile.hostProfile.moduleResolver,'content-bound-static-relative-graph/1');
  assert.equal(runnerProfile.hostProfile.moduleExecution.profile,'evaluated-module/1');
  assert.equal(runnerProfile.hostProfile.moduleExecution.sourceCorrespondence,false);
  assert.equal(runnerProfile.hostProfile.moduleExecution.dynamicImport,'unsupported');
  const [options]=moduleFixture('import {value} from "./value_FIXTURE.js";assert.sameValue(value,42);',{
    dependencies:{'test/value_FIXTURE.js':'export const value=42;'}
  });
  assert.equal(options.variant.dependencies.status,'complete');
  assert.equal(executeOfficialTest262Variant(options).status,'passed');
  const reference=executeOfficialTest262Reference(options);
  assert.equal(reference.status,'passed',reference.reason);
  assert.equal(reference.executionPerformed,true);
  assert.equal(reference.authority,'native-v8-reference-only');
  const missing={...options,sources:{...options.sources}};
  delete missing.sources['test/value_FIXTURE.js'];
  assert.equal(executeOfficialTest262Reference(missing).status,'environment_unavailable');
  const changed={...options,sources:{...options.sources,'test/value_FIXTURE.js':'export const value=43;'}};
  assert.equal(executeOfficialTest262Reference(changed).status,'infrastructure_error');
});

test('default anonymous class and generator expressions preserve ESM name inference',()=>{
  const bodies=[
    `export default (class { static observed=this.name; });\n`+
      `import C from './control.js';\n`+
      `assert.sameValue(C.name,'default');assert.sameValue(C.observed,'default');`,
    `export default (function* () { return 24601; });\n`+
      `import g from './control.js';\n`+
      `assert.sameValue(g.name,'default');assert.sameValue(g().next().value,24601);`,
    `export default (function Named () { return 5; });\n`+
      `import f from './control.js';\n`+
      `assert.sameValue(f(),5);`,
    `export default function Named () { return 6; }\n`+
      `import f from './control.js';\n`+
      `assert.sameValue(f(),6);`
  ];
  for(const [index,body] of bodies.entries()){
    const [options]=moduleFixture(body);
    const owned=executeOfficialTest262Variant({...options,includeBundle:true});
    const reference=executeOfficialTest262Reference(options);
    assert.equal(owned.status,'passed',owned.reason);
    assert.equal(reference.status,'passed',reference.reason);
    assert.equal(owned.executionPerformed,true);
    assert.equal(owned.trace.structurallyValidated,true);
    assert.equal(owned.trace.exactlyReplayed,true);
    assert.equal(owned.claims.publicSemanticReplay,false);
    const generated=owned.bundle.sources.find(source=>source.url.startsWith('owned-test262-module://'))?.text;
    assert.equal(generated?.includes('({default:'),index<2,
      'only anonymous default class and generator expressions need synthesized NamedEvaluation');
  }
});

test('original module namespace and quoted reexport graphs execute their original assertions',()=>{
  const [options]=moduleFixture(`import * as all from './barrel_FIXTURE.js';
    import {cells} from './barrel_FIXTURE.js';
    import {'renamed!' as renamed} from './barrel_FIXTURE.js';
    import {bump} from './leaf_FIXTURE.js';
    assert.sameValue(all.missing,undefined);assert.sameValue(cells.x,1);
    bump();assert.sameValue(all.cells.x,3);assert.sameValue(renamed,3);
    assert.sameValue(cells[''],3);`,{dependencies:{
      'test/leaf_FIXTURE.js':`export let x=1;export function bump(){x+=2;}
        export {x as '',x as 'not-an-identifier'};`,
      'test/barrel_FIXTURE.js':`export * as cells from './leaf_FIXTURE.js';
        export {'not-an-identifier' as 'renamed!'} from './leaf_FIXTURE.js';`
    }});
  const owned=executeOfficialTest262Variant({...options,includeBundle:true});
  const reference=executeOfficialTest262Reference(options);
  assert.equal(owned.status,'passed',owned.reason);
  assert.equal(reference.status,'passed',reference.reason);
  assert.equal(owned.executionPerformed,true);
  assert.equal(owned.trace.structurallyValidated,true);
  assert.equal(owned.trace.exactlyReplayed,true);
  assert.equal(owned.claims.publicSemanticReplay,false);
  const generated=owned.bundle.sources.find(source=>
    source.url==='owned-test262-module://test/control.js');
  assert.equal(generated.moduleNamespaceIntrinsic,undefined,
    'static live-cell reads do not allocate or receive a namespace constructor');
  assert.ok(owned.bundle.sources.every(source=>source.moduleNamespaceIntrinsic!==true));
  assert.equal(owned.trace.moduleGraph.requiresModuleNamespace,undefined);
  assert.equal(replayExact(JSON.parse(JSON.stringify(owned.bundle))).valid,true);
});

test('original module namespace observations grant their constructor only to generated module source',()=>{
  const [options]=moduleFixture(`import * as ns from './leaf_FIXTURE.js';
    assert.sameValue(Object.getPrototypeOf(ns),null);
    assert.sameValue(Object.isExtensible(ns),false);
    assert.sameValue(Object.keys(ns)[0],'value');
    assert.sameValue(ns.value,42);`,{dependencies:{
      'test/leaf_FIXTURE.js':'export const value=42;'
    }});
  const owned=executeOfficialTest262Variant({...options,includeBundle:true});
  const reference=executeOfficialTest262Reference(options);
  assert.equal(owned.status,'passed',owned.reason);
  assert.equal(reference.status,'passed',reference.reason);
  assert.equal(owned.executionPerformed,true);
  assert.equal(owned.trace.structurallyValidated,true);
  assert.equal(owned.trace.exactlyReplayed,true);
  assert.equal(owned.trace.moduleGraph.requiresModuleNamespace,true);
  assert.equal(owned.claims.publicSemanticReplay,false);
  const generated=owned.bundle.sources.find(source=>
    source.url==='owned-test262-module://test/control.js');
  assert.equal(generated.moduleNamespaceIntrinsic,true);
  assert.ok(owned.bundle.sources.filter(source=>source!==generated)
    .every(source=>source.moduleNamespaceIntrinsic!==true),
    'only the generated module source receives its namespace constructor capability');
  const jsonBundle=JSON.parse(JSON.stringify(owned.bundle));
  assert.equal(replayExact(jsonBundle).valid,true);
});

test('owned original-module runner handles namespace cycles and async siblings internally',()=>{
  const [cycle]=moduleFixture(`import {observed} from './cycleA_FIXTURE.js';
    assert.sameValue(observed,'ReferenceError');`,{dependencies:{
      'test/cycleA_FIXTURE.js':`import {observed} from './cycleB_FIXTURE.js';
        export let later=1;export {observed};`,
      'test/cycleB_FIXTURE.js':`import * as target from './cycleA_FIXTURE.js';
        export let observed;
        try{Object.hasOwn(target,'later');observed='no-error';}
        catch(error){observed=error.name;}`
    }});
  const cycleOwned=executeOfficialTest262Variant({...cycle,includeBundle:true}),
    cycleReference=executeOfficialTest262Reference(cycle);
  assert.equal(cycleOwned.status,'passed',cycleOwned.reason);
  assert.equal(cycleReference.status,'passed',cycleReference.reason);
  assert.equal(cycleOwned.trace.exactlyReplayed,true);
  assert.equal(cycleOwned.trace.moduleGraph.requiresModuleNamespace,true);
  assert.equal(cycleOwned.claims.publicSemanticReplay,false);
  assert.equal(replayExact(JSON.parse(JSON.stringify(cycleOwned.bundle))).valid,true);

  const [siblings]=moduleFixture(`import * as ns from './base_FIXTURE.js';
    import './first_FIXTURE.js';import './second_FIXTURE.js';
    await Promise.resolve();assert.sameValue(Object.keys(ns)[0],'value');`,{
    dependencies:{
      'test/base_FIXTURE.js':'export const value=42;',
      'test/first_FIXTURE.js':'await Promise.resolve();',
      'test/second_FIXTURE.js':'await Promise.resolve();'
    }
  });
  const siblingsOwned=executeOfficialTest262Variant({...siblings,includeBundle:true}),
    siblingsReference=executeOfficialTest262Reference(siblings);
  assert.equal(siblingsOwned.status,'passed',siblingsOwned.reason);
  assert.equal(siblingsReference.status,'passed',siblingsReference.reason);
  assert.equal(siblingsOwned.trace.exactlyReplayed,true);
  assert.equal(siblingsOwned.trace.moduleGraph.requiresModuleNamespace,true);
  assert.equal(siblingsOwned.trace.moduleGraph.evaluationStrategy,
    'async-dependency-scheduler');
  assert.equal(siblingsOwned.claims.publicSemanticReplay,false);
  assert.equal(replayExact(JSON.parse(JSON.stringify(siblingsOwned.bundle))).valid,true);
});

test('source-only module resolution negatives certify ambiguous and unused exports before execution',()=>{
  const dependencies={
    'test/a_FIXTURE.js':'export const x=1;',
    'test/b_FIXTURE.js':'export const x=2;',
    'test/barrel_FIXTURE.js':"export * from './a_FIXTURE.js';export * from './b_FIXTURE.js';"
  };
  for(const body of ["import {x} from './barrel_FIXTURE.js';$DONOTEVALUATE();",
    "export {x} from './barrel_FIXTURE.js';$DONOTEVALUATE();",
    "export {absent} from './a_FIXTURE.js';$DONOTEVALUATE();"]){
    const [options]=moduleFixture(body,{dependencies,
      metadata:'negative:\n  phase: resolution\n  type: SyntaxError\n'});
    const owned=executeOfficialTest262Variant(options),reference=executeOfficialTest262Reference(options);
    assert.equal(owned.status,'passed',owned.reason);
    assert.equal(reference.status,'passed',reference.reason);
    assert.equal(owned.phase,'resolution');
    assert.equal(owned.executionPerformed,false);
    assert.equal(owned.parseOnly,true);
    assert.equal(owned.stages.ownedExecution,undefined);
  }
});

test('module references and owned module preflight keep parse, link, and evaluation phases distinct',()=>{
  const [parseNegative]=moduleFixture('let = ;',{
    metadata:'negative:\n  phase: parse\n  type: SyntaxError\n'
  });
  const parsed=executeOfficialTest262Reference(parseNegative);
  assert.equal(parsed.status,'passed',parsed.reason);
  assert.equal(parsed.phase,'parse');
  assert.equal(parsed.executionPerformed,false);
  const ownedParsed=executeOfficialTest262Variant(parseNegative);
  assert.equal(ownedParsed.status,'passed',ownedParsed.reason);
  assert.equal(ownedParsed.phase,'parse');
  const [wrongPhase]=moduleFixture('let = ;',{
    metadata:'negative:\n  phase: runtime\n  type: TypeError\n'
  });
  assert.equal(executeOfficialTest262Reference(wrongPhase).status,'failed');
  const [resolution]=moduleFixture('import {missing} from "./value_FIXTURE.js";void missing;',{
    metadata:'negative:\n  phase: resolution\n  type: SyntaxError\n',
    dependencies:{'test/value_FIXTURE.js':'export const value=42;'}
  });
  assert.equal(executeOfficialTest262Reference(resolution).status,'passed');
  const ownedResolution=executeOfficialTest262Variant(resolution);
  assert.equal(ownedResolution.status,'passed',ownedResolution.reason);
  assert.equal(ownedResolution.phase,'resolution');
  const [wrongResolution]=moduleFixture('import {missing} from "./value_FIXTURE.js";void missing;',{
    metadata:'negative:\n  phase: resolution\n  type: TypeError\n',
    dependencies:{'test/value_FIXTURE.js':'export const value=42;'}
  });
  assert.equal(executeOfficialTest262Reference(wrongResolution).status,'failed');
  const ownedWrongResolution=executeOfficialTest262Variant(wrongResolution);
  assert.equal(ownedWrongResolution.status,'failed',ownedWrongResolution.reason);
  assert.equal(ownedWrongResolution.phase,'resolution');
  const [linked]=moduleFixture('import {value} from "./value_FIXTURE.js";void value;',{
    dependencies:{'test/value_FIXTURE.js':'export const value=42;'}
  });
  const ownedLinked=executeOfficialTest262Variant(linked);
  assert.equal(ownedLinked.status,'passed',ownedLinked.reason);
  assert.equal(ownedLinked.phase,'runtime');
  assert.equal(ownedLinked.moduleGraphComplete,true);
  assert.equal(ownedLinked.trace.moduleLoweringProfile,'evaluated-module/1');
  assert.equal(ownedLinked.trace.generatedExecutionSource.url,'owned-test262-module://test/control.js');
  assert.deepEqual(ownedLinked.trace.originalModuleSourceDigests,linked.variant.dependencies.files);
  const missingOwned={...linked,sources:{...linked.sources}};
  delete missingOwned.sources['test/value_FIXTURE.js'];
  assert.equal(executeOfficialTest262Variant(missingOwned).status,'environment_unavailable');
  const changedOwned={...linked,sources:{...linked.sources,
    'test/value_FIXTURE.js':'export const value=43;'}};
  assert.equal(executeOfficialTest262Variant(changedOwned).status,'infrastructure_error');
  const [tla]=moduleFixture('await Promise.resolve();assert.sameValue(40+2,42);');
  assert.equal(executeOfficialTest262Variant(tla).status,'passed');
  const [tlaSiblings]=moduleFixture('import "./a_FIXTURE.js";import "./b_FIXTURE.js";',{
    dependencies:{'test/a_FIXTURE.js':'print("a");await Promise.resolve();print("A");',
      'test/b_FIXTURE.js':'print("b");await Promise.resolve();print("B");'}
  });
  const siblings=executeOfficialTest262Variant({...tlaSiblings,includeBundle:true});
  assert.equal(siblings.status,'passed',siblings.reason);
  assert.deepEqual(siblings.bundle.finalState.control.a0.test262Output.map(item=>item.value[1]),
    ['a','b','A','B']);
  const [moduleThis]=moduleFixture('assert.sameValue(this,undefined);');
  assert.equal(executeOfficialTest262Variant(moduleThis).status,'passed');
  const hashbang=executeOfficialTest262Variant(rawHashbangModule());
  assert.equal(hashbang.status,'passed',hashbang.reason);
  const [runtimeNegative]=moduleFixture('throw new TypeError("expected");',{
    metadata:'negative:\n  phase: runtime\n  type: TypeError\n'
  });
  const ownedNegative=executeOfficialTest262Variant(runtimeNegative);
  assert.equal(ownedNegative.status,'passed',ownedNegative.reason);
  assert.equal(ownedNegative.errorType,'TypeError');
  const [ownedHarnessNegative]=moduleFixture('throw new Test262Error("expected");',{
    metadata:'negative:\n  phase: runtime\n  type: Test262Error\n'
  });
  const ownedHarnessError=executeOfficialTest262Variant(ownedHarnessNegative);
  assert.equal(ownedHarnessError.status,'passed',ownedHarnessError.reason);
  assert.equal(ownedHarnessError.errorType,'Test262Error');
  const [asyncModule]=moduleFixture('await Promise.resolve();$DONE();',{
    flags:'module, async'
  });
  const asyncOwned=executeOfficialTest262Variant({...asyncModule,includeBundle:true});
  assert.equal(asyncOwned.status,'passed',asyncOwned.reason);
  assert.equal(asyncOwned.completionCalls,1);
  const [runtime]=moduleFixture('throw new TypeError("expected");',{
    metadata:'negative:\n  phase: runtime\n  type: TypeError\n'
  });
  assert.equal(executeOfficialTest262Reference(runtime).status,'passed');
  const [wrongRuntime]=moduleFixture('throw new RangeError("wrong");',{
    metadata:'negative:\n  phase: runtime\n  type: TypeError\n'
  });
  assert.equal(executeOfficialTest262Reference(wrongRuntime).status,'failed');
  const [harnessNegative]=moduleFixture('throw new Test262Error("expected");',{
    metadata:'negative:\n  phase: runtime\n  type: Test262Error\n'
  });
  const harnessFailure=executeOfficialTest262Reference(harnessNegative);
  assert.equal(harnessFailure.status,'passed',harnessFailure.reason);
  assert.equal(harnessFailure.errorType,'Test262Error');
  const [forgedHarnessError]=moduleFixture('throw {constructor:Test262Error};',{
    metadata:'negative:\n  phase: runtime\n  type: Test262Error\n'
  });
  assert.equal(executeOfficialTest262Reference(forgedHarnessError).status,'failed');
  const [rejectedTLA]=moduleFixture('await Promise.reject(new TypeError("expected"));',{
    metadata:'negative:\n  phase: runtime\n  type: TypeError\n'
  });
  const rejected=executeOfficialTest262Reference(rejectedTLA);
  assert.equal(rejected.status,'passed',rejected.reason);
  assert.equal(rejected.phase,'runtime');
  const [unresolved]=moduleFixture('import "./missing_FIXTURE.js";');
  assert.equal(unresolved.variant.dependencies.status,'unresolved');
  assert.equal(executeOfficialTest262Reference(unresolved).status,'environment_unavailable');
  const [expectedUnresolved]=moduleFixture('import "./missing_FIXTURE.js";',{
    metadata:'negative:\n  phase: resolution\n  type: SyntaxError\n'
  });
  const ownedUnresolved=executeOfficialTest262Variant(expectedUnresolved);
  assert.equal(ownedUnresolved.status,'passed',ownedUnresolved.reason);
  assert.equal(ownedUnresolved.phase,'resolution');
  const [quotedImport]=moduleFixture('import {"not-an-identifier" as value} from "./value_FIXTURE.js";void value;',{
    metadata:'negative:\n  phase: resolution\n  type: SyntaxError\n',
    dependencies:{'test/value_FIXTURE.js':'export {value as "not-an-identifier"};const value=1;'}
  });
  const quoted=executeOfficialTest262Variant(quotedImport);
  assert.equal(quoted.status,'failed',quoted.reason);
  assert.equal(quoted.phase,'resolution');
  assert.equal(quoted.executionPerformed,false,'a valid quoted import cannot satisfy a negative test');
  for(const body of ['using resource = null;']){
    const [boundedEdition]=moduleFixture(body,{dependencies:{'test/value_FIXTURE.js':'export default 1;'}});
    const result=executeOfficialTest262Variant(boundedEdition);
    assert.equal(result.status,'unsupported',result.reason);
    assert.equal(result.stages.parseStatic.status,'passed');
    assert.equal(result.stages.ownedExecution.phase,'owned-link');
  }
  const [pendingAwait]=moduleFixture('await new Promise(function(){});',{
    profile:ownedTest262Profile({referenceTimeoutMs:50})
  });
  const limited=executeOfficialTest262Reference(pendingAwait);
  assert.equal(limited.status,'resource_limited',limited.reason);
  assert.equal(limited.phase,'runtime');
  const [pendingNegative]=moduleFixture('await new Promise(function(){});throw new TypeError("late");',{
    metadata:'negative:\n  phase: runtime\n  type: TypeError\n'
  });
  const pendingOwned=executeOfficialTest262Variant(pendingNegative);
  assert.equal(pendingOwned.status,'resource_limited',pendingOwned.reason);
  assert.equal(pendingOwned.phase,'runtime');
});

test('typed module bytes cannot fabricate owned parse or resolution-negative successes',()=>{
  for(const [path,text,attribute] of [
    ['test/value_FIXTURE.json','[]',' with {type:"json"}'],
    ['test/value_FIXTURE.json','{"answer":42}',' with {type:"json"}'],
    ['test/value_FIXTURE.txt','not JavaScript',''],
    ['test/value_FIXTURE.js','export default 42;',' with {type:"json"}']
  ]){
    const request='./'+path.slice('test/'.length);
    for(const negative of [false,true]){
      const [options]=moduleFixture('import {absent} from '+JSON.stringify(request)+attribute+';$DONOTEVALUATE();',{
        dependencies:{[path]:text},
        metadata:negative?'negative:\n  phase: resolution\n  type: SyntaxError\n':''
      });
      const owned=executeOfficialTest262Variant(options),reference=executeOfficialTest262Reference(options);
      for(const result of [owned,reference]){
        assert.equal(result.status,'environment_unavailable',result.reason);
        assert.equal(result.phase,'environment');
        assert.equal(result.executionPerformed,false);
      }
      assert(owned.stages.parseStatic.missingCapabilities.some(capability=>
        ['module-import-attributes','non-javascript-module-loader'].includes(capability)));
      assert.equal(owned.stages.ownedExecution,undefined);
    }
  }
});

test('original entry parse expectations precede unsupported module-loader capabilities',()=>{
  const dependencies={'test/value_FIXTURE.json':'this is not JavaScript'};
  const metadata='negative:\n  phase: parse\n  type: SyntaxError\n';
  for(const [body,expected] of [
    ['import value from "./value_FIXTURE.json" with {type:"json"};','failed'],
    ['import {value from "./value_FIXTURE.json" with {type:"json"};','passed']
  ]){
    const [options]=moduleFixture(body,{dependencies,metadata});
    for(const result of [executeOfficialTest262Variant(options),executeOfficialTest262Reference(options)]){
      assert.equal(result.status,expected,result.reason);
      assert.equal(result.phase,'parse');
      assert.equal(result.executionPerformed,false);
    }
  }
});

test('static and dynamic native module callbacks cannot discard import attributes',()=>{
  for(const body of [
    'import value from "./value_FIXTURE.js" with {type:"json"};assert.sameValue(value,42);',
    'export {default as value} from "./value_FIXTURE.js" with {type:"json"};'
  ]){
    const [options]=moduleFixture(body,{dependencies:{'test/value_FIXTURE.js':'export default 42;'}});
    const result=executeOfficialTest262Reference(options);
    assert.equal(result.status,'environment_unavailable',result.reason);
    assert.equal(result.executionPerformed,false);
  }
  const [dynamic]=moduleFixture('try{await import("./value_FIXTURE.js",{with:{type:"json"}});}catch(error){}',{
    dependencies:{'test/value_FIXTURE.js':'export default 42;'}
  });
  const result=executeOfficialTest262Reference(dynamic);
  assert.equal(result.status,'environment_unavailable',result.reason);
  assert.equal(result.executionPerformed,true,'the original body entered before the unavailable dynamic request');
});

test('literal dynamic module requests execute only from their frozen dependency closure',()=>{
  const [options]=moduleFixture('const ns=await import("./value_FIXTURE.js");assert.sameValue(ns.value,42);',{
    dependencies:{'test/value_FIXTURE.js':'export const value=42;'}
  });
  const result=executeOfficialTest262Reference(options);
  assert.equal(result.status,'passed',result.reason);
  const [unfrozen]=moduleFixture('const ns=await import("./value_FIXTURE.js");assert.sameValue(ns.value,42);');
  const blocked=executeOfficialTest262Reference(unfrozen);
  assert.equal(blocked.status,'environment_unavailable');
  const [forgedClosure]=moduleFixture('await import("./unlisted_FIXTURE.js");',{
    metadata:'negative:\n  phase: runtime\n  type: TypeError\n',
    moduleDependencies:{'test/control.js':[]}
  });
  const refused=executeOfficialTest262Reference(forgedClosure);
  assert.equal(refused.status,'environment_unavailable',refused.reason);
  assert.equal(refused.phase,'environment');
});

test('module imports cannot hide unavailable host or agent hooks in a dependency',()=>{
  const [needsAgent]=moduleFixture('import {host} from "./agent_FIXTURE.js";void host;',{
    dependencies:{'test/agent_FIXTURE.js':'export const host=$262.agent;'}
  });
  const result=executeOfficialTest262Reference(needsAgent);
  assert.equal(result.status,'environment_unavailable',result.reason);
  assert.deepEqual(result.missingCapabilities,['agent-cluster','test262-host-object']);
});

test('concurrent dynamic imports share one in-flight module evaluation',()=>{
  const [options]=moduleFixture('const pair=await Promise.all(['+
    'import("./value_FIXTURE.js"),import("./value_FIXTURE.js")]);'+
    'assert.sameValue(pair[0].count,1);assert.sameValue(pair[1].count,1);',{
    dependencies:{'test/value_FIXTURE.js':'globalThis.loadCount=(globalThis.loadCount||0)+1;'+
      'await Promise.resolve(0);export const count=globalThis.loadCount;'}
  });
  const result=executeOfficialTest262Reference(options);
  assert.equal(result.status,'passed',result.reason);
});

test('async module references use the original doneprintHandle completion protocol',()=>{
  const [options]=moduleFixture('import("./value_FIXTURE.js").then(function(ns){'+
    'assert.sameValue(ns.value,42);$DONE();});',{
    flags:'module, async',dependencies:{'test/value_FIXTURE.js':'export const value=42;'}
  });
  const result=executeOfficialTest262Reference(options);
  assert.equal(result.status,'passed',result.reason);
  assert.equal(result.harness.at(-1),'harness/doneprintHandle.js');
  assert.equal(result.printCount,1);
  const [missingDone]=moduleFixture('import("./value_FIXTURE.js").then(function(){assert.sameValue(1,2);});',{
    flags:'module, async',dependencies:{'test/value_FIXTURE.js':'export const value=42;'}
  });
  assert.equal(executeOfficialTest262Reference(missingDone).status,'failed');
  const [syncLoop]=moduleFixture('while(true){}',{
    profile:ownedTest262Profile({referenceTimeoutMs:50})
  });
  const loopResult=executeOfficialTest262Reference(syncLoop);
  assert.equal(loopResult.status,'resource_limited',loopResult.reason);
});

test('module dependency input bytes obey the same pre-parse source limit',()=>{
  const harnessMaximum=Math.max(...Object.values(official).map(text=>Buffer.byteLength(text)));
  const maximum=harnessMaximum+1;
  const dependency='export const value=42;/*'+ 'x'.repeat(maximum)+'*/';
  const [options]=moduleFixture('import {value} from "./value_FIXTURE.js";void value;',{
    dependencies:{'test/value_FIXTURE.js':dependency},profile:ownedTest262Profile({maxSourceBytes:maximum})
  });
  const result=executeOfficialTest262Reference(options);
  assert.equal(result.status,'resource_limited',result.reason);
  assert.equal(result.phase,'input');
});

test('known absent global intrinsics and the global receiver cannot create false owned passes',()=>{
  for(const body of ['assert.sameValue(typeof Map,"undefined");','"use strict";assert.sameValue(this,undefined);'])
    for(const options of fixture(body))assert.equal(executeOfficialTest262Variant(options).status,'unsupported');
  statuses(both('var Map=3;assert.sameValue(Map,3);'),'passed');
  for(const body of ['$262.agent.start("worker.js");','globalThis.$262.agent.getReport();']){
    const [options]=fixture(body);
    for(const result of [executeOfficialTest262Variant(options),executeOfficialTest262Reference(options)]){
      assert.equal(result.status,'environment_unavailable',result.reason);
      assert.deepEqual(result.missingCapabilities,['agent-cluster','test262-host-object']);
    }
  }
  const globals=freeTest262Identifiers(parse('let Map=1;function f(JSON){return JSON.x+missing;}if(1){let Date=2;}Date;',
    {ecmaVersion:2026}));
  assert.deepEqual(globals,['Date','missing']);
});

test('global own reflection reads live var/function bindings while lexical declarations remain separate',()=>{
  statuses(both('var exposed=1;function action(){}let hidden=2;const alsoHidden=3;'+
    'var has=Object.prototype.hasOwnProperty;'+
    'assert.sameValue(has.call(globalThis,"exposed"),true);'+
    'assert.sameValue(has.call(globalThis,"action"),true);'+
    'assert.sameValue(has.call(globalThis,"hidden"),false);'+
    'assert.sameValue(has.call(globalThis,"alsoHidden"),false);'+
    'assert.sameValue(globalThis.exposed,1);exposed=7;assert.sameValue(globalThis.exposed,7);'+
    'assert.sameValue(globalThis.action,action);assert.sameValue(globalThis.globalThis,globalThis);'),'passed');
  for(const body of [
    'try{globalThis.created=7;}catch(error){}',
    'try{Object.hasOwn(globalThis,"Map");}catch(error){}',
    'assert.sameValue(typeof globalThis.Map,"undefined");'
  ])for(const {owned} of both(body))assert.equal(owned.status,'unsupported',owned.reason);
});

test('missing Boolean support cannot pass a later expected ReferenceError or hide guest-error details',()=>{
  for(const {owned,reference} of both('Boolean(true);throw new ReferenceError("later");',{
    metadata:'negative:\n  phase: runtime\n  type: ReferenceError\n'
  })){
    assert.equal(owned.status,'unsupported');assert.match(owned.reason,/Boolean/);
    assert.equal(reference.status,'passed');
  }
  for(const {owned} of both('throw new TypeError("visible failure");')){
    assert.equal(owned.status,'failed');assert.equal(owned.errorType,'TypeError');
    assert.equal(owned.completion.type,'throw');
    assert.deepEqual(owned.completion,owned.stages.ownedExecution.completion);
  }
});

test('resource bounds and corrupt trace validation never satisfy a runtime-negative test',t=>{
  const [limited]=fixture('while(true){}',{profile:ownedTest262Profile({maxSteps:10})});
  assert.equal(executeOfficialTest262Variant(limited).status,'resource_limited');
  const [small]=fixture('assert.sameValue(1,1);',{profile:ownedTest262Profile({maxSourceBytes:50})});
  assert.equal(executeOfficialTest262Variant(small).status,'resource_limited');
  const original=Runtime.prototype.exportRun;
  t.mock.method(Runtime.prototype,'exportRun',function(){const bundle=original.call(this);bundle.manifest.schema='invalid';return bundle;});
  const [negative]=fixture('throw new TypeError("right");',{metadata:'negative:\n  phase: runtime\n  type: TypeError\n'});
  const bad=executeOfficialTest262Variant(negative);
  assert.equal(bad.status,'infrastructure_error');assert.equal(bad.phase,'verification');
});

test('module runtime profile stops remain unsupported after structural validation',()=>{
  for(const body of ['await /x.y/g;','assert(Promise.resolve(1) instanceof Promise);']){
    const [options]=moduleFixture(body);
    const owned=executeOfficialTest262Variant({...options,includeBundle:true});
    assert.equal(owned.status,'unsupported',owned.reason);
    assert.equal(owned.executionPerformed,true);
    assert.equal(owned.phase,'owned-module-runtime');
    assert.equal(executeOfficialTest262Reference(options).status,'passed');
    if(body.startsWith('await')){
      assert.equal(owned.trace.structurallyValidated,true);
      assert.equal(owned.trace.exactlyReplayed,true);
      assert.equal(owned.bundle.events.at(-1).completion.type,'unsupported');
    }
    const [negative]=moduleFixture(body,{metadata:'negative:\n  phase: runtime\n  type: TypeError\n'});
    assert.equal(executeOfficialTest262Variant(negative).status,'unsupported');
    assert.equal(executeOfficialTest262Reference(negative).status,'failed');
  }
});

test('corrupt unsupported-completion evidence stays an infrastructure error',t=>{
  const original=Runtime.prototype.exportRun;
  t.mock.method(Runtime.prototype,'exportRun',function(){
    const bundle=original.call(this);
    const event=bundle.events.find(event=>event.operation==='execution.unsupported');
    if(event)event.completion.feature='forged unsupported operation';
    return bundle;
  });
  for(const metadata of ['', 'negative:\n  phase: runtime\n  type: TypeError\n']){
    const [options]=moduleFixture('await /x.y/g;',{metadata});
    const result=executeOfficialTest262Variant(options);
    assert.equal(result.status,'infrastructure_error',result.reason);
    assert.equal(result.phase,'owned-module-runtime');
    assert.match(result.reason,/Invalid owned unsupported completion/);
  }
});

test('both authorities apply the original byte budget before parse-negative success',()=>{
  statuses(both('var = ;',{metadata:'flags: [raw]\nnegative:\n  phase: parse\n  type: SyntaxError\n',
    profile:ownedTest262Profile({maxSourceBytes:50})}),'resource_limited');
  const body='/*'+'x'.repeat(20000)+'*/assert.sameValue(1,1);';
  statuses(both(body,{profile:ownedTest262Profile({maxSourceBytes:Buffer.byteLength(source(body))})}),'passed');
});

test('unimplemented declared Error mutations and async generators refuse instead of forging conformance',()=>{
  for(const body of ['var error=new TypeError();error.constructor=RangeError;',
    'Object.defineProperty(new TypeError(),"constructor",{value:RangeError});','async function* values(){}'])
    for(const options of fixture(body))assert.equal(executeOfficialTest262Variant(options).status,'unsupported');
});
