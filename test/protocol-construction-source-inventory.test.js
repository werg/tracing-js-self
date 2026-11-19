import test from 'node:test';
import assert from 'node:assert/strict';
import {constructionSourceInventoryV8,hasConstructionSourceCallableV8}
  from '../src/semantic/protocol-construction-source-inventory-v8.js';

test('synthetic constructor and initializer identities require exact source definitions',()=>{
  const source='"use strict";function run(){class A{#m(){} x=1;static #n(){} static {this.x=2;}}class B extends A{constructor(){super();}}return B;}',
    inventory=constructionSourceInventoryV8(source),[a,b]=inventory.classes;
  assert.deepEqual([...inventory.synthetic.keys()],[`class:${a.node.start}:constructor`,`class:${a.node.start}:instance`,`class:${a.node.start}:static`]);
  for(const code of inventory.synthetic.keys())assert.equal(hasConstructionSourceCallableV8(source,code),true);
  for(const code of [`class:${b.node.start}:constructor`,`class:${b.node.start}:instance`,`class:${b.node.start}:static`,
    `class:0${a.node.start}:constructor`,`class:${a.node.start}:body`,'class:0:constructor','function:'+a.node.start])
    assert.equal(hasConstructionSourceCallableV8(source,code),false,code);
  assert.equal(hasConstructionSourceCallableV8('syntax {','class:0:constructor'),false);
});

test('private accessors cannot masquerade as supported private initializer definitions',()=>{
  const source='class A{get #x(){return 1;}set #x(v){} x=1;}',inventory=constructionSourceInventoryV8(source);
  assert.equal(inventory.synthetic.size,0);
  assert.equal(hasConstructionSourceCallableV8(source,'class:0:constructor'),false);
  assert.equal(hasConstructionSourceCallableV8(source,'class:0:instance'),false);
});
