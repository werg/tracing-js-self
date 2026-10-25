import test from 'node:test';
import assert from 'node:assert/strict';
import {semanticRecipeFamilies,SEMANTIC_TASK_TEMPLATES} from '../src/training/recipe-fixtures.js';
import {effectfulFamilySplit,verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
import {verifyEffectfulSession,recheckEffectfulSession} from '../src/training/effectful-session.js';

test('authored source families retain every template and its ancestry across representations and splits',()=>{
  const explicit=semanticRecipeFamilies(),compact=semanticRecipeFamilies({representation:'compact'});
  assert.equal(explicit.length,SEMANTIC_TASK_TEMPLATES.length);
  assert.equal(new Set(explicit.map(item=>item.pure.source)).size,explicit.length);
  assert.deepEqual(explicit.map(item=>item.family),compact.map(item=>item.family));
  assert.deepEqual(new Set(explicit.map(item=>effectfulFamilySplit(item.family))),new Set(['train','validation','test']));
  for(const [index,family] of explicit.entries()){
    const variants=[family.pure,family.callbacks,...family.repeated.cases];
    for(const variant of variants){
      assert.equal(variant.family,family.family);
      assert.deepEqual(variant.ancestorIds,['source-template:'+family.template]);
      assert.equal(effectfulFamilySplit(variant.family),effectfulFamilySplit(family.family));
    }
    assert.deepEqual(family.pure.args,compact[index].pure.args);
    assert.equal(family.callbacks.source,compact[index].callbacks.source);
  }
  assert.throws(()=>semanticRecipeFamilies({representation:'relabelled'}),/representation/);
});

test('actual train and validation source collections contain pure, callback, recovery and repeated behavior',async()=>{
  for(const split of ['train','validation']){
    const family=semanticRecipeFamilies({representation:'compact'}).find(item=>effectfulFamilySplit(item.family)===split);
    const pure=await verifyEffectfulTrainingCase(family.pure);
    assert.equal(pure.status,'locally_verified',pure.reason);assert.equal(pure.exported.sidecar.split,split);
    assert.deepEqual(pure.exported.sidecar.effects,[]);
    const callbacks=await verifyEffectfulTrainingCase(family.callbacks);
    assert.equal(callbacks.status,'locally_verified',callbacks.reason);
    const timeline=callbacks.exported.public.timeline;
    assert.equal(timeline.filter(item=>item.kind==='event').length,2);
    for(const kind of ['source-evict','source-read','reconcile'])assert(timeline.some(item=>item.kind===kind));
    assert.equal(callbacks.exported.sidecar.compiler.checkpoints[0].nativeRedispatches,0);
    assert.deepEqual(callbacks.exported.sidecar.ancestorIds,[family.family,'source-template:'+family.template]);
    const repeated=await verifyEffectfulSession(family.repeated);
    assert.equal(repeated.status,'locally_verified',repeated.reason);
    assert.equal(repeated.exported.public.timeline.filter(item=>item.kind==='program').length,1);
    const invocations=repeated.exported.public.timeline.filter(item=>item.kind==='invocation');
    assert.equal(invocations.length,2);assert(invocations.every(item=>item.realmPolicy==='fresh'));
    assert.equal(new Set(invocations.map(item=>item.triggerId)).size,2);
    assert.equal(repeated.exported.sidecar.split,split);
    assert.equal((await recheckEffectfulSession(repeated.exported,{requireAdmitted:false})).sourceValidated,true);
    const child=repeated.exported.sidecar.collection.components[0];
    assert.equal(child.sidecar.split,split);assert.equal(child.sidecar.sourceFamily,family.family);
    assert.equal(child.public.timeline.filter(item=>item.kind==='invocation').length,1);
  }
});
