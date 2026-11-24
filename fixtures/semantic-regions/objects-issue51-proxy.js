// Original issue51 sources for retained Proxy selection and operation-derived faults.
// The complete sources are exported with the same frozen issue51 ancestry.
const fixture=(id,family,body)=>Object.freeze({
  id,family,source:'"use strict";function run(){'+body+'}',entry:'run',args:[]
});

export const issue51ProxyFixtures=Object.freeze([
  ...[['get','proxy.x'],['set','proxy.x=2'],['has','"x" in proxy'],['deleteProperty','delete proxy.x']]
    .map(([operation,expression])=>fixture('issue51-proxy-revoked-'+operation,'issue51-proxy-revocation',
      'const pair=Proxy.revocable({x:1},{});const proxy=pair.proxy;pair.revoke();try{'+expression+';}'+
      'catch(error){return [error.name,error.message,Object.getPrototypeOf(error)===TypeError.prototype];}')),
  fixture('issue51-proxy-revocable-revoke-idempotent','issue51-proxy-revocation',
    'const pair=Proxy.revocable({x:1},{});const proxy=pair.proxy;'+
    'pair.revoke();pair.revoke();let name="",message="";try{proxy.x;}catch(error){name=error.name;message=error.message;}'+
    'return [pair.revoke===pair.revoke,name,message];'),
  fixture('issue51-control-proxy-nested-target','issue51-unsupported-control',
    'const target=new Proxy({x:2},{});return new Proxy(target,{}).x;'),
  fixture('issue51-proxy-key-order-and-trap-replacement','issue51-proxy-has-delete',
    'let order="";const target={x:1},handler={};const key={get [Symbol.toPrimitive](){order+="g";'+
    'return function(hint){order+="c"+hint;return "x";};}};'+
    'handler.has=function(t,k){order+="h"+k;handler.has=null;delete t[k];return 0;};'+
    'handler.deleteProperty=function(t,k){order+="d"+k;return "yes";};'+
    'const proxy=new Proxy(target,handler);const present=key in proxy;const deleted=delete proxy[key];'+
    'return [present,deleted,order,target.x,handler.has];'),
  fixture('issue51-proxy-constructor-arrow-retains-private-receiver','issue51-proxy-construction-composition',
    "class A{};class D extends A{#x=5;constructor(){const has=(t,k)=>"+
    "this.#x===5&&new.target===D&&k==='x';super();return {has};}}"+
    "const handler=new D();const proxy=new Proxy({x:1},handler);return 'x' in proxy;"),
  fixture('issue51-proxy-strict-false-delete-error','issue51-proxy-intrinsic-error',
    'const proxy=new Proxy({}, {deleteProperty:function(){return false;}});'+
    'try{delete proxy.x;return "none";}catch(error){return [error.name,error.message];}'),
  fixture('issue51-proxy-strict-false-set-error','issue51-proxy-intrinsic-error',
    'let calls=0;const target={x:2},handler={set:function(){calls++;return false;}};'+
    'const proxy=new Proxy(target,handler);try{proxy.x=7;return ["missed",calls,target.x];}'+
    'catch(error){return [error.name,error.message,calls,target.x];}'),
  fixture('issue51-control-proxy-strict-false-set','issue51-unsupported-control',
    'const proxy=new Proxy({x:2},{set:function(){return false;}});proxy.x=7;return 1;'),
  fixture('issue51-proxy-strict-transparent-delete-error','issue51-proxy-intrinsic-error',
    'const target={};Object.defineProperty(target,"x",{value:1,configurable:false});const proxy=new Proxy(target,{});'+
    'try{delete proxy.x;return "none";}catch(error){return [error.name,error.message];}'),
  fixture('issue51-proxy-has-protected-property-error','issue51-proxy-intrinsic-error',
    'const target={};Object.defineProperty(target,"x",{value:1,configurable:false});'+
    'const proxy=new Proxy(target,{has:function(){return false;}});'+
    'try{return "x" in proxy;}catch(error){return [error.name,error.message];}'),
  fixture('issue51-proxy-has-nonextensible-error','issue51-proxy-intrinsic-error',
    'const target={x:1};Object.preventExtensions(target);const proxy=new Proxy(target,{has:function(){return false;}});'+
    'try{return "x" in proxy;}catch(error){return error.message;}'),
  fixture('issue51-proxy-delete-nonextensible-error','issue51-proxy-intrinsic-error',
    'const target={x:1};Object.preventExtensions(target);'+
    'const proxy=new Proxy(target,{deleteProperty:function(){return true;}});'+
    'try{delete proxy.x;return "none";}catch(error){return error.message;}'),
  fixture('issue51-proxy-trap-throw-retains-identity','issue51-proxy-has-delete',
    'const reason={tag:7};const proxy=new Proxy({}, {has:function(){throw reason;}});'+
    'try{return "x" in proxy;}catch(error){return error===reason;}'),
  fixture('issue51-proxy-has-checks-late-protection','issue51-proxy-late-invariants',
    'const target={x:1};let calls=0;const proxy=new Proxy(target,{has:function(t,k){calls++;'+
    'Object.defineProperty(t,k,{configurable:false});return false;}});'+
    'try{return "x" in proxy;}catch(error){return [error.name,error.message,calls,"x" in target];}'),
  fixture('issue51-proxy-delete-checks-late-extensibility','issue51-proxy-late-invariants',
    'const target={x:1};let calls=0;const proxy=new Proxy(target,{deleteProperty:function(t,k){calls++;'+
    'Object.preventExtensions(t);return true;}});'+
    'try{delete proxy.x;return "none";}catch(error){return [error.name,error.message,calls,"x" in target];}'),
  fixture('issue51-proxy-delete-uses-live-absence','issue51-proxy-late-invariants',
    'const target={x:1};let calls=0;const proxy=new Proxy(target,{deleteProperty:function(t,k){calls++;'+
    'delete t[k];Object.preventExtensions(t);return true;}});'+
    'return [delete proxy.x,calls,"x" in target];')
]);

export const issue51ProxyUnsupportedControls=Object.freeze([
  fixture('issue51-control-proxy-trap-getter','issue51-unsupported-control',
    'const proxy=new Proxy({x:1},{get has(){return function(){return true;};}});return "x" in proxy;')
]);
