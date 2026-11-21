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
  for(const options of fixture('function $DONE(){print("Test262:AsyncTestComplete");}$DONE();',settings))
    assert.equal(executeOfficialTest262Variant(options).status,'resource_limited');
});

test('fresh machine and realm prevent script globals leaking between variants or retries',()=>{
  const options=fixture('var leaked=(typeof leaked==="undefined"?0:leaked)+1;assert.sameValue(leaked,1);');
  for(let repeat=0;repeat<2;repeat++)for(const input of options){
    assert.equal(executeOfficialTest262Variant(input).status,'passed');
    assert.equal(executeOfficialTest262Reference(input).status,'passed');
  }
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
  assert.equal(runnerProfile.hostProfile.moduleResolver,'frozen-static-relative-graph/1');
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
  for(const body of [
    'import value from "./value_FIXTURE.js" with {type:"json"};void value;',
    'using resource = null;'
  ]){
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
