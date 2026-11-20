import test from 'node:test';
import {runtimeDifferential} from './helpers/runtime-frontier.js';

test('array bindings use custom iteration, original receivers, cached next and early close',()=>{
  runtimeDifferential('let log="";const it={[Symbol.iterator](){log+="a";return this;},get next(){log+="g";return function(){log+="n";return {done:false,value:3};};},return(){log+="c";return {};}};const [first]=it;return [first,log];');
  runtimeDifferential('let log="";const it={[Symbol.iterator](){log+="a";return this;},get next(){log+="g";return function(){throw 7;};},return(){log+="c";return {};}};const []=it;return log;');
  runtimeDifferential('const a=[1];a[Symbol.iterator]=function(){let done=false;return {next(){const r={done,value:9};done=true;return r;}};};const [first]=a;return first;');
  runtimeDifferential('let gets=0,calls=0,closed=0;let next=function(){calls++;this.next=()=>{throw 99;};return {done:false,value:this.mark+calls};};const it={mark:10,get next(){gets++;return next;},set next(v){next=v;},[Symbol.iterator](){return this;},return(){closed++;return {};}};const [a,b]=it;return [a,b,gets,calls,closed];');
  runtimeDifferential('const [first,...tail]="a😀b";return [first,tail];');
});

test('elisions advance without reading values and completed iterators never revive',()=>{
  runtimeDifferential('let log="";let i=0;const it={[Symbol.iterator](){return this;},next(){log+="n";return {get done(){log+="d";return false;},get value(){log+="v";return ++i;}};},return(){log+="c";return {};}};const [,second]=it;return [second,log];');
  runtimeDifferential('const a=[];const [first=(a.push(1,2),0),second=5]=a;return [first,second,a];');
  runtimeDifferential('const a=[undefined];const [first=(a.push(2),1),second,...tail]=a;return [first,second,tail];');
  runtimeDifferential('let calls=0,closed=0;const it={[Symbol.iterator](){return this;},next(){calls++;return {done:true,get value(){throw 9;}};},return(){closed++;return {};}};const [first=3,second=4,...tail]=it;return [first,second,tail,calls,closed];');
});

test('destructuring assignment evaluates each reference before next and retains the right-hand identity',()=>{
  runtimeDifferential('let log="";const target={};function object(){log+="o";return target;}function key(){log+="k";return "x";}const it={[Symbol.iterator](){log+="a";return this;},get next(){log+="g";return function(){log+="n";return {done:false,get value(){log+="v";return 3;}};};},return(){log+="c";return {};}};const same=([object()[key()]]=it);return [target.x,log,same===it];');
  runtimeDifferential('const a={},b={};let target=a;const it={[Symbol.iterator](){return this;},next(){target=b;return {done:false,value:3};},return(){return {};}};[target.x]=it;return [a.x,b.x];');
  runtimeDifferential('let log="";const target={};function key(){log+="k";return "x";}const it={i:0,[Symbol.iterator](){return this;},next(){log+="n";return {done:this.i++===2,value:3};},return(){log+="wrong";return {};}};[...target[key()]]=it;return [target.x,log];');
  runtimeDifferential('let log="";function fail(){log+="f";throw 7;}const it={[Symbol.iterator](){return this;},next(){log+="wrong";return {done:false,value:3};},return(){log+="c";return {};}};try{[fail().x]=it;}catch(e){return log+e;}');
  runtimeDifferential('let calls=0,closed=0;const it={[Symbol.iterator](){return this;},next(){calls++;return {done:false,value:3};},return(){closed++;return {};}};const target=null;try{[target.x]=it;}catch(e){return [calls,closed,e.name];}');
});

test('binding failures close active iterators and preserve throw over cleanup failures',()=>{
  for(const cleanup of ['return(){throw 9;}','get return(){throw 9;}','return(){return 9;}','return:3']){
    runtimeDifferential('function fail(){throw 7;}const it={[Symbol.iterator](){return this;},next(){return {done:false,value:undefined};},'+cleanup+'};try{const [first=fail()]=it;}catch(e){return typeof e==="object"?e.name:e;}');
    runtimeDifferential('const it={[Symbol.iterator](){return this;},next(){return {done:false,value:1};},'+cleanup+'};try{const [first]=it;}catch(e){return typeof e==="object"?e.name:e;}');
  }
  runtimeDifferential('let log="";function make(name,value){return {[Symbol.iterator](){return this;},next(){return {done:false,value};},return(){log+=name;return {};}};}const [[first]]=make("o",make("i",3));return [first,log];');
});

test('next, done and value failures complete the record without closing it',()=>{
  for(const next of ['throw 7;','return 3;','return {get done(){throw 7;}};','return {done:false,get value(){throw 7;}};'])
    runtimeDifferential('let closed=0;const it={[Symbol.iterator](){return this;},next(){'+next+'},return(){closed++;return {};}};try{const [first]=it;}catch(e){return [closed,typeof e==="object"?e.name:e];}');
});
