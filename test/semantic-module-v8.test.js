import test from 'node:test';
import assert from 'node:assert/strict';
import {MODULE_REGION_PROFILE,verifyRegionModuleTrainingCase,recheckModuleRegionEvidence} from '../src/semantic/module-v8.js';
import {recheckRegionEvidence} from '../src/semantic/compiler-v8.js';
import {LANGUAGE_EXPANSION_INTERACTIONS} from '../fixtures/language-expansion/benchmark.js';
import {executeEvaluatedModules,linkEvaluatedModules} from '../src/evaluated-modules.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {moduleQualificationFixtures} from '../fixtures/semantic-regions/qualification.js';

const siblingSchedulerFixture={id:'parallel-tla-boundary',family:'parallel-tla-boundary',modules:{
  'state.js':'export let order="";export function add(value){order+=value;}',
  'a.js':'import {add} from "./state.js";add("a");await 0;add("A");',
  'b.js':'import {add} from "./state.js";add("b");await 0;add("B");',
  'main.js':'import "./a.js";import "./b.js";import {order} from "./state.js";export function run(){return order;}'
},entryModule:'main.js',exportName:'run',fixture:{calls:[]}};

test('native ESM independently agrees with owned live cells, a synchronous cycle and acyclic top-level await',async()=>{
  for(const fixture of LANGUAGE_EXPANSION_INTERACTIONS.filter(row=>row.modules)){
    const result=await verifyRegionModuleTrainingCase(fixture);
    assert.ok(result.exported,result.reason);assert.equal(result.moduleCorrespondence,'passed');
    assert.equal(result.exported.public.schema,'semantic-execution/8');
    assert.equal(result.exported.sidecar.sourceArtifact.sidecar.referenceStatus,'agreed');
    const check=await recheckRegionEvidence(result.exported);
    assert.equal(check.moduleReference.status,'passed');assert.equal(check.native.admitted,false);
    const first=result.exported.contexts[0];
    assert.equal(JSON.stringify(first).includes('moduleEvidence'),false);
    assert.equal(JSON.stringify(first).includes('native-v8-module-execution'),false);
  }
});

test('ordered exports preserve module-cell state and input/returned aliases in one episode',async()=>{
  const object={n:0};
  const result=await verifyRegionModuleTrainingCase({id:'module-shared',family:'module-shared',
    modules:{'main.js':'export let n=0;export function add(x){n+=x;return n;}export function read(){return n;}'},
    entryModule:'main.js',calls:[{exportName:'add',args:[3]},{exportName:'add',args:[4]},{exportName:'read',args:[]}],fixture:{calls:[]}});
  assert.ok(result.exported,result.reason);assert.equal(result.moduleCorrespondence,'passed');
  const aliased=await verifyRegionModuleTrainingCase({id:'module-alias',family:'module-alias',
    modules:{'main.js':'export function run(a,b){a.n++;return [a,b];}'},entryModule:'main.js',args:[object,object],fixture:{calls:[]}});
  assert.ok(aliased.exported,aliased.reason);assert.equal(aliased.moduleCorrespondence,'passed');
  assert.equal(object.n,0,'reference and owned execution import data rather than mutate caller state');
});

test('destructured live module cells pass original-source/public checks and fresh module rechecking',async()=>{
  const fixture=moduleQualificationFixtures().find(row=>row.id==='module-destructured-live-cells');
  const result=await verifyRegionModuleTrainingCase(fixture);
  assert.ok(result.exported,result.reason);
  assert.equal(result.moduleReference,'passed');
  assert.equal(result.moduleCorrespondence,'passed');
  const evidence=result.exported.sidecar.sourceArtifact.sidecar.sourceProvenance.upstream.moduleEvidence;
  assert.deepEqual(evidence.request.modules,fixture.modules);
  const check=await recheckRegionEvidence(result.exported);
  assert.equal(check.moduleReference.status,'passed');
  assert.equal(check.native.admitted,false,'independent consumer admission is a separate gate');
});

test('source-owned namespace reflection observes sorted keys and live export cells',async()=>{
  const fixture={id:'module-namespace-live-cell-observation',family:'module-namespace-live-cell-observation',
    entryModule:'main.js',exportName:'run',fixture:{calls:[]},modules:{
      'leaf.js':'export let value=2;export function update(next){value=next;}',
      'main.js':`import * as ns from './leaf.js';import {update} from './leaf.js';
        export function run(){
          const keys=Reflect.ownKeys(ns);
          const descriptor=Object.getOwnPropertyDescriptor(ns,'value');
          const before=ns.value;update(9);const after=ns.value;
          return {keys,hasValue:Object.hasOwn(ns,'value'),prototypeIsNull:Object.getPrototypeOf(ns)===null,
            extensible:Object.isExtensible(ns),descriptor:{enumerable:descriptor.enumerable,
              configurable:descriptor.configurable,getter:typeof descriptor.get==='function'},before,after};
        }`
    }};
  const linked=linkEvaluatedModules({modules:fixture.modules,entryModule:'main.js',exportName:'run'});
  assert.equal(linked.metadata.requiresModuleNamespace,true);
  const result=await verifyRegionModuleTrainingCase(fixture);
  assert.ok(result.exported,result.reason);
  assert.equal(result.moduleReference,'passed');
  assert.equal(result.moduleCorrespondence,'passed');
  const fresh=await recheckRegionEvidence(result.exported);
  assert.equal(fresh.moduleReference.status,'passed');
  const outcome=result.exported.sidecar.sourceArtifact.sidecar.reference.outcome;
  assert.equal(outcome.kind,'return');
  assert.deepEqual(outcome.graph.roots[0],['ref',outcome.graph.roots[0][1]]);
});

