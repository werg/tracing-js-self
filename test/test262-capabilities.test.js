import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'acorn';
import {freeTest262Identifiers,requiresScriptGlobalThis,test262HostCapabilities,unsupportedOwnedGlobals}
  from '../src/conformance/test262-capabilities.js';

const ast=source=>parse(source,{ecmaVersion:2026,sourceType:'script'});

test('parameter initializers retain outer globals despite body variable declarations',()=>{
  for(const source of [
    'function f(value=Map){var Map;return value;}',
    'const f=({value=Map}={})=>{var Map;return value;};',
    'function f({[Map]:value}){var Map;}',
    'function f(value=(()=>Map)()){var Map;}'
  ])assert.deepEqual(unsupportedOwnedGlobals(ast(source)),['Map'],source);
  for(const source of [
    'function f(Map,value=Map){return value;}',
    'let Map;function f(value=Map){var Map;}',
    'const f=function Map(value=Map){return value;};'
  ])assert.deepEqual(freeTest262Identifiers(ast(source)),[],source);
});

test('switch discriminants and static blocks do not leak their lexical or var bindings',()=>{
  assert.deepEqual(unsupportedOwnedGlobals(ast('switch(Map){case 1:let Map;break;}')),['Map']);
  assert.deepEqual(unsupportedOwnedGlobals(ast('class C{static{var Map=1;}}Map;')),['Map']);
  assert.deepEqual(freeTest262Identifiers(ast('switch(1){case 1:let Map;Map;break;}')),[]);
  assert.deepEqual(freeTest262Identifiers(ast('class C{static{var Map=1;Map;}}')),[]);
  assert.deepEqual(unsupportedOwnedGlobals(ast('class C{static{var Map;}static value=Map;}')),['Map']);
});

test('class computed names retain the surrounding receiver without confusing field receivers',()=>{
  for(const source of [
    'class C{[this.key](){}}',
    'class C{static [this.key]=1;}',
    'class C{[(()=>this.key)()]=1;}',
    'class C extends this.Base{}'
  ])assert.equal(requiresScriptGlobalThis(ast(source)),true,source);
  for(const source of [
    'class C{method(){return this;}}',
    'class C{field=this;static value=this;static{this;}}',
    'function f(){class C{[this.key](){}}}',
    'class C{[function(){return this;}()]=1;}'
  ])assert.equal(requiresScriptGlobalThis(ast(source)),false,source);
});

test('Test262 agent hooks stay explicit through direct, globalThis and simple alias access',()=>{
  for(const source of [
    '$262.agent.start("worker.js");',
    'globalThis.$262.agent.getReport();',
    'globalThis["$262"]["agent"].broadcast(1);',
    'const host=$262;host.agent.start("worker.js");',
    'const {agent}=globalThis.$262;agent.start("worker.js");'
  ])assert.deepEqual(test262HostCapabilities(ast(source)),['agent-cluster','test262-host-object'],source);
  for(const source of [
    'const $262={agent:{start(){}}};$262.agent.start("worker.js");',
    'const globalThis={$262:{agent:{}}};globalThis.$262.agent;'
  ])assert.deepEqual(test262HostCapabilities(ast(source)),[],source);
  assert.deepEqual(test262HostCapabilities(ast('$262;')),['test262-host-object']);
});
