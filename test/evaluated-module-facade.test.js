import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoundedModuleFacade} from 'tracing-js-self/evaluated-module-facade';
import {replayExact} from 'tracing-js-self';

const modules={'main.ts':`
  export let n=1;
  export function add(x:number){n+=x;return n;}
  export function read(){return n;}
  export function fail(){throw 'bad';}
`};

test('host JS facade calls real owned exports with shared replay-backed module cells',()=>{
  const facade=createBoundedModuleFacade({modules,entryModule:'main.ts',
    exportNames:['add','read','fail']});
  try{
    const add=facade.exports.add,read=facade.exports.read;
    assert.equal(add(3),4);
    assert.equal(read(),4);
    assert.equal(add(5),9);
    assert.equal(read(),9);
    assert.equal(facade.session.history.length,4);
    assert.equal(replayExact(facade.session.lastArchive).valid,true);
    const checkpoint=facade.session.snapshot();
    assert.equal(checkpoint.calls.length,4);
    assert.throws(()=>facade.exports.fail(),/Owned module evaluation rejected/);
    assert.equal(facade.session.history.length,4);
    assert(Object.isFrozen(facade.exports));
  }finally{facade.close();}
  assert.throws(()=>facade.exports.read(),/closed/);
});

test('facade refuses unowned argument callbacks and hostile export-name metadata',()=>{
  const facade=createBoundedModuleFacade({modules,entryModule:'main.ts',
    exportNames:['add']});
  try{
    assert.throws(()=>facade.exports.add(()=>1),/primitive data/);
    assert.equal(facade.session.history.length,0);
  }finally{facade.close();}
  for(const exportNames of [
    ['__proto__'],['constructor'],['then'],['read','read'],
    ['r ead'],[],['add',42]
  ])assert.throws(()=>createBoundedModuleFacade({
    modules,entryModule:'main.ts',exportNames
  }),/export/);
  const names=['read'];
  Object.defineProperty(names,'0',{get(){throw new Error('host getter fired');}});
  assert.throws(()=>createBoundedModuleFacade({
    modules,entryModule:'main.ts',exportNames:names
  }),/export/);
});
