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
  assert.deepEqual(plan.namespaces.find(row=>row.file==='cells.js').exports.map(row=>row.name),
    ['alias','fixed','update','value']);
  assert.equal(plan.namespaces.find(row=>row.file==='cells.js').exports.find(row=>row.name==='alias').file,
    valueCell.file);
  assert.equal(plan.namespaces.find(row=>row.file==='cells.js').exports.find(row=>row.name==='alias').local,
    valueCell.local);

  const owned=executeEvaluatedModulesSync({modules,entryModule:'main.js',exportName:'run'});
  assert.deepEqual(owned.result,{before:1,after:9,alias:9,keys:['alias','fixed','update','value']});
  const {bundle}=owned;
  const sampleByOperation=new Map();
  for(const event of bundle.events??[])if(!sampleByOperation.has(event.operation))
    sampleByOperation.set(event.operation,event);
  console.log('NAMESPACE_RUNTIME_CAPTURE_JSON '+JSON.stringify({
    bundleKeys:Object.keys(bundle),eventCount:bundle.events?.length,
    sourcePlan:plan,spans:linked.metadata.instantiationAndEvaluation,
    samples:[...sampleByOperation].slice(0,36).map(([operation,event])=>({
      operation,keys:Object.keys(event),sample:JSON.stringify(event).slice(0,2600)
    }))
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

  const getterReads=bundle.events.filter(event=>event.operation==='property.read'&&
    event.operands?.[0]?.[0]==='ref'&&event.operands[0][1]===namespace.id);
  assert.ok(getterReads.length>=3,'descriptor, Object.keys and alias reads dispatch live export getters');
  const cellChanges=bundle.events.filter(event=>
    ['binding.initialize','binding.write','binding.update'].includes(event.operation)&&
    (event.stateChanges??[]).some(change=>change.table==='envs'&&
      Object.hasOwn(change.after?.bindings??{},valueCell.loweredName)));
  assert.ok(cellChanges.some(event=>event.operation==='binding.initialize'),
    'source cell initialization uses the linker-stable lowered binding');
  assert.ok(cellChanges.some(event=>event.operation==='binding.write'||event.operation==='binding.update'),
    'live cell update uses the same linker-stable lowered binding');
});
