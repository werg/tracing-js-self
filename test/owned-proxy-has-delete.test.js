import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeDifferential} from './helpers/runtime-frontier.js';

test('Proxy has calls preserve selected trap identity and reflect callback target mutations',()=>{
  runtimeDifferential('const target={x:1};Object.preventExtensions(target);let calls=0;const handler={};'+
    'const proxy=new Proxy(target,handler);handler.has=function(t,k){calls++;handler.has=null;delete t[k];return 0;};'+
    'const absent="x" in proxy;return [absent,target.x,calls,handler.has===null];');
});

test('Proxy has invariants inspect the target after the trap returns and thrown trap values preserve identity',()=>{
  runtimeDifferential('const target={};Object.defineProperty(target,"x",{value:1,configurable:false});'+
    'const proxy=new Proxy(target,{has:function(){return false;}});try{return "x" in proxy;}catch(error){return error.name;}');
  runtimeDifferential('const reason={};const proxy=new Proxy({}, {has:function(){throw reason;}});'+
    'try{return "x" in proxy;}catch(error){return error===reason;}');
});

test('Proxy delete forwards to the target and enforces non-configurable and non-extensible invariants',()=>{
  runtimeDifferential('const target={x:1};const proxy=new Proxy(target,{});const deleted=delete proxy.x;'+
    'return [deleted,target.x];');
  runtimeDifferential('const target={};Object.defineProperty(target,"x",{value:1,configurable:false});'+
    'const proxy=new Proxy(target,{deleteProperty:function(t,k){return 1;}});'+
    'try{delete proxy.x;return "no error";}catch(error){return error.name;}');
  runtimeDifferential('const target={x:1};Object.preventExtensions(target);'+
    'const proxy=new Proxy(target,{deleteProperty:function(){return true;}});'+
    'try{delete proxy.x;return "no error";}catch(error){return error.name;}');
});

test('Proxy delete false results become strict delete TypeErrors while missing own properties may be reported deleted',()=>{
  runtimeDifferential('const proxy=new Proxy({}, {deleteProperty:function(){return false;}});'+
    'try{delete proxy.x;return "no error";}catch(error){return error.name;}');
  runtimeDifferential('const proxy=new Proxy({}, {deleteProperty:function(){return "yes";}});'+
    'return delete proxy.x;');
});

test('Proxy has/delete convert an object key before selecting the retained trap exactly once',()=>{
  runtimeDifferential('let order="";const target={};const key={get [Symbol.toPrimitive](){order+="g";'+
    'return function(hint){order+="c"+hint;return "x";};}};const proxy=new Proxy(target,{has:function(t,k){'+
    'order+="h"+k;return true;}});const found=key in proxy;return [found,order];');
  runtimeDifferential('let order="";const target={x:1};const key={get [Symbol.toPrimitive](){order+="g";'+
    'return function(hint){order+="c"+hint;return "x";};}};const proxy=new Proxy(target,{deleteProperty:function(t,k){'+
    'order+="d"+k;return true;}});const deleted=delete proxy[key];return [deleted,target.x,order];');
});

test('strict Proxy delete reports V8 trap-false message using the converted property key',()=>{
  runtimeDifferential('const key={ [Symbol.toPrimitive](hint){return "\u0000x";} };'+
    'const proxy=new Proxy({}, {deleteProperty:function(){return false;}});'+
    'try{delete proxy[key];return "no error";}catch(error){return error.message;}');
  runtimeDifferential('const key=Symbol("x");const proxy=new Proxy({}, {deleteProperty:function(){return false;}});'+
    'try{delete proxy[key];return "no error";}catch(error){return error.message;}');
});


test('strict direct Proxy delete faults preserve native TypeError message',()=>{
  runtimeDifferential('const target={};Object.defineProperty(target,"x",{value:1,configurable:false});'+
    'const proxy=new Proxy(target,{});try{delete proxy.x;return "no error";}catch(error){return error.message;}');
});

test('Proxy delete retains a selected trap through handler mutation and checks target state after return',()=>{
  runtimeDifferential('const target={x:1},handler={};handler.deleteProperty=function(t,k){'+
    'handler.deleteProperty=0;delete t[k];return true;};const proxy=new Proxy(target,handler);'+
    'const deleted=delete proxy.x;return [deleted,target.x,handler.deleteProperty];');
});

test('a pre-existing caught object is not mistaken for a new Proxy invariant fault',()=>{
  runtimeDifferential('const reason={};try{throw reason;}catch(caught){'+
    'const proxy=new Proxy({}, {has:function(){return true;}});'+
    'const present="x" in proxy;return [present,caught===reason];}');
});

test('Proxy has retains an arrow trap constructor lexical receiver',()=>{
  runtimeDifferential('function Holder(){this.marker=17;const handler={has:()=>this.marker===17};'+
    'this.proxy=new Proxy({},handler);}const holder=new Holder();return "x" in holder.proxy;');
});
