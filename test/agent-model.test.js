import test from 'node:test';
import assert from 'node:assert/strict';
import {executeBoundedAgents,verifyBoundedAgents} from '../src/agent-model.js';
const b=(initial=[0])=>[{id:'mem',length:initial.length,initial}];
const s=(op,value={})=>({op,buffer:'mem',index:0,...value});
test('two virtual agents increment shared Int32 cells in round-robin order',()=>{
 const x=executeBoundedAgents({buffers:b(),agents:[
  {id:'alpha',steps:[s('add',{value:1}),s('add',{value:1})]},
  {id:'beta',steps:[s('add',{value:1}),s('load')]}]});
 assert.equal(x.status,'terminated');assert.equal(x.buffers.mem[0],3);
 assert.deepEqual(x.events.map(e=>e.agentId),['alpha','beta','alpha','beta']);
 assert.equal(verifyBoundedAgents(x).valid,true);
});
test('wait and notify wake a blocked agent in FIFO order',()=>{
 const x=executeBoundedAgents({buffers:b(),agents:[
  {id:'worker',steps:[s('wait',{expected:0}),s('add',{value:3})]},
  {id:'main',steps:[s('store',{value:1}),s('notify',{count:1})]}]});
 assert.equal(x.status,'terminated');assert.equal(x.buffers.mem[0],4);
 assert.deepEqual(x.events.find(e=>e.op==='notify').wakes,['worker']);
 assert.equal(verifyBoundedAgents(x).valid,true);
});
test('virtual timer releases a suspended wait on quiescence',()=>{
 const x=executeBoundedAgents({buffers:b(),agents:[
  {id:'worker',steps:[s('wait',{expected:0,timeout:5}),s('load')]}]});
 assert.equal(x.virtualTime,5);assert.equal(x.status,'terminated');
 assert.equal(x.events[1].op,'wait.timeout');
 assert.equal(verifyBoundedAgents(x).valid,true);
});
test('indefinite virtual wait remains explicitly blocked',()=>{
 const x=executeBoundedAgents({buffers:b(),agents:[
  {id:'worker',steps:[s('wait',{expected:0})]}]});
 assert.equal(x.status,'blocked');assert.equal(verifyBoundedAgents(x).valid,true);
});
test('Int32 overflow and compareExchange retain old atomic values',()=>{
 const x=executeBoundedAgents({buffers:b([2147483647]),agents:[{id:'worker',steps:[
   s('add',{value:1}),s('compareExchange',{expected:-2147483648,replacement:8}),s('load')]}]});
 assert.equal(x.events[0].after,-2147483648);assert.equal(x.events[1].result,-2147483648);
 assert.equal(x.buffers.mem[0],8);assert.equal(verifyBoundedAgents(x).valid,true);
});
test('bad location, blocked forced turn and forged transcript fail closed',()=>{
 assert.throws(()=>executeBoundedAgents({buffers:b(),agents:[{id:'a',steps:[
   {op:'load',buffer:'mem',index:5}]}]}));
 assert.throws(()=>executeBoundedAgents({buffers:b(),agents:[{id:'a',steps:[
   s('wait',{expected:0})]}],schedule:['a','a']}));
 const x=executeBoundedAgents({buffers:b(),agents:[{id:'a',steps:[s('load')]}]});
 x.events[0].after=9;assert.throws(()=>verifyBoundedAgents(x));
});
