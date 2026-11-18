import test from 'node:test';
import assert from 'node:assert/strict';
import {holdoutCase,requireDisjointComponent} from '../tools/build-exploratory-holdout.mjs';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';

test('diagnostic holdout never passes teacher or expectation to the selected model',async()=>{
  const checked=await verifyEffectfulTrainingCase({source:'"use strict";function run(){throw 7;}',
    entry:'run',family:'holdout-shape-check',fixture:{calls:[]}});
  assert.equal(checked.status,'locally_verified');
  // Shape-only fixture, not a native admission claim. The CLI authenticates
  // actual immutable identities and the runner independently rechecks native gates.
  const exported=checked.exported;
  exported.sidecar.admission='admitted';exported.sidecar.nativeAdmission={admitted:true};
  exported.sidecar.split='test';
  const result=holdoutCase(exported,{id:'declared-case'});
  assert.equal(result.id,'declared-case');
  assert.equal(result.expected.completion.kind,'throw');
  assert.equal(result.envelope.request.controlledSelectionsByRepresentation,undefined);
  assert.equal(result.envelope.expected,undefined);
  assert.equal(result.envelope.request.expected,undefined);
  assert(exported.public.timeline.some(row=>row.kind==='semantic'));
  exported.sidecar.split='train';
  assert.throws(()=>holdoutCase(exported),/test examples/);
});

test('diagnostic holdout refuses overlapping, renamed, or differently frozen components',()=>{
  const trained=new Set(['component:train']);
  const split={policy:'source-components/1',split:'test',registryDigest:'registry',componentId:'component:test'};
  requireDisjointComponent(split,trained,'registry');
  assert.throws(()=>requireDisjointComponent({...split,componentId:'component:train'},trained,'registry'),/training corpus/);
  assert.throws(()=>requireDisjointComponent({...split,registryDigest:'different'},trained,'registry'),/registry/);
  assert.throws(()=>requireDisjointComponent({...split,split:'train'},trained,'registry'),/test-component/);
  assert.throws(()=>requireDisjointComponent({...split,policy:'caller-family-label'},trained,'registry'),/test-component/);
});