test('direct and nested namespace escapes remain outside public module result projection',async()=>{
  for(const expression of ['ns','{nested:ns}']){
    const result=await verifyRegionModuleTrainingCase({id:'namespace-escape-'+expression.length,
      family:'namespace-escape',entryModule:'main.js',exportName:'run',fixture:{calls:[]},modules:{
        'leaf.js':'export let value=2;',
        'main.js':`import * as ns from './leaf.js';export function run(){return ${expression};}`
      }});
    assert.equal(result.exported,undefined);
    assert.notEqual(result.status,'passed');
    assert.equal(result.moduleReference,'passed');
  }
});

test('static namespace re-export reads keep live-cell public projection without admitting namespace escape',async()=>{
  const fixture=moduleQualificationFixtures().find(row=>row.id==='module-namespace-shadow-live'),
    request={modules:fixture.modules,entryModule:fixture.moduleEntry,exportName:fixture.exportName,args:fixture.args},
    linked=linkEvaluatedModules(request),owned=await executeEvaluatedModules(request);
  assert.equal(linked.metadata.requiresModuleNamespace,undefined);
  assert.equal(linked.metadata.instantiationAndEvaluation.some(row=>row.kind==='namespace-object'),false);
  assert.deepEqual(owned.result,[2,5,8,undefined]);
  const result=await verifyRegionModuleTrainingCase(fixture);
  assert.ok(result.exported,result.reason);
  assert.equal(result.moduleReference,'passed');
  assert.equal(result.moduleCorrespondence,'passed');
  const fresh=await recheckRegionEvidence(result.exported);
  assert.equal(fresh.moduleReference.status,'passed');
  assert.equal(fresh.native.admitted,false,'native admission remains a separate gate');

  // A syntactic imported spelling is not an escape for either form of import.
  for(const specifier of ['{cells}','{cells as space}']){
    const local=specifier==='{cells}'?'cells':'space',modules={
      'leaf.js':'export let n=2;',
      'barrel.js':"export * as cells from './leaf.js';",
      'main.js':`import ${specifier} from './barrel.js';export function run(){return ${local}.n;}`
    };
    const candidate=linkEvaluatedModules({modules,entryModule:'main.js',exportName:'run'});
    assert.equal(candidate.metadata.requiresModuleNamespace,undefined,specifier);
  }

  const escape={id:'namespace-value-escape',family:'namespace-value-escape',entryModule:'main.js',exportName:'run',
    modules:{'leaf.js':'export let n=2;',
      'main.js':"import * as ns from './leaf.js';export function run(){return ns;}"}},
    escaped=linkEvaluatedModules(escape);
  assert.equal(escaped.metadata.requiresModuleNamespace,true);
  const refused=await verifyRegionModuleTrainingCase(escape);
  assert.equal(refused.exported,undefined);
  assert.notEqual(refused.status,'passed');
  assert.equal(refused.moduleReference,'passed');
});

test('owned module declarations do not bypass public class and generator observation boundaries',async()=>{
  for(const [source,reason] of [
    ['export class C{static observed=this.name;}export function run(){return C.observed;}',/class\/private state/],
    ['export function* values(){yield 7;}export function run(){return values.name;}',/constructor\/prototype descriptors/]
  ]){
    const result=await verifyRegionModuleTrainingCase({id:'declaration-boundary',family:'declaration-boundary',
      modules:{'main.js':source},entryModule:'main.js',exportName:'run',fixture:{calls:[]}});
    assert.equal(result.moduleReference,'passed');
    assert.equal(result.status,'projection_refused');
    assert.equal(result.phase,'projection');
    assert.equal(result.exported,undefined);
    assert.match(result.reason,reason);
  }
});

