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

  // This host-global escape can be refused by original owned syntax before
  // the experimental no-source-jobs check is reached.
  try{
    const computedGlobal=linkEvaluatedModules({modules:{
      'main.js':"import * as view from './view.js';const host=globalThis;export function run(){host['Promise'];return Object.keys(view);}",
      'view.js':"export const value=1;"
    },entryModule:'main.js',exportName:'run',experimentalNamespacePlan:true});
    assert.equal(computedGlobal.metadata.namespaceExecutionVariant,undefined);
  }catch(error){
    assert.match(error.message,/Unsupported evaluated-module\/1:.*unbound identifier globalThis/);
  }

  const topLevelAwait=linkEvaluatedModules({modules:{
    'main.js':"import * as view from './view.js';export const ready=await Promise.resolve(1);export function run(){return Object.keys(view);}",
    'view.js':"export const value=1;"
  },entryModule:'main.js',exportName:'run',experimentalNamespacePlan:true});
  assert.equal(topLevelAwait.metadata.namespaceExecutionVariant,undefined);
});

const scalarModules=main=>({
  'main.js':main,
  'state.js':"export let value=1;export function update(next){value=next;}",
  'view.js':"export {value} from './state.js';"
});
const linkBounded=main=>linkEvaluatedModules({
  modules:scalarModules(main),entryModule:'main.js',exportName:'run',
  experimentalNamespacePlan:true
});

test('namespace no-job proof rejects parameter and local shadows of imported call targets',()=>{
  for(const body of [
    "export function run(update){update(9);return Object.keys(view);}",
    "export function run(){const update=9;return Object.keys(view);}"
  ]){
    const linked=linkBounded("import * as view from './view.js';import {update} from './state.js';"+body);
    assert.equal(linked.metadata.namespaceExecutionVariant,undefined);
  }
});

test('namespace no-job proof rejects thenable result shapes even through descriptor values',()=>{
  for(const result of [
    "{then:update}",
    "{then:Object.getOwnPropertyDescriptor(view,'value').value}"
  ]){
    const linked=linkBounded("import * as view from './view.js';import {update} from './state.js';export function run(){const keys=Object.keys(view);return "+result+";}");
    assert.equal(linked.metadata.namespaceExecutionVariant,undefined);
  }
});

test('namespace no-job proof refuses async declarations even without a taken call',()=>{
  const linked=linkBounded("import * as view from './view.js';async function later(){return 1;}export function run(){return Object.keys(view);}");
  assert.equal(linked.metadata.namespaceExecutionVariant,undefined);
});

test('the experimental no-job wrapper does not change ordinary evaluated-module scheduling',()=>{
  const modules=scalarModules("import * as view from './view.js';export function run(){return Object.keys(view);}");
  const ordinary=linkEvaluatedModules({modules,entryModule:'main.js',exportName:'run'});
  assert.match(ordinary.source,/^"use strict";\nasync function __traced_evaluated_entry/);
  assert.match(ordinary.source,/await undefined/);
  assert.equal(ordinary.metadata.namespaceExecutionVariant,undefined);
});
