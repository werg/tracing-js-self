import test from 'node:test';
import assert from 'node:assert/strict';
import {executeEvaluatedModulesSync,linkEvaluatedModules} from '../src/evaluated-modules.js';

test('experimental namespace linker cells map to owned runtime allocation and binding events',()=>{
  const modules={
    'main.js':"import * as ns from './cells.js';import {update} from './cells.js';export function run(){const before=Object.getOwnPropertyDescriptor(ns,'value').value;const keys=Object.keys(ns);update(9);return {before,after:Object.getOwnPropertyDescriptor(ns,'alias').value,alias:ns.alias,keys};}",
    'cells.js':"export let value=1;export {value as alias};export const fixed=2;export function update(next){value=next;}"
  };
  const linked=linkEvaluatedModules({modules,entryModule:'main.js',exportName:'run',
    experimentalNamespacePlan:true});
  const plan=linked.metadata.namespaceSourcePlan;
  assert.ok(plan);
  const valueCell=plan.cells.find(cell=>cell.file==='cells.js'&&cell.local==='value');
  assert.deepEqual(valueCell,{file:'cells.js',local:'value',loweredName:'__traced_eval_m1_value',
    kind:'let',mutable:true});
  assert.equal(plan.namespaces.find(row=>row.file==='cells.js').namespaceName,'__traced_eval_namespace_0');
  assert.deepEqual(plan.namespaces.find(row=>row.file==='cells.js').exports.map(row=>row.name),
    ['alias','fixed','update','value']);
  assert.equal(plan.namespaces.find(row=>row.file==='cells.js').exports.find(row=>row.name==='alias').file,
    valueCell.file);
  assert.equal(plan.namespaces.find(row=>row.file==='cells.js').exports.find(row=>row.name==='alias').local,
    valueCell.local);

  const owned=executeEvaluatedModulesSync({modules,entryModule:'main.js',exportName:'run'});
  assert.deepEqual(owned.result,{before:1,after:9,alias:9,keys:['alias','fixed','update','value']});
  const {bundle}=owned;
  const runtimeNamespaceAllocations=bundle.events.flatMap(event=>(event.stateChanges??[])
    .filter(change=>change.table==='heap'&&change.before===null&&change.after?.kind==='module-namespace')
    .map(change=>({event,namespace:change.after})));
  const captured=runtimeNamespaceAllocations[0];
  const namespaceId=captured?.namespace?.id;
  const relevant=bundle.events.map(event=>{
    const pending=(event.stateChanges??[]).filter(change=>change.table==='frames'&&
      (change.before?.pendingModuleNamespace?.namespaceId===namespaceId||
       change.after?.pendingModuleNamespace?.namespaceId===namespaceId)).map(change=>({
        frameId:change.id,before:change.before?.pendingModuleNamespace??null,
        after:change.after?.pendingModuleNamespace??null
      }));
    const cells=(event.stateChanges??[]).filter(change=>change.table==='envs'&&
      (Object.hasOwn(change.before?.bindings??{},valueCell.loweredName)||
       Object.hasOwn(change.after?.bindings??{},valueCell.loweredName))).map(change=>({
        envId:change.id,before:change.before?.bindings?.[valueCell.loweredName]??null,
        after:change.after?.bindings?.[valueCell.loweredName]??null
      }));
    const reads=(event.readObservations??[]).filter(read=>read.kind==='binding'&&read.name===valueCell.loweredName);
    return {eventId:event.eventId,sequence:event.sequence,operation:event.operation,siteId:event.siteId,
      operands:event.operands,result:event.result,causes:event.causes,
      namespaceAllocations:(event.stateChanges??[]).filter(change=>change.table==='heap'&&
        change.after?.kind==='module-namespace').map(change=>({id:change.id,kind:change.after.kind,
          names:change.after.namespaceExportNames,prototype:change.after.prototype,
          extensible:change.after.extensible})),
      pending,cells,reads};
  }).filter(row=>row.namespaceAllocations.length||row.pending.length||row.cells.length||row.reads.length);
  console.log('NAMESPACE_RUNTIME_CAPTURE_JSON '+JSON.stringify({
    bundleKeys:Object.keys(bundle),eventCount:bundle.events.length,sourcePlan:plan,
    spans:linked.metadata.instantiationAndEvaluation,namespaceId,relevantEvents:relevant.slice(0,80)
  }));
  // Exact runtime changes for the owning projector: retained objects and
  // parent frame stacks identify each namespace result without guessing IDs.
  const inspectionStart=allocationEventSafe(bundle.events,namespaceId);
  console.log('NAMESPACE_RUNTIME_EFFECTS_JSON '+JSON.stringify({
    source:linked.source,sites:bundle.sites,namespaceId,
    events:bundle.events.filter(event=>event.sequence>=inspectionStart&&event.sequence<=145)
      .map(event=>({...event,stateChanges:(event.stateChanges??[])
        .filter(change=>change.table==='heap'||change.table==='frames')}))
  }));
  const namespaceAllocations=bundle.events.flatMap(event=>(event.stateChanges??[])
    .filter(change=>change.table==='heap'&&change.before===null&&change.after?.kind==='module-namespace')
    .map(change=>({event,namespace:change.after})));
  assert.equal(namespaceAllocations.length,1);
  const {event:allocationEvent,namespace}=namespaceAllocations[0];
  assert.deepEqual(namespace.namespaceExportNames,['alias','fixed','update','value']);
  assert.equal(namespace.prototype,null);
  assert.equal(namespace.extensible,false);
  const allocationSite=bundle.sites.find(site=>site.siteId===allocationEvent.siteId);
  assert.ok(allocationSite);
  const namespaceSpan=linked.metadata.instantiationAndEvaluation.find(span=>
    span.file==='cells.js'&&span.kind==='namespace-object');
  assert.ok(namespaceSpan);
  assert.ok(allocationSite.start>=namespaceSpan.start&&allocationSite.end<=namespaceSpan.end);

  assert.equal(allocationEvent.operation,'call.enter');
  const pendingChanges=relevant.flatMap(row=>row.pending.map(change=>({...change,eventId:row.eventId,
    operation:row.operation})));
  assert.ok(pendingChanges.some(change=>change.after?.kind==='descriptor'),
    'descriptor access retains a getter continuation');
  assert.ok(pendingChanges.some(change=>change.before?.kind==='descriptor'&&!change.after),
    'descriptor getter completion clears its continuation');
  assert.ok(pendingChanges.some(change=>change.after?.kind==='namespace-inspection'),
    'Object.keys retains an own-key inspection continuation');
  const cellReads=relevant.flatMap(row=>row.reads.map(read=>({...read,eventId:row.eventId,
    operation:row.operation})));
  assert.ok(cellReads.some(read=>read.value?.[1]===1),'namespace getter reads the initial live cell value');
  assert.ok(cellReads.some(read=>read.value?.[1]===9),'namespace getter reads the updated live cell value');
  const cellChanges=bundle.events.filter(event=>
    ['binding.initialize','binding.write','binding.update'].includes(event.operation)&&
    (event.stateChanges??[]).some(change=>change.table==='envs'&&
      Object.hasOwn(change.after?.bindings??{},valueCell.loweredName)));
  assert.ok(cellChanges.some(event=>event.operation==='binding.initialize'),
    'source cell initialization uses the linker-stable lowered binding');
  assert.ok(cellChanges.some(event=>event.operation==='binding.write'||event.operation==='binding.update'),
    'live cell update uses the same linker-stable lowered binding');
});

function allocationEventSafe(events,namespaceId){
  return events.find(event=>(event.stateChanges??[]).some(change=>
    change.table==='heap'&&change.id===namespaceId&&change.before===null))?.sequence??0;
}
