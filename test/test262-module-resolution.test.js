import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'acorn';
import {unresolvedOriginalModuleBindings} from '../src/conformance/test262-module-resolution.js';

const missing=modules=>unresolvedOriginalModuleBindings(new Map(Object.entries(modules).map(([file,text])=>
  [file,parse(text,{ecmaVersion:2026,sourceType:'module'})])));

test('original-source resolution follows imported-local aliases and same-origin star diamonds',()=>{
  assert.deepEqual(missing({
    'leaf.js':'export let x=1;',
    'a.js':"import {x as local} from './leaf.js';export {local as value};",
    'b.js':"export {x as value} from './leaf.js';",
    'barrel.js':"export * from './a.js';export * from './b.js';",
    'main.js':"import {value} from './barrel.js';void value;"
  }),[]);
});

test('original-source nested ambiguity is retained and only requested exports reject',()=>{
  const graph={
    'a.js':'export const x=1;',
    'b.js':'export const x=2;',
    'ambiguous.js':"export * from './a.js';export * from './b.js';",
    'barrel.js':"export * from './ambiguous.js';export * from './a.js';"
  };
  assert.deepEqual(missing({...graph,'main.js':"import * as ns from './barrel.js';void ns;"}),[]);
  for(const statement of ["import {x} from './barrel.js';","export {x} from './barrel.js';"])
    assert.deepEqual(missing({...graph,'main.js':statement}),[
      {from:'main.js',target:'barrel.js',name:'x',kind:'export',resolution:'ambiguous'}]);
});

test('namespace reexports compare their module origin but local namespace bindings stay distinct',()=>{
  for(const local of [false,true]){
    const result=missing({
      'leaf.js':'export const x=1;',
      'a.js':local?"import * as cells from './leaf.js';export {cells};":"export * as cells from './leaf.js';",
      'b.js':local?"import * as cells from './leaf.js';export {cells};":"export * as cells from './leaf.js';",
      'barrel.js':"export * from './a.js';export * from './b.js';",
      'main.js':"import {cells} from './barrel.js';void cells;"
    });
    assert.deepEqual(result,local?[
      {from:'main.js',target:'barrel.js',name:'cells',kind:'export',resolution:'ambiguous'}]:[]);
  }
});

test('cyclic export paths terminate, keep ordinary origins and do not inherit default from stars',()=>{
  const graph={
    'a.js':"export * from './b.js';export const x=1;export default 5;",
    'b.js':"export * from './a.js';"
  };
  assert.deepEqual(missing({...graph,'main.js':"import {x} from './b.js';"}),[]);
  assert.deepEqual(missing({...graph,'main.js':"import value,{missing as other} from './b.js';"}),[
    {from:'main.js',target:'b.js',name:'default',kind:'export',resolution:'unresolved'},
    {from:'main.js',target:'b.js',name:'missing',kind:'export',resolution:'unresolved'}]);
});

test('quoted external names and destructuring exports are resolved without rewriting original ASTs',()=>{
  assert.deepEqual(missing({
    'leaf.js':`const value=1;export {value as '',value as 'not-an-identifier',value as '__proto__'};
      export const {x:nested,...rest}={x:1,y:2};export let [first,,...tail]=[1,2,3];`,
    'barrel.js':"export {'not-an-identifier' as 'renamed!',nested,rest,first,tail} from './leaf.js';",
    'main.js':"import {'' as empty,'__proto__' as proto} from './leaf.js';"+
      "import {'renamed!' as renamed,nested,rest,first,tail} from './barrel.js';"
  }),[]);
});

test('explicit exports override conflicting stars while unused named failures remain errors',()=>{
  const graph={
    'a.js':'export const x=1;',
    'b.js':'export const x=2;',
    'barrel.js':"export * from './a.js';export * from './b.js';export {x} from './a.js';"
  };
  assert.deepEqual(missing({...graph,'main.js':"import {x} from './barrel.js';"}),[]);
  assert.deepEqual(missing({...graph,'main.js':"export {missing} from './a.js';"}),[
    {from:'main.js',target:'a.js',name:'missing',kind:'export',resolution:'unresolved'}]);
});
