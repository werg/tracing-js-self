import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyRegionModuleTrainingCase} from '../src/semantic/module-v8.js';
import {namespaceModules as modules,namespaceEntry,namespaceExport,namespaceArgs,namespaceMaxGenerated} from './fixtures/semantic-module-namespace-v8.js';

test('module namespace opt-in source-projects dynamic reads, keys and live descriptors',async()=>{
  const result=await verifyRegionModuleTrainingCase({
    id:'namespace-source-projection-positive',family:'namespace-source-projection',
    moduleEntry:namespaceEntry,exportName:namespaceExport,modules,args:namespaceArgs,experimentalNamespacePlan:true,
    projectionOptions:{maxGenerated:namespaceMaxGenerated}
  });
  const diagnostic=JSON.stringify({status:result.status,phase:result.phase,reason:result.reason,category:result.category});
  assert.ok(result.exported,diagnostic);
  assert.notEqual(result.status,'projection_refused',diagnostic);
  assert.notEqual(result.phase,'module-projection',result.reason);
  assert.equal(result.moduleReference,'passed');
  assert.equal(result.moduleCorrespondence,'passed');
  assert.ok(result.exported);
});

test('module namespace remains refused without explicit opt-in plan',async()=>{
  const result=await verifyRegionModuleTrainingCase({
    id:'namespace-source-projection-control',family:'namespace-source-projection',
    moduleEntry:namespaceEntry,exportName:namespaceExport,modules,args:namespaceArgs
  });
  assert.equal(result.status,'projection_refused');
  assert.equal(result.category,'unsupported.module-namespace-projection');
});
