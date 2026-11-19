import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyRegionModuleTrainingCase,recheckModuleRegionEvidence} from '../src/semantic/module-v8.js';
import {recheckRegionEvidence} from '../src/semantic/compiler-v8.js';
import {LANGUAGE_EXPANSION_INTERACTIONS} from '../fixtures/language-expansion/benchmark.js';

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
  assert.equal(namespace.status,'unsupported');assert.equal(namespace.phase,'module-link');
  assert.match(namespace.reason,/namespace receiver/);
  const cycle=await verifyRegionModuleTrainingCase({id:'async-cycle',family:'async-cycle',modules:{
    'a.js':'import {b} from "./b.js";export const a=await Promise.resolve(1);export function run(){return b;}',
    'b.js':'import {a} from "./a.js";export const b=2;'},entryModule:'a.js'});
  assert.equal(cycle.status,'unsupported');assert.match(cycle.reason,/async ESM/);
  let reads=0;
  const modules=Object.defineProperty({},'main.js',{enumerable:true,get(){reads++;return 'export function run(){return 1;}';}});
  const hooked=await verifyRegionModuleTrainingCase({id:'hooked-module',family:'hooked-module',modules,entryModule:'main.js'});
  assert.equal(hooked.status,'unsupported');assert.equal(reads,0,'module graph eligibility must not invoke host getters');
});
