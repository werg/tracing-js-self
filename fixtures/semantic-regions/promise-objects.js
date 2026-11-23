// Ordinary source controls for the Promise object slice. The original Test262
// campaign is retained separately, with its unchanged source and harness bytes.
const cases=[
  ['data-descriptor-reflection',`const p=Promise.resolve(4);Object.defineProperty(p,"x",{value:7,writable:true,configurable:true});
    const d=Object.getOwnPropertyDescriptor(p,"x");return p.x===7&&d.value===7&&d.writable&&!d.enumerable&&d.configurable;`,true],
  ['accessor-alias-receiver',`const p=Promise.resolve(4),other=Promise.resolve(8),alias=p;
    Object.defineProperty(alias,"x",{get(){return this===p?7:9;},configurable:true});return p.x;`,7],
  ['accessor-setter',`const p=Promise.resolve(4);let x=0;Object.defineProperty(p,"x",{get(){return x;},set(v){x=v;}});p.x=7;return p.x;`,7],
  ['prototype-identity',`const p=Promise.resolve(4);return Object.getPrototypeOf(p)===Promise.prototype;`,true],
  ['constructor-resolve-reentry',`let log="";const p=Promise.resolve(7);
    Object.defineProperty(p,"constructor",{get(){log+="g";Promise.resolve(2);return Promise;},configurable:true});
    const q=Promise.resolve(p);return log+(q===p);`,'gtrue'],
  ['constructor-await',`let log="";const p=Promise.resolve(7);
    Object.defineProperty(p,"constructor",{get(){log+="g";return Promise;},configurable:true});
    const value=await p;return log+value;`,'g7'],
  ['constructor-await-job-order',`let log='';const p=Promise.resolve(1);Object.defineProperty(p,'constructor',{get(){log+='g';return Promise;}});Promise.resolve().then(()=>{log+='q';});await p;return log;`,'gq'],
  ['constructor-reaction',`let log="";const p=Promise.resolve(7);
    Object.defineProperty(p,"constructor",{get(){log+="g";return Promise;},configurable:true});
    const q=p.then(value=>value+1);return log+(await q);`,'g8'],
  ['constructor-throw-cleanup',`let log="";const p=Promise.resolve(7);
    Object.defineProperty(p,"constructor",{get(){log+="g";throw 9;}});
    try{await p;}catch(error){log+=error;}finally{log+="f";}return log;`,'g9f'],
  ['shared-prototype-constructor',`let count=0;const p=Promise.resolve(7);
    Object.defineProperty(Promise.prototype,"constructor",{get(){count++;return Promise;},configurable:true});
    const value=await p;return count+value;`,8],
  ['inherited-constructor-receiver',`let log='';const p=Promise.resolve(1),other=Promise.resolve(2);Object.defineProperty(Promise.prototype,'constructor',{get(){log+=this===p?'p':this===other?'o':'bad';return Promise;},configurable:true});await p;await other;return log;`,'po'],
  ['own-reflection-call',`const p=Promise.resolve(4);p.x=7;return Object.prototype.hasOwnProperty.call(p,"x");`,true],
  ['nonextensible-reflection',`const p=Promise.resolve(4);Object.preventExtensions(p);return Object.isExtensible(p);`,false],
  ['own-key-filtering',`const p=Promise.resolve(4);p.x=7;Object.defineProperty(p,"hidden",{value:3});return Object.keys(p).length;`,1],
  ['null-prototype-state',`const p=Promise.resolve(4);Object.setPrototypeOf(p,null);p.x=7;return p.x===7&&Object.getPrototypeOf(p)===null;`,true]
];
export const PROMISE_OBJECT_FIXTURES_V8=Object.freeze(cases.map(([name,body,expected])=>Object.freeze({
  id:'promise-object-'+name,family:'promise-object-state',entry:'run',args:[],expected,
  source:'"use strict";async function run(){'+body+'}'
})));
