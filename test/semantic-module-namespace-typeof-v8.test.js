import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyRegionModuleTrainingCase,independentModuleRegionReference} from '../src/semantic/module-v8.js';
import {recheckRegionEvidence} from '../src/semantic/compiler-v8.js';
import {linkEvaluatedModules} from '../src/evaluated-modules.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';

test('native-agreeing namespace typeof passes source/public checks and a fresh module recheck',async()=>{
  const fixture={id:'module-namespace-typeof',family:'module-namespace-typeof',modules:{
    'leaf.js':'export const value=9;',
    'forward.js':"export * as cells from './leaf.js';",
    'main.js':"import * as ns from './forward.js';export function run(){return [typeof ns,typeof ns.cells,typeof ns.cells.value];}"
  },entryModule:'main.js',exportName:'run',fixture:{calls:[]}};
  const result=await verifyRegionModuleTrainingCase(fixture);
  assert.ok(result.exported,result.reason);
  assert.equal(result.moduleReference,'passed');assert.equal(result.moduleCorrespondence,'passed');
  const check=await recheckRegionEvidence(result.exported);
  assert.equal(check.moduleReference.status,'passed');
  assert.equal(check.native.admitted,false,'independent consumer admission remains a separate gate');
});

test('namespace typeof cannot bypass an original-module graph rejected by the native reference',async t=>{
  const fixture={id:'module-namespace-origin-typeof',family:'module-namespace-origin-typeof',modules:{
    'leaf.js':'export const value=9;',
    'left.js':"import * as local from './leaf.js';export {local as cells};",
    'right.js':"export * as cells from './leaf.js';",
    'barrel.js':"export * from './left.js';export * from './right.js';",
    'main.js':"import {cells} from './barrel.js';export function run(){return typeof cells;}"
  },entryModule:'main.js',exportName:'run',fixture:{calls:[]}},linked=linkEvaluatedModules(fixture),
    reference=await independentModuleRegionReference({modules:fixture.modules,entryModule:fixture.entryModule,
      exportName:fixture.exportName,calls:null,inputGraph:encodeNativeGraph([linked.entryInput])}),
    result=await verifyRegionModuleTrainingCase(fixture);
  assert(['passed','unsupported'].includes(reference.status),reference.reason);
  if(linked.metadata.requiresModuleNamespace){
    assert.equal(result.status,'projection_refused');
    assert.equal(result.category,'unsupported.module-namespace-projection');
    assert.equal(result.exported,undefined,
      'owned namespace state cannot bypass the public projection boundary');
    if(reference.status!=='passed')assert.match(reference.reason,/conflicting star exports/);
  }else if(reference.status!=='passed'){
    assert.match(reference.reason,/conflicting star exports/);
    assert.equal(result.status,reference.status);assert.equal(result.phase,'module-reference');
    assert.equal(result.exported,undefined,'owned typeof folding is not independent reference authority');
  }else {
    assert.ok(result.exported,result.reason);assert.equal(result.moduleCorrespondence,'passed');
  }
  t.diagnostic(JSON.stringify({node:process.version,v8:process.versions.v8,
    nativeModuleReference:reference.status,publicStatus:result.status,
    publicExported:Boolean(result.exported),nativeConsumerAdmitted:false}));
});
