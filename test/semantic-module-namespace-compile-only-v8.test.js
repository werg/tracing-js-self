import test from 'node:test';
import assert from 'node:assert/strict';
import {linkEvaluatedModules} from '../src/evaluated-modules.js';
import {buildExperimentalModuleNamespacePlanFromLinker} from '../src/semantic/module-namespace-state-v8.js';
import {createRuntime} from '../src/runtime.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {namespaceModules as modules,namespaceEntry,namespaceExport,namespaceArgs,namespaceMaxGenerated} from './fixtures/semantic-module-namespace-v8.js';

test('namespace source compiler owns runtime namespace and live-cell effects before audit qualification',()=>{
  const linked=linkEvaluatedModules({modules,entryModule:namespaceEntry,exportName:namespaceExport,args:namespaceArgs,
    calls:null,experimentalNamespacePlan:true});
  const plan=buildExperimentalModuleNamespacePlanFromLinker(linked);
  const runtime=createRuntime({maxSteps:20000}).startEntry({text:linked.source,functionName:linked.entryFunction,
    args:[linked.entryInput],allowAsync:true,moduleNamespaceIntrinsic:true});
  const progress=runtime.drive();
  assert.equal(progress.kind,'terminated');
  const projection=compileProtocolSourceV8(runtime.exportRun(),{maxGenerated:namespaceMaxGenerated,moduleNamespacePlan:plan});
  const records=projection.claims.filter(row=>row.kind==='protocol').map(row=>row.record);
  const kinds=new Set(records.map(row=>row.kind));
  for(const kind of ['namespace.create','namespace.keys','namespace.read','namespace.descriptor',
    'cell.initialize','cell.write'])assert.ok(kinds.has(kind),'missing '+kind);
  assert.ok(projection.extensions?.includes('experimental-module-namespace-source/1'));
  assert.ok(projection.claims.some(row=>row.certificate?.journalEvents?.length>1),
    'creation pair must own its grouped source prefix');

  const harness=new RegionExecutionHarness({sessionId:'namespace-compile-only',automaticDelivery:false,now:()=>-Infinity,maxGenerated:20000});
  harness.publishProgram({programId:'program1',source:projection.source,entry:projection.entry,capabilities:[],
    moduleNamespacePlan:plan});
  harness.admitInvocation({programId:'program1',invocationId:'invocation1',trackId:'worker1',realmId:'realm1',
    triggerId:'namespace-compile-only',inputGraph:projection.inputGraph,realmPolicy:'fresh',completionPolicy:'call-return'});
  for(const claim of projection.claims){
    harness.modelContext('invocation1');
    harness.select('invocation1',claim.line);
  }
  assert.deepEqual({kind:harness.controller.completion?.kind,graph:harness.controller.observedGraph()},projection.outcome);
  const restored=RegionExecutionHarness.restore(harness.checkpoint());
  assert.deepEqual(restored.controller.observedGraph(),projection.outcome.graph);
});
