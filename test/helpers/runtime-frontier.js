import assert from 'node:assert/strict';
import {createRuntime} from '../../src/runtime.js';
import {validateBundle} from '../../src/validation.js';
import {replayExact} from '../../src/replay.js';
import {referenceOutcome,ownedOutcome} from '../../src/training/reference.js';
import {auditReferenceOperations} from '../../src/training/operation-reference.js';
import {auditReferenceBranches} from '../../src/training/branch-reference.js';

/** Owned/reference evidence only; this never claims public/native admission. */
export function runtimeDifferential(body,{args=[],entry='run',maxSteps=10000,source=null}={}){
  const text=source??'"use strict";function '+entry+'(x){'+body+'}';
  const runtime=createRuntime({maxSteps}).startEntry({text,functionName:entry,args});
  const progress=runtime.drive();
  const bundle=runtime.exportRun();
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
  const options={source:text,entry,args:bundle.entrySpec.arguments,
    initialHeap:bundle.initialState.heap,bundle};
  const reference=referenceOutcome(options);
  assert(['return','throw'].includes(reference.kind),JSON.stringify(reference));
  assert.deepEqual(ownedOutcome(runtime),reference);
  assert.equal(auditReferenceOperations({...options,reference}).status,'agreed');
  assert.equal(auditReferenceBranches({...options,reference}).status,'agreed');
  return {runtime,bundle,reference,progress};
}
