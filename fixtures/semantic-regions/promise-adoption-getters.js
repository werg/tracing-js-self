// These original source programs exercise constructor access inside the owned
// PromiseResolveThenableJob. Their source and reference observations are kept
// distinct from the direct public-protocol controls.
const cases=[
  ['receiver-and-fifo',`let log='';const p=Promise.resolve(1);
    Object.defineProperty(p,'constructor',{get(){log+=this===p?'g':'bad';return Promise;}});
    async function h(){return p;}const q=h();queueMicrotask(()=>{log+='q';});await q;return log;`,'gq'],
  ['throw-identity-and-cleanup',`let log='';const reason=Promise.resolve(9),p=Promise.resolve(1);
    function fail(){log+='h';throw reason;}
    Object.defineProperty(p,'constructor',{get(){log+='g';return fail();}});
    async function h(){return p;}const q=h();queueMicrotask(()=>{log+='q';});
    try{await q;}catch(error){log+=error===reason?'e':'bad';}finally{log+='f';}return log;`,'ghqef'],
  ['nested-constructor-reentry',`let log='';const inner=Promise.resolve(2),p=Promise.resolve(1);
    Object.defineProperty(inner,'constructor',{get(){log+='i';return Promise;}});
    Object.defineProperty(p,'constructor',{get(){log+='o';Promise.resolve(inner);return undefined;}});
    async function h(){return p;}await h();return log;`,'oi'],
  ['pending-target',`let log='',settle;const p=new Promise(resolve=>{settle=resolve;});
    Object.defineProperty(p,'constructor',{get(){log+='g';queueMicrotask(()=>{log+='s';settle(7);});return Promise;}});
    async function h(){return p;}const q=h();queueMicrotask(()=>{log+='q';});const value=await q;return log+value;`,'gqs7'],
  ['getter-replaces-own-descriptor',`let log='';const p=Promise.resolve(1);
    Object.defineProperty(p,'constructor',{configurable:true,get(){log+='g';Object.defineProperty(p,'constructor',{value:Promise});return Promise;}});
    async function h(){return p;}await h();return log+(Object.getOwnPropertyDescriptor(p,'constructor').value===Promise);`,'gtrue'],
  ['nested-helper-return',`let log='';const p=Promise.resolve(1);function inner(){return Promise;}function outer(){return inner();}
    Object.defineProperty(p,'constructor',{get(){log+='g';return outer();}});async function h(){return p;}await h();return log+'1';`,'g1'],
  ['constructor-arrow-lexical-receiver',`const p=Promise.resolve(1);p.value=1;class Holder{constructor(){this.value=Promise;
    Object.defineProperty(p,'constructor',{get:()=>this.value});}}new Holder();async function h(){return p;}await h();return 'ok';`,'ok']
];
export const PROMISE_ADOPTION_GETTER_FIXTURES_V8=Object.freeze(cases.map(([name,body,expected])=>Object.freeze({
  id:'promise-adoption-getter-'+name,family:'promise-adoption-getter',entry:'run',args:[],expected,
  source:'"use strict";async function run(){'+body+'}'
})));
