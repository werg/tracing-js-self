import test from 'node:test';
import assert from 'node:assert/strict';
import {linkEvaluatedModules} from '../src/evaluated-modules.js';
import {buildExperimentalModuleNamespacePlanFromLinker} from '../src/semantic/module-namespace-state-v8.js';
import {verifyRegionModuleTrainingCase,verifyModuleNamespaceInputEvidence,recheckModuleRegionEvidence} from '../src/semantic/module-v8.js';
import {namespaceModules,namespaceEntry,namespaceExport,namespaceArgs,namespaceMaxGenerated} from './fixtures/semantic-module-namespace-v8.js';

test('direct namespace evidence entry rechecks original modules, args, worker observations and public plan',async()=>{
  const result=await verifyRegionModuleTrainingCase({
    id:'namespace-source-boundary',family:'namespace-source-boundary',
    moduleEntry:namespaceEntry,exportName:namespaceExport,modules:namespaceModules,args:namespaceArgs,
    experimentalNamespacePlan:true,projectionOptions:{maxGenerated:namespaceMaxGenerated}
  });
  assert.ok(result.exported,JSON.stringify({status:result.status,phase:result.phase,reason:result.reason}));
  const outer=result.exported,sourceArtifact=outer.sidecar.sourceArtifact;
  const moduleEvidence=sourceArtifact.sidecar.sourceProvenance.upstream.moduleEvidence;
  const linked=linkEvaluatedModules({modules:namespaceModules,entryModule:namespaceEntry,
    exportName:namespaceExport,args:namespaceArgs,calls:null,experimentalNamespacePlan:true});
  const plan=buildExperimentalModuleNamespacePlanFromLinker(linked);
  const proof={source:linked.source,entry:linked.entryFunction,args:[linked.entryInput],
    moduleNamespacePlan:plan,provenance:{moduleEvidence}};

  const mismatchedArgs=[...proof.args,['extra']];
  await assert.rejects(()=>verifyModuleNamespaceInputEvidence({...proof,args:mismatchedArgs}),
    /relink|args|plan|namespace/i);

  const forged=structuredClone(moduleEvidence);
  forged.reference.namespaceObservations.rows[0].moduleFile='forged.js';
  await assert.rejects(()=>verifyModuleNamespaceInputEvidence({...proof,
    provenance:{moduleEvidence:forged}}),/fresh original ESM|evidence|observations/i);

  const tampered=structuredClone(outer);
  const program=tampered.public.timeline.find(row=>row.kind==='program');
  program.fields.regionProgram.moduleNamespacePlan.namespaces[0].namespaceName+='__forged';
  await assert.rejects(()=>recheckModuleRegionEvidence(tampered),/public module namespace plan/i);
});
