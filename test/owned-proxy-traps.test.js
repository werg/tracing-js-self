import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeDifferential} from './helpers/runtime-frontier.js';

test('Proxy set trap false results throw in strict callers after the callback completes',()=>{
  for(const returned of ['false','0','-0','NaN','""','null','undefined','0n']){
    const body='let calls=0;const target={x:1};const proxy=new Proxy(target,{set:function(t,k,v,r){calls++;return '+returned+';}});'+
      'let caught="none";try{proxy.x=2;}catch(e){caught=e.name;}return [caught,calls,target.x];';
    const {bundle}=runtimeDifferential(body);
    assert(Object.values(bundle.finalState.frames).every(frame=>frame.completion.type==='return'));
  }
  runtimeDifferential('const target={x:1};const proxy=new Proxy(target,{set:function(){return {};}});'+
    'const result=(proxy.x=2);return [result,target.x];');
});

test('strict false Proxy set preserves the native caller message and loose assignment value',()=>{
  runtimeDifferential('\"use strict\";const proxy=new Proxy({}, {set:function(){return false;}});'+
    'try{proxy.x=1;return "missed";}catch(error){return error.message;}');
  runtimeDifferential('\"use strict\";const key=\"\\u0000x\";const proxy=new Proxy({}, {set:function(){return false;}});'+
    'try{proxy[key]=1;return "missed";}catch(error){return error.message;}');
  runtimeDifferential('\"use strict\";const key=Symbol(\"x\");const proxy=new Proxy({}, {set:function(){return false;}});'+
    'try{proxy[key]=1;return "missed";}catch(error){return error.message;}');
  runtimeDifferential('const proxy=new Proxy({}, {set:function(){return false;}});'+
    'const assigned=(proxy.x=7);return [assigned,Object.hasOwn(proxy,"x")];');
});

test('Proxy get and set invariants preserve frozen target data and actual reference identities',()=>{
  runtimeDifferential('function check(target){const proxy=new Proxy(target,{get:function(t,k){return t[k];},'+
    'set:function(){return true;}});const first=proxy[0];proxy[0]="fixed";return [first,proxy.raw===target.raw];}return check`fixed`;');
  for(const operation of ['return proxy[0];','proxy[0]="changed";return "missed";','return proxy.raw;']){
    runtimeDifferential('function check(target){let calls=0;const proxy=new Proxy(target,{'+
      'get:function(t,k){calls++;return k==="raw"?[]:"changed";},set:function(){calls++;return true;}});'+
      'try{'+operation+'}catch(e){return [e.name,calls];}}return check`fixed`;');
  }
});

test('Proxy invariants inspect live target descriptors after callback finally completion',()=>{
  runtimeDifferential('let order="";const target={x:1};const proxy=new Proxy(target,{get:function(t,k){'+
    'try{Object.defineProperty(t,k,{get:undefined,configurable:false});return 2;}'+
    'catch(e){order+="wrong";return 3;}finally{order+="trap";}}});'+
    'try{proxy.x;}catch(e){order+=e.name;}finally{order+="caller";}return order;');
  runtimeDifferential('let order="";const target={x:1};const proxy=new Proxy(target,{set:function(t,k){'+
    'Object.defineProperty(t,k,{set:undefined,configurable:false});order+="trap";return true;}});'+
    'try{proxy.x=2;}catch(e){order+=e.name;}return order;');
  runtimeDifferential('const target={};Object.defineProperty(target,"x",{get:undefined,set:undefined,configurable:false});'+
    'const proxy=new Proxy(target,{get:function(){return undefined;},set:function(){return false;}});return proxy.x;');
});
