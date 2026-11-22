import test from 'node:test';
import assert from 'node:assert/strict';
import {linkEvaluatedModules} from '../src/evaluated-modules.js';

test('experimental namespace sync wrapper is source-proved only for the no-job AST subset',()=>{
  const safe=linkEvaluatedModules({modules:{
    'main.js':"import * as view from './view.js';import {update} from './state.js';export function run(key){const before=view[key];const keys=Object.keys(view);update(9);return {before,keys};}",
    'state.js':"export let value=1;export function update(next){value=next;}",
    'view.js':"export {value} from './state.js';"
  },entryModule:'main.js',exportName:'run',experimentalNamespacePlan:true});
  assert.equal(safe.metadata.namespaceExecutionVariant,'synchronous-no-source-jobs/1');
  assert.match(safe.source,/^"use strict";\nfunction __traced_evaluated_entry/);
  assert.doesNotMatch(safe.source,/await undefined/);

  const promiseAlias=linkEvaluatedModules({modules:{
    'main.js':"import * as view from './view.js';const schedule=Promise.resolve;export function run(){schedule().then(()=>0);return Object.keys(view);}",
    'view.js':"export const value=1;"
  },entryModule:'main.js',exportName:'run',experimentalNamespacePlan:true});
  assert.equal(promiseAlias.metadata.namespaceExecutionVariant,undefined);

  const computedGlobal=linkEvaluatedModules({modules:{
    'main.js':"import * as view from './view.js';const host=globalThis;export function run(){host['Promise'];return Object.keys(view);}",
    'view.js':"export const value=1;"
  },entryModule:'main.js',exportName:'run',experimentalNamespacePlan:true});
  assert.equal(computedGlobal.metadata.namespaceExecutionVariant,undefined);

  const topLevelAwait=linkEvaluatedModules({modules:{
    'main.js':"import * as view from './view.js';export const ready=await Promise.resolve(1);export function run(){return Object.keys(view);}",
    'view.js':"export const value=1;"
  },entryModule:'main.js',exportName:'run',experimentalNamespacePlan:true});
  assert.equal(topLevelAwait.metadata.namespaceExecutionVariant,undefined);
});
