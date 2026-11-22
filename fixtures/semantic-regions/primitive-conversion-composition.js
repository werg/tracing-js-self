// Cross-feature source inputs for the registered conversion continuation. These
// complement, rather than replace or reclassify, the original sixteen controls.
const fixture=(id,body,expectedOwned)=>({id,source:'"use strict";function run(){'+body+'}',entry:'run',args:[],
  family:'primitive-conversion:'+id,fixture:{calls:[]},expectedOwned,expectedNative:expectedOwned,boundary:null});
export const PRIMITIVE_CONVERSION_COMPOSITION_FIXTURES=Object.freeze([
  fixture('getter-replacement','let log="";const key={get [Symbol.toPrimitive](){log+="g";'+
    'Object.defineProperty(this,Symbol.toPrimitive,{value(){log+="wrong";return "y";}});'+
    'return function(hint){log+=hint;return "x";};}};return ({x:3,y:9}[key])+log;','3gstring'),
  fixture('write-reference-order','let log="";const first={x:0},second={x:9};let current=first;'+
    'const key={toString(){log+="k";return "x";}};function base(){log+="b";return current;}'+
    'function property(){log+="p";return key;}function rhs(){log+="r";current=second;return 4;}'+
    'base()[property()]=rhs();return first.x+":"+second.x+":"+log;','4:9:bprk'),
  fixture('nested-goals','const inner={get valueOf(){return ()=>3;}};'+
    'const key={get toString(){const n=Number(inner);return ()=>"x"+n;}};return {x3:9}[key];',9),
  fixture('computed-class-key','let calls=0;const key={toString(){calls++;return "m";}};'+
    'class C{[key](){return 3;}}return new C().m()+calls;',4),
  fixture('caught-getter-finally','const error={};let log="";'+
    'const key={get [Symbol.toPrimitive](){log+="g";throw error;}};'+
    'try{try{({})[key];}finally{log+="f";}}catch(e){return (e===error)+":"+log;}','true:gf'),
  fixture('promise-key','const key={toString:function(){return "x";}};'+
    'return new Promise(function(resolve){resolve({x:4}[key]);}).then(function(value){return value+1;});',5),
  fixture('mapped-key','const key={toString(){return "x";}};'+
    'return [1,2].map(function(value){return {x:value}[key];})[1];',2),
  fixture('builtin-key-leaves','return {"[object Object]":2}[{}]+{"1,2":3}[[1,2]]+{"":4}[[]]+Number([3]);',12)
]);
