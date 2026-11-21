// Authored original-source controls. Expectations are bounded examples, not an
// admission receipt; source/native gates must freshly qualify each artifact.
const fixture=(id,body,expectedOwned,{expectedNative=expectedOwned,boundary=null}={})=>({
  id,source:'"use strict";function run(){'+body+'}',entry:'run',args:[],
  family:'primitive-conversion:'+id,fixture:{calls:[]},expectedOwned,expectedNative,boundary
});
export const PRIMITIVE_CONVERSION_FIXTURES=Object.freeze([
  fixture('key-read','let seen=0;const key={toString(){seen++;return "x";}};const object={x:7};return object[key]+seen;',8),
  fixture('key-getter','let seen=0;const key={get toString(){seen++;return function(){seen+=2;return "x";};}};return ({x:7})[key]+seen;',10),
  fixture('key-symbol-hook','let seen=0;const key={[Symbol.toPrimitive](hint){seen++;return hint==="string"?"x":"y";}};return ({x:7,y:20})[key]+seen;',8),
  fixture('key-fallback','let seen=0;const key={toString(){seen++;return {};},valueOf(){seen+=2;return "x";}};return ({x:7})[key]+seen;',10),
  fixture('key-live-fallback','let seen=0;const key={toString(){seen++;this.valueOf=function(){seen+=4;return "x";};return {};},valueOf(){return "y";}};return ({x:7,y:20})[key]+seen;',12),
  fixture('key-getter-throw','let seen=0;const key={get toString(){seen++;throw "boom";}};try{return ({x:7})[key];}catch(error){return seen+(error==="boom"?10:0);}',11),
  fixture('key-method-throw-identity','const token={value:8};const key={toString(){throw token;}};try{return ({x:7})[key];}catch(error){return error===token?8:0;}',8),
  fixture('key-noncallable','const key={[Symbol.toPrimitive]:7};try{return ({x:7})[key];}catch(error){return error.name;}','TypeError',{boundary:'intrinsic-error-source-metadata'}),
  fixture('key-exhaustion','const key={toString(){return {};},valueOf(){return {};}};try{return ({x:7})[key];}catch(error){return error.name;}','TypeError',{boundary:'intrinsic-error-source-metadata'}),
  fixture('key-number-nested','const key={toString(){return Number({valueOf(){return 7;}});}};return ({7:8})[key];',8),
  fixture('number-getter','let seen=0;const input={get valueOf(){seen++;return function(){seen+=2;return 5;};}};return Number(input)+seen;',8),
  fixture('number-existing','let seen=0;const input={valueOf(){seen++;return 7;}};return Number(input)+seen;',8),
  fixture('key-plain-write','let n=0;const key={toString(){n++;return n===1?"x":"y";}};const object={x:1,y:2};object[key]=(n+=10,3);return [n,object.x,object.y];',[11,1,3]),
  fixture('key-compound-divergence','let n=0;const key={toString(){n++;return n===1?"x":"y";}};const object={x:1,y:2};object[key]+=3;return [n,object.x,object.y];',[1,4,2],{expectedNative:[2,1,4],boundary:'node24-reference-disagreement'}),
  fixture('key-logical-divergence','let n=0;const key={toString(){n++;return n===1?"x":"y";}};const object={x:0,y:2};object[key]||=3;return [n,object.x,object.y];',[1,3,2],{expectedNative:[2,0,3],boundary:'node24-reference-disagreement'}),
  fixture('key-update-divergence','let n=0;const key={toString(){n++;return n===1?"x":"y";}};const object={x:1,y:2};object[key]++;return [n,object.x,object.y];',[1,2,2],{expectedNative:[2,1,2],boundary:'node24-reference-disagreement'})
]);
