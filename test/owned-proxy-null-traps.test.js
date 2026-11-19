import test from 'node:test';
import {runtimeDifferential} from './helpers/runtime-frontier.js';

test('null and undefined Proxy get/set traps both forward through the live target',()=>{
  for(const empty of ['null','undefined'])runtimeDifferential('const target={x:2};const handler={get:'+empty+',set:'+empty+'};'+
    'const proxy=new Proxy(target,handler);const before=proxy.x;target.x=4;const middle=proxy.x;proxy.x=7;return [before,middle,target.x,proxy.x];');
  runtimeDifferential('const target={x:2};const inherited={get:null,set:null};const handler=Object.create(inherited);'+
    'const proxy=new Proxy(target,handler);proxy.x=5;return [proxy.x,target.x];');
});

test('Proxy routing rereads live trap values and preserves genuine guest trap calls',()=>{
  runtimeDifferential('let calls=0;const target={x:2};const handler={get:function(t,k,r){calls++;return t[k]+1;},'+
    'set:function(t,k,v,r){calls++;t[k]=v+1;return true;}};const proxy=new Proxy(target,handler);'+
    'const first=proxy.x;handler.get=null;const second=proxy.x;proxy.x=4;handler.set=null;proxy.x=8;return [first,second,target.x,calls];');
});
