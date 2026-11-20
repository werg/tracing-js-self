import test from 'node:test';
import assert from 'node:assert/strict';
import {notationViews,renderFormalTerm,renderNotationRecord} from '../src/semantic/notation-experiment.js';
import {OPERATION_REGISTRY} from '../src/semantic/operations.js';
import {operationMetadata} from '../src/semantic/operation-metadata.js';
const lit=n=>({op:'literal',value:['num',n]}),op=(name,...args)=>({op:name,args});

test('notation arms preserve evaluation order and laziness on one semantic record',()=>{
  const term=op('select',op('less',lit(2),lit(3)),op('subtract',lit(8),lit(5)),op('divide',lit(1),lit(0)));
  const views=notationViews([{kind:'compute',id:'v0',term,result:['num',3]},{kind:'return',value:['num',3]}]);
  assert.equal(views.arms.formal,'v0 = ((2 < 3) ? (8 - 5) : (1 / 0)) => 3\nreturn 3');
  assert.equal(views.arms.canonical,views.canonical);
  assert.match(views.arms.prose,/evaluate only the selected branch/);
  assert.match(views.semanticDigest,/^[a-f0-9]{64}$/);
  assert.equal(renderFormalTerm(op('subtract',lit(1),op('subtract',lit(2),lit(3)))),'(1 - (2 - 3))');
});

test('derived views retain request routing, observations and absent writes',()=>{
  for(const arm of ['formal','hybrid','prose']){
    const text=renderNotationRecord({kind:'request',id:'r0',boundary:'b0',operation:'demo.readAsync',arguments:[['str','counter']]},{arm});
    for(const identity of ['r0','b0','demo.readAsync','counter'])assert.ok(text.includes(identity));
    assert.match(renderNotationRecord({kind:'observe',request:'r0',id:'v0',status:'completed'},{arm}),/completed/);
    const deletion=renderNotationRecord({kind:'write',object:['ref','o1'],key:'x',value:['undefined'],present:false},{arm});
    assert.match(deletion,/o1/);assert.match(deletion,/x/);
  }
  assert.throws(()=>renderNotationRecord({kind:'return',value:['num',1]},{arm:'unicode'}),/Unknown/);
});

test('every currently registered primitive publishes effects, ordering and consumer qualification',()=>{
  for(const name of Object.keys(OPERATION_REGISTRY)){
    const metadata=operationMetadata(name);
    assert.equal(metadata.evaluationOrder,'left-to-right');
    assert.equal(typeof metadata.effects.mayThrow,'boolean');
    assert.equal(metadata.consumer.native,'requires-exact-contract-admission');
    assert.ok(Object.isFrozen(metadata));
  }
  assert.equal(operationMetadata('divide').effects.mayThrow,true);
  assert.equal(operationMetadata('coalesce').laziness.conditionOperand,0);
  assert.throws(()=>operationMetadata('evaluate-whatever'),/No qualified/);
});
