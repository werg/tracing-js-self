// Authored source cases exercise language-created iterator helpers together
// with ordinary calls, Promise jobs, getters, and retained cleanup scopes.
// They carry no native admission or learned-model claim by themselves.
export const ASYNC_ITERATION_FIXTURES_V8=[
  ['source-async-iterator-array',
    'async function run(){let sum=0;for await(const value of [1,Promise.resolve(2)])sum+=value;return sum;}',3],
  ['source-async-iterator-getters',
    'async function run(){let log="";const it={get next(){log+="n";return function(){log+=this===it?"c":"X";return {done:false,value:Promise.resolve(2)};};},get return(){log+="r";return function(){log+=this===it?"e":"X";return {done:true,value:Promise.resolve(4)};};}};'+
    'const iterable={get [Symbol.asyncIterator](){log+="a";return null;},get [Symbol.iterator](){log+="s";return function(){log+=this===iterable?"i":"X";return it;};}};'+
    'for await(const value of iterable){log+=value;break;}return log;}','asinc2re'],
  ['source-async-iterator-value-identity',
    'async function run(){const value=Promise.resolve(2);const it={[Symbol.asyncIterator](){return this;},next(){return {done:false,value};}};'+
    'for await(const found of it)return found===value;}',true],
  ['source-async-iterator-throw-precedence',
    'async function run(){let log="";const it={[Symbol.asyncIterator](){return this;},next(){return {done:false,value:1};},async return(){log+="r";await 0;log+="e";throw 9;}};'+
    'try{for await(const value of it){try{throw 7;}finally{await 0;log+="f";}}}catch(error){return log+error;}}','fre7'],
  ['source-async-iterator-return-replaced',
    'async function run(){let log="";const it={[Symbol.asyncIterator](){return this;},next(){return {done:false,value:1};},async return(){await 0;log+="c";throw 9;}};'+
    'async function body(){for await(const value of it)return 7;}try{return await body();}catch(error){return log+error;}}','c9'],
  ['source-async-iterator-sync-rejection',
    'async function run(){let log="";const it={[Symbol.iterator](){return this;},next(){return {done:false,value:Promise.reject(7)};},return(){log+="c";throw 9;}};'+
    'try{for await(const value of it)log+="wrong";}catch(error){return log+error;}}','c7'],
  ['source-async-iterator-sibling-cleanup',
    'async function run(){let log="";async function child(name){try{for await(const value of [1])return name;}finally{await 0;log+=name;}}'+
    'const first=child("a"),second=child("b");return (await first)+(await second)+log;}','abab'],
  ['source-async-iterator-idle-completion',
    'function run(){async function child(){for await(const value of [1]){try{return value;}finally{await 0;}}}child();child();return 17;}',17]
].map(([id,body,expected])=>({id,source:'"use strict";'+body,entry:'run',args:[],family:'async-iteration-source',expected}));