test('erased TypeScript and runtime-emitting enum declarations are separately source-qualified',async()=>{
  const cases=[['erased','type Point={x:number};export function run(p:Point):number{return p.x+1;}',[{x:4}]],
    ['enum','export function run(x:number):number{enum Mode{First=2,Second}return Mode.Second+x;}',[5]]];
  for(const [id,source,args] of cases){
    const result=await verifyRegionModuleTrainingCase({id:'ts-'+id,family:'ts-'+id,modules:{'main.ts':source},
      entryModule:'main.ts',args,fixture:{calls:[]}});
    assert.ok(result.exported,result.reason);
    const proof=result.exported.sidecar.sourceArtifact.sidecar.sourceProvenance.upstream.moduleEvidence;
    assert.match(proof.metadata.modules[0].transpiler,/typescript\/5\.9\.3/);
    assert.equal(proof.metadata.modules[0].source,source);
    assert.ok(proof.metadata.modules[0].sourceMap.sourcesContent.includes(source));
    assert.match(proof.originalTypeScriptClaim,/generated JavaScript/);
    assert.equal((await recheckModuleRegionEvidence(result.exported.sidecar.sourceArtifact)).status,'passed');
  }
});

test('module proof tampering, exotic namespace receivers and asynchronous cycles cannot be relabeled as qualified',async()=>{
  const fixture=LANGUAGE_EXPANSION_INTERACTIONS.find(row=>row.id==='live-module-top-level-await');
  const result=await verifyRegionModuleTrainingCase(fixture);assert.ok(result.exported,result.reason);
  const changed=structuredClone(result.exported.sidecar.sourceArtifact);
  changed.sidecar.sourceProvenance.upstream.moduleEvidence.request.modules['a.js']='export let count=900;';
  await assert.rejects(recheckModuleRegionEvidence(changed),/changed/);
  const namespace=await verifyRegionModuleTrainingCase({id:'namespace-receiver',family:'namespace-receiver',
    modules:{'a.js':'export function f(){return this;}',
      'b.js':'import * as ns from "./a.js";export function run(){return ns.f();}'},entryModule:'b.js'});
  assert.equal(namespace.exported,undefined);
  assert.notEqual(namespace.status,'passed');
  assert.equal(namespace.moduleReference,'passed');
  const cycle=await verifyRegionModuleTrainingCase({id:'async-cycle',family:'async-cycle',modules:{
    'a.js':'import {b} from "./b.js";export const a=await Promise.resolve(1);export function run(){return b;}',
    'b.js':'import {a} from "./a.js";export const b=2;'},entryModule:'a.js'});
  assert.equal(cycle.status,'projection_refused');
  assert.equal(cycle.phase,'module-projection');
  assert.equal(cycle.moduleLink,'passed');
  assert.equal(cycle.nativeQualification,'unqualified');
  assert.equal(cycle.exported,undefined);
  assert.match(cycle.reason,/cyclic async module scheduling/);
  let reads=0;
  const modules=Object.defineProperty({},'main.js',{enumerable:true,get(){reads++;return 'export function run(){return 1;}';}});
  const hooked=await verifyRegionModuleTrainingCase({id:'hooked-module',family:'hooked-module',modules,entryModule:'main.js'});
  assert.equal(hooked.status,'unsupported');assert.equal(reads,0,'module graph eligibility must not invoke host getters');
});

test('parallel TLA links and runs in owned state while public/native module projection stays unqualified',async()=>{
  const linked=linkEvaluatedModules(siblingSchedulerFixture);
  assert.equal(linked.metadata.evaluationStrategy,'async-dependency-scheduler');
  const owned=await executeEvaluatedModules(siblingSchedulerFixture);
  assert.equal(owned.result,'abAB');
  const result=await verifyRegionModuleTrainingCase(siblingSchedulerFixture);
  assert.equal(result.status,'projection_refused');
  assert.equal(result.phase,'module-projection');
  assert.equal(result.moduleLink,'passed');
  assert.equal(result.ownedRuntimeProfile,'evaluated-module/1');
  assert.equal(result.moduleReference,'untested');
  assert.equal(result.publicProjection,'unqualified');
  assert.equal(result.nativeQualification,'unqualified');
  assert.equal(result.exported,undefined);
  assert.match(result.reason,/parallel top-level-await.*public\/native/);
});

test('module rechecking derives the scheduler refusal from source even when proof metadata lies',async()=>{
  for(const fixture of [siblingSchedulerFixture,{modules:{
    'main.js':`import './cycle.js';await 0;export function run(){return 1;}`,
    'cycle.js':`import './main.js';`
  },entryModule:'main.js',exportName:'run'}]){
    const linked=linkEvaluatedModules(fixture);
    const artifact={sidecar:{sourceProvenance:{upstream:{moduleEvidence:{
      schema:'semantic-module-evidence/1',profile:MODULE_REGION_PROFILE,
      request:{modules:fixture.modules,entryModule:'main.js',exportName:'run',
        inputGraph:encodeNativeGraph([linked.entryInput]),calls:null},
      metadata:{...linked.metadata,evaluationStrategy:'dependency-concatenation'}
    }}}}};
    await assert.rejects(recheckModuleRegionEvidence(artifact),error=>
      error.status==='projection_refused'&&error.phase==='module-projection'&&
      error.moduleLink==='passed'&&error.evaluationStrategy==='async-dependency-scheduler');
  }
});
