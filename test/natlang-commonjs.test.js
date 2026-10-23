import test from 'node:test';
import assert from 'node:assert/strict';
import {lowerPureCommonJsModule} from '../src/natlang-commonjs.js';
import {createBoundedModuleFacade} from 'tracing-js-self/evaluated-module-facade';
import {replayExact} from 'tracing-js-self';

test('conservative CommonJS-to-owned-ESM lowering retains exported pure functions',()=>{
  const compiled='"use strict";Object.defineProperty(exports,"__esModule",{value:true});'+
    'exports.add=add;exports.read=read;'+
    'let forbidden=0;';
  assert.throws(()=>lowerPureCommonJsModule(compiled),/Unowned/);
  const source=lowerPureCommonJsModule('"use strict";'+
    'Object.defineProperty(exports,"__esModule",{value:true});'+
    'exports.add=add;function add(x){return x+3;}');
  assert.deepEqual(source.exportNames,['add']);
  const bundles=[];
  const f=createBoundedModuleFacade({modules:{'main.js':source.source},
    entryModule:'main.js',exportNames:source.exportNames,
    onTrace:bundle=>bundles.push(bundle)});
  try{
    assert.equal(f.exports.add(4),7);
    assert.equal(f.exports.add(8),11);
    assert.equal(bundles.length,2);
    for(const trace of bundles)assert.equal(replayExact(trace).valid,true);
  }finally{f.close();}
});

test('CJS bridge rejects source-time arbitrary host calls and suspicious exports',()=>{
  for(const source of [
    'const x=require("fs");exports.x=x;',
    'exports.fn=()=>3;',
    'globalThis.x=3;exports.fn=fn;function fn(){return 3;}',
    'exports.__proto__=fn;function fn(){return 3;}',
    'module.exports=fn;function fn(){return 3;}'
  ])assert.throws(()=>lowerPureCommonJsModule(source),/Unowned|Only registered/);
  const source=lowerPureCommonJsModule(
    'exports.fn=fn;function fn(){return require("fs");}');
  assert.throws(()=>createBoundedModuleFacade({modules:{'main.js':source.source},
    entryModule:'main.js',exportNames:source.exportNames}).exports.fn(),
    /unowned|Unbound|Unsupported|unbound/i);
});

test('failing retained trace hook does not commit module invocation',()=>{
  const source=lowerPureCommonJsModule('exports.fn=fn;function fn(){return 5;}');
  const facade=createBoundedModuleFacade({modules:{'main.js':source.source},
    entryModule:'main.js',exportNames:source.exportNames,
    onTrace:()=>{throw new Error('sink refused');}});
  try{
    assert.throws(()=>facade.exports.fn(),/sink refused/);
    assert.equal(facade.session.history.length,0);
  }finally{facade.close();}
});
