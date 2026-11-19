import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import {verifyOwnedSourceCase} from '../src/training/source-check.js';
import {independentEffectfulReference,verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
import {ownedCompletionObservations,compareCompletionObservations} from '../src/training/completion-reference.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';

test('iterator acquisition preserves receiver and caches next once',()=>{
  runtimeDifferential('let calls=0,gets=0;const out=[];let next=function(){this.next=()=>{throw 9;};return {done:this.i===3,value:this.i++};};const it={i:0,get next(){gets++;return next;},set next(value){next=value;}};const xs={[Symbol.iterator](){calls++;return it;}};for(const n of xs)out.push(n);return [calls,gets,out];');
  runtimeDifferential('const a=[1,2];a[Symbol.iterator]=function(){let done=false;return {next(){const result={done:done,value:9};done=true;return result;}};};const out=[];for(const x of a)out.push(x);return out;');
});
test('ordinary and builtin iterators preserve live reads holes codepoints and completion',()=>{
  runtimeDifferential('const a=[,2];const it=a.values();const first=it.next();a.push(3);return [first,it.next(),it.next(),it.next(),it.next()];');
  runtimeDifferential('const out=[];for(const char of "a😀b")out.push(char);return [out,[8,9].keys().next(),[8,9].entries().next()];');
  const r=verifyOwnedSourceCase({source:'"use strict";function run(){let out=[];for(const {n=4,...rest} of [{n:2,x:3},{}])out.push([n,rest]);for(var [a,...tail] of [[7,8,9]])out.push([a,tail]);return out;}',entry:'run',maxGenerated:8192});
  assert.equal(r.status,'locally_verified',r.reason);
  runtimeDifferential('let x=[1];try{for(let x of x){}}catch(e){return e.name;}',{source:'"use strict";function run(){let x=[1];try{for(let x of x){}}catch(e){return e.name;}}'});
});
test('builtin iterator own methods and values shadow intrinsics with their original receiver',()=>{
  runtimeDifferential('const it=[1].values();it.next=function(){return {value:this.extra,done:false};};it.extra=9;return [it.next(),it.extra];');
  runtimeDifferential('const it="ab"[Symbol.iterator]();it.next=undefined;it[Symbol.iterator]=function(){return this;};let error;try{it[Symbol.toStringTag]="custom";}catch(e){error=e.name;}return [it.next,it[Symbol.iterator]()===it,it[Symbol.toStringTag],error];');
  runtimeDifferential('const it=[1].values();it.next=3;let error;try{it.next();}catch(e){error=e.name;}return [it.next,error];');
  runtimeDifferential('const it=[1].values();let calls=0;it.next=function(){calls++;this.next=()=>{throw 9;};return {done:calls===3,value:calls};};const out=[];for(const value of it)out.push(value);return [out,calls];');
});
test('break return and nested labelled exits close active iterators once',()=>{
  runtimeDifferential('let out=[];function make(name){let i=0;return {[Symbol.iterator](){return this;},next(){return {done:false,value:i++};},return(){out.push(name);return {};}};}outer:for(const a of make("outer")){for(const b of make("inner")){out.push([a,b]);break outer;}}return out;');
  runtimeDifferential('let out=[];const it={[Symbol.iterator](){return this;},next(){return {done:false,value:1};},return(){out.push("close");return {};}};function f(){for(const x of it){try{return 3;}finally{out.push("finally");}}}return [f(),out];');
  runtimeDifferential('let out=[];const it={[Symbol.iterator](){return this;},i:0,next(){return {done:this.i===3,value:this.i++};},return(){out.push("close");return {};}};for(const x of it){if(x<2)continue;out.push(x);}return out;');
});
test('IteratorClose preserves throw precedence but replaces break with cleanup failure',()=>{
  for(const abrupt of ['throw 7;','break;'])for(const cleanup of [
    'return(){throw 9;}', 'get return(){throw 9;}', 'return(){return 9;}', 'return:3'
  ])runtimeDifferential('const it={[Symbol.iterator](){return this;},next(){return {done:false,value:1};},'+cleanup+'};try{for(const v of it){'+abrupt+'}}catch(e){return typeof e==="object"?e.name:e;}');
  runtimeDifferential('const it={[Symbol.iterator](){return this;},next(){return {done:false,value:1};},return:null};for(const v of it)break;return 5;');
});
test('failed iterator next done and value do not spuriously call return',()=>{
  for(const step of ['throw 7;','return 3;','return {get done(){throw 7;}};','return {done:false,get value(){throw 7;}};'])
    runtimeDifferential('let closed=0;const it={[Symbol.iterator](){return this;},next(){'+step+'},return(){closed++;return {};}};try{for(const x of it){}}catch(e){return [closed,typeof e==="object"?e.name:e];}');
});
test('custom iterator source completion receipts independently agree before public refusal',async()=>{
  const body='let out=[];const it={[Symbol.iterator](){return this;},i:0,next(){return {done:false,value:this.i++};},return(){out.push("close");return {};}};for(const x of it){out.push(x);if(x===1)break;}return out;';
  const source='"use strict";function run(){'+body+'}',{bundle}=runtimeDifferential(body,{source});
  const reference=await independentEffectfulReference({source,entry:'run',inputGraph:encodeNativeGraph([]),fixture:{calls:[]},mode:'completions'});
  const receipt=compareCompletionObservations(ownedCompletionObservations(bundle,source),reference.completions);
  assert.equal(receipt.status,'agreed',JSON.stringify(receipt));
  const admission=await verifyEffectfulTrainingCase({source,entry:'run',family:'custom-iterator',fixture:{calls:[]}});
  assert.equal(admission.status,'projection_refused');
});
