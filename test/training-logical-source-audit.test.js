import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {referenceOutcome} from '../src/training/reference.js';
import {auditReferenceOperations} from '../src/training/operation-reference.js';
import {auditReferenceBranches,instrumentBranchSource} from '../src/training/branch-reference.js';
import {verifyOwnedSourceCase} from '../src/training/source-check.js';

function audits(body,args=[]){
  const source='"use strict";function run(o){'+body+'}',runtime=createRuntime().startEntry({text:source,functionName:'run',args});runtime.drive();
  const bundle=runtime.exportRun(),options={source,entry:'run',args:bundle.entrySpec.arguments,initialHeap:bundle.initialState.heap,bundle};
  options.reference=referenceOutcome(options);
  return {options,operations:auditReferenceOperations(options),branches:auditReferenceBranches(options)};
}
test('logical member receipts preserve reference evaluation, key conversion and nested branch order',()=>{
  for(const o of [{x:0},{x:4},{x:null}]){
    const body='let keys=0;function key(){keys++;return "x";}const x=o[key()] ||= (o.x??=7);return [keys,x,o];',
      {operations,branches}=audits(body,[o]);
    assert.equal(operations.status,'agreed',JSON.stringify(operations));assert.equal(branches.status,'agreed',JSON.stringify(branches));
    const result=verifyOwnedSourceCase({source:'"use strict";function run(o){'+body+'}',entry:'run',args:[o]});
    assert.equal(result.status,'locally_verified',result.reason);
  }
});
test('branch reference instrumentation preserves getter calls and native computed-key conversion',()=>{
  const source='"use strict";function run(){let keys=0,reads=0,writes=0;const key={toString(){keys++;return "x";}};'+
    'const o={get x(){reads++;return 0;},set x(v){writes+=v;}};o[key] ||= 3;return [keys,reads,writes];}';
  const expected=referenceOutcome({source,entry:'run',args:[],initialHeap:{}});
  const instrumented=referenceOutcome({source:instrumentBranchSource(source),entry:'run',args:[],initialHeap:{},observeBranches:true});
  assert.deepEqual(instrumented.graph,expected.graph);assert.equal(instrumented.decisions.length,1);
});
test('logical source audits detect forged skipped values and decisions despite unchanged final return',()=>{
  const {options}=audits('o ||= 7;return 3;',[2]);
  const changed=structuredClone(options);
  const branch=changed.bundle.events.find(row=>row.operation==='control.branch');
  branch.result=['bool',false];
  assert.notEqual(auditReferenceBranches(changed).status,'agreed');
  const skipped=structuredClone(options);
  skipped.bundle.events.find(row=>row.operation==='control.branch').operands[0]=['num',999];
  assert.equal(auditReferenceOperations(skipped).status,'mismatch');
  const original=audits('o ||= 7;return 3;',[2]);
  assert.equal(original.operations.checked,1);assert.equal(original.branches.checked,1);
});
