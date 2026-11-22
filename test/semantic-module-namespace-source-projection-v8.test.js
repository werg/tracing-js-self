import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyRegionModuleTrainingCase} from '../src/semantic/module-v8.js';

const modules={
  'main.js':"import * as view from './view.js';import {update} from './state.js';export function run(key){const before=view[key];const keys=Object.keys(view);update(9);const after=Object.getOwnPropertyDescriptor(view,'value').value;return {before,after,keys};}",
  'state.js':"export let value=1;export const fixed=2;export function update(next){value=next;}",
  'view.js':"export {value,fixed} from './state.js';"
};

test('module namespace opt-in source-projects dynamic reads, keys and live descriptors',async()=>{
  const result=await verifyRegionModuleTrainingCase({
    id:'namespace-source-projection-positive',family:'namespace-source-projection',
    moduleEntry:'main.js',exportName:'run',modules,args:['value'],experimentalNamespacePlan:true,
    projectionOptions:{maxGenerated:20000}
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
    moduleEntry:'main.js',exportName:'run',modules,args:['value']
  });
  assert.equal(result.status,'projection_refused');
  assert.equal(result.category,'unsupported.module-namespace-projection');
});
