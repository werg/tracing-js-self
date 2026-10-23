// Adversarial, effectful scenario drivers for exact pinned production libraries.
// All package implementations are vendored unchanged under upstream/. Drivers
// intentionally supply controlled inputs; they are NOT third-party code.
export const upstream = Object.freeze({
  mitt: {repository:'developit/mitt',revision:'6b41670516ed8e8b738612f60491995470aa63b3',license:'MIT',path:'mitt/src/index.ts'},
  zustand: {repository:'pmndrs/zustand',revision:'382d29c485e67018c06e75ec7235130d0968522c',license:'MIT',path:'zustand/src/vanilla.ts'},
  'quick-lru': {repository:'sindresorhus/quick-lru',revision:'a2190ebdf8e455b95a7138803d274ff5ed57ebcd',license:'MIT',path:'quick-lru/index.js'},
  'koa-compose': {repository:'koajs/compose',revision:'9a2a426b32c614835b812ecb8de5af06c6c87f6f',license:'MIT',path:'koa-compose/index.js'},
  'yocto-queue': {repository:'sindresorhus/yocto-queue',revision:'72a8fa96a9d389765cdf2bb9c6daba8302fc375d',license:'MIT',path:'yocto-queue/index.js'},
  'p-limit': {repository:'sindresorhus/p-limit',revision:'a8a6fbec4e0e866d6d779b10889bb4f5567e70eb',license:'MIT',path:'p-limit/index.js'},
  eventemitter3: {repository:'primus/eventemitter3',revision:'b0144e940ace8add8f335a8adfbed9284eb419f3',license:'MIT',path:'eventemitter3/index.js'}
});
const group=(project,modules,variants)=>variants.map(([name,adversarial,run])=>({
  id:project+'/'+name,project,modules,adversarial,run
}));
export const scenarios=[
 ...group('mitt',['mitt'],[
 ['listener-order','listeners and wildcard order',`
function run(seed){
 const mitt=__require('mitt').default, bus=mitt(),log=[],payload={value:seed};
 bus.on('edit',v=>{v.value+=1;log.push(['one',v.value]);});
 bus.on('edit',v=>log.push(['two',v.value]));
 bus.on('*',(type,v)=>log.push(['wild',type,v.value]));
 bus.emit('edit',payload);
 return {payload,log,listeners:bus.all.get('edit').length};
}`],
 ['unsubscribe-during-emit','listener removal during dispatch snapshot',`
function run(seed){
 const bus=__require('mitt').default(),log=[];
 const second=v=>log.push(['second',v]);
 bus.on('x',v=>{log.push(['first',v]);bus.off('x',second)});
 bus.on('x',second);bus.emit('x',seed);bus.emit('x',seed+1);
 return {log,count:bus.all.get('x').length};
}`],
 ['subscribe-during-emit','listener insertion during snapshot iteration',`
function run(seed){
 const bus=__require('mitt').default(),log=[];
 bus.on('x',v=>{log.push(['first',v]);bus.on('x',w=>log.push(['late',w]));});
 bus.emit('x',seed);bus.emit('x',seed+1);
 return {log,size:bus.all.get('x').length};
}`],
 ['recursive-notification','nested emit and callback depth',`
function run(seed){
 const bus=__require('mitt').default(),log=[],limit=2+seed%4;
 bus.on('tick',n=>{log.push(n);if(n<limit)bus.emit('tick',n+1)});
 bus.emit('tick',0);return {log,limit};
}`],
 ['duplicate-subscriber','same function registered twice',`
function run(seed){
 const bus=__require('mitt').default(),log=[],fn=v=>log.push(v);
 bus.on('x',fn);bus.on('x',fn);bus.emit('x',seed);bus.off('x',fn);
 bus.emit('x',seed+1);return {log,left:bus.all.get('x').length};
}`],
 ['self-removal','callback deregisters itself',`
function run(seed){
 const bus=__require('mitt').default(),log=[];
 const once=v=>{log.push(['once',v]);bus.off('x',once)};
 bus.on('x',once);bus.on('*',(t,v)=>log.push(['wild',t,v]));
 bus.emit('x',seed);bus.emit('x',seed+1);
 return {log,left:bus.all.get('x').length};
}`],
 ['hostile-event-keys','special object-like event names',`
function run(seed){
 const bus=__require('mitt').default(),log=[];
 for(const k of ['__proto__','constructor','toString'])bus.on(k,v=>log.push([k,v]));
 bus.emit('__proto__',seed);bus.emit('constructor',seed+1);
 bus.emit('toString',seed+2);return {log,keys:[...bus.all.keys()]};
}`],
 ['uncaught-listener-error','uncaught callback error after observable console effect',`
function run(seed){
 const bus=__require('mitt').default();
 bus.on('boom',v=>{console.log('mitt-before-error',v);throw new Error('mitt-uncaught:'+v)});
 bus.emit('boom',seed);return 'unreachable';
}`],
 ['listener-error','throw aborts remaining handlers and wildcard delivery',`
function run(seed){
 const bus=__require('mitt').default(),log=[];
 bus.on('x',()=>{log.push('one');throw Error('handler:'+seed)});
 bus.on('x',()=>log.push('two'));bus.on('*',()=>log.push('wild'));
 let error;try{bus.emit('x',seed)}catch(e){error=e.message}
 return {log,error};
}`]
 ]),
 ...group('zustand',['zustand'],[
 ['subscribe-and-unsubscribe','store subscriptions and shallow merge',`
function run(seed){
 const store=__require('zustand').createStore(()=>({count:seed,extra:1})),log=[];
 const off=store.subscribe((now,prev)=>log.push([prev.count,now.count]));
 store.setState({count:seed+1});store.setState({extra:2});off();store.setState({count:seed+2});
 return {initial:store.getInitialState(),current:store.getState(),log};
}`],
 ['same-state-noop','identity equality vs new object',`
function run(seed){
 const store=__require('zustand').createStore(()=>({n:seed})),log=[];
 store.subscribe((v,p)=>log.push([v.n,p.n,Object.is(v,p)]));
 store.setState(v=>v);store.setState({n:seed});store.setState(v=>({...v}));
 return {log,state:store.getState()};
}`],
 ['replace-versus-merge','overwrite and non-object state replacement',`
function run(seed){
 const store=__require('zustand').createStore(()=>({a:seed,b:3})),log=[];
 store.subscribe((v,p)=>log.push([v,p]));
 store.setState({a:seed+1});store.setState({c:5},true);
 store.setState(seed,true);return {log,state:store.getState()};
}`],
 ['nested-update','subscriber reentry with current state transitions',`
function run(seed){
 const store=__require('zustand').createStore(()=>({count:0})),log=[];
 store.subscribe(v=>{log.push(['a',v.count]);if(v.count<3)store.setState({count:v.count+1})});
 store.subscribe(v=>log.push(['b',v.count]));
 store.setState({count:seed%2});return {log,state:store.getState()};
}`],
 ['remove-during-notify','Set.forEach removal during notification',`
function run(seed){
 const store=__require('zustand').createStore(()=>({n:seed})),log=[];
 let offB=()=>{};store.subscribe(()=>{log.push('a');offB()});
 offB=store.subscribe(()=>log.push('b'));
 store.subscribe(()=>log.push('c'));
 store.setState({n:seed+1});return {log,size:log.length};
}`],
 ['add-during-notify','Set.forEach addition during notification',`
function run(seed){
 const store=__require('zustand').createStore(()=>({n:seed})),log=[];
 let installed=false;store.subscribe(v=>{log.push(['a',v.n]);
   if(!installed){installed=true;store.subscribe(w=>log.push(['new',w.n]))}});
 store.setState({n:seed+1});store.setState({n:seed+2});
 return {log,state:store.getState()};
}`],
 ['mutation-without-notify','direct state-object mutation versus setState',`
function run(seed){
 const store=__require('zustand').createStore(()=>({list:[seed]})),log=[];
 store.subscribe((v,p)=>log.push([v.list.length,p.list.length]));
 store.getState().list.push(seed+1);
 store.setState({list:store.getState().list});
 return {log,initial:store.getInitialState(),state:store.getState()};
}`],
 ['uncaught-subscriber-error','state change triggers an uncaught listener error after logging',`
function run(seed){
 const store=__require('zustand').createStore(()=>({n:0}));
 store.subscribe((v,p)=>{console.log('zustand-change',p.n,v.n);throw new Error('zustand-uncaught:'+seed)});
 store.setState({n:seed+1});return 'unreachable';
}`],
 ['async-update','microtasks modify state between subscriptions',`
async function run(seed){
 const store=__require('zustand').createStore(()=>({n:0})),log=[];
 store.subscribe(v=>log.push(v.n));
 const a=Promise.resolve().then(()=>store.setState(v=>({n:v.n+seed+1})));
 const b=Promise.resolve().then(()=>store.setState(v=>({n:v.n+1})));
 await Promise.all([a,b]);return {log,state:store.getState()};
}`]
 ]),
 ...group('eventemitter3',['eventemitter3'],[
 ['once-versus-on','once listener removes itself on first delivery',`
function run(seed){
 const E=__require('eventemitter3'),em=new E(),log=[];
 em.once('update',x=>log.push(['once',x]));
 em.on('update',x=>log.push(['always',x]));
 em.emit('update',seed);em.emit('update',seed+1);
 return {log,count:em.listenerCount('update'),names:em.eventNames()};
}`],
 ['remove-during-dispatch','snapshot array and callback removal order',`
function run(seed){
 const E=__require('eventemitter3'),em=new E(),log=[];
 const b=x=>log.push(['b',x]);
 em.on('tick',x=>{log.push(['a',x]);em.off('tick',b)});
 em.on('tick',b);em.emit('tick',seed);em.emit('tick',seed+1);
 return {log,count:em.listenerCount('tick')};
}`],
 ['listener-context','receiver binding and multi-arity dispatch',`
function run(seed){
 const E=__require('eventemitter3'),em=new E(),context={sum:seed},log=[];
 em.on('add',function(a,b,c){this.sum+=a+b+c;log.push(this.sum)},context);
 em.emit('add',1,2,3);em.emit('add',seed,1,0);
 return {context,log};
}`],
 ['recursive-emit','reentrant event emission order',`
function run(seed){
 const E=__require('eventemitter3'),em=new E(),log=[],stop=2+seed%4;
 em.on('x',x=>{log.push(x);if(x<stop)em.emit('x',x+1)});
 em.emit('x',0);return {log,stop};
}`],
 ['wild-event-keys','prototype hazard event names',`
function run(seed){
 const E=__require('eventemitter3'),em=new E(),log=[];
 em.on('__proto__',x=>log.push(['proto',x]));
 em.on('constructor',x=>log.push(['ctor',x]));
 em.emit('__proto__',seed);em.emit('constructor',seed+1);
 return {log,names:em.eventNames()};
}`],
 ['listener-error-recovery','thrown callback stops later listener invocation',`
function run(seed){
 const E=__require('eventemitter3'),em=new E(),log=[];
 em.on('go',()=>{log.push('a');throw new Error('bad:'+seed)});
 em.on('go',()=>log.push('b'));
 let error;try{em.emit('go',seed)}catch(e){error=e.message}
 return {log,error,count:em.listenerCount('go')};
}`],
 ['uncaught-event-error','EventEmitter callback records an effect then throws',`
function run(seed){
 const E=__require('eventemitter3'),em=new E();
 em.on('event',v=>{console.log('eventemitter-before-error',v);throw Error('event-uncaught:'+v)});
 em.emit('event',seed);return 'unreachable';
}`],
 ['remove-all-then-readd','listener identity and namespace reset',`
function run(seed){
 const E=__require('eventemitter3'),em=new E(),log=[];
 em.on('x',v=>log.push(v));em.on('y',v=>log.push(v));
 em.removeAllListeners('x');em.emit('x',seed);
 em.emit('y',seed+1);em.removeAllListeners();
 em.on('x',v=>log.push(v*2));em.emit('x',seed+2);
 return {log,names:em.eventNames()};
}`]
 ]),
 ...group('yocto-queue',['yocto-queue'],[
 ['fifo-drain','mutable linked-list queue and drain generator',`
function run(seed){
 const Queue=__require('yocto-queue').default,q=new Queue();
 for(let n=0;n<5;n++)q.enqueue(seed+n);
 const head=q.peek(),first=q.dequeue(),remaining=[...q.drain()];
 return {head,first,remaining,size:q.size};
}`],
 ['clear-and-reuse','tail ownership after clear',`
function run(seed){
 const Queue=__require('yocto-queue').default,q=new Queue(),log=[];
 q.enqueue(seed);q.enqueue(seed+1);log.push(q.dequeue());q.clear();
 log.push(q.dequeue());q.enqueue(seed+2);q.enqueue(seed+3);
 return {log,all:[...q],peek:q.peek(),size:q.size};
}`],
 ['interleaved-producer-consumer','dequeue mixed with enqueues and aliases',`
function run(seed){
 const Queue=__require('yocto-queue').default,q=new Queue(),a={count:seed};
 const log=[];q.enqueue(a);q.enqueue({count:seed+1});
 log.push(q.dequeue());a.count+=5;q.enqueue(a);
 log.push(q.dequeue());log.push(q.dequeue());
 return {log,alias:a,size:q.size};
}`],
 ['iteration-while-mutating','iterator walks linked list extended while visiting',`
function run(seed){
 const Queue=__require('yocto-queue').default,q=new Queue(),log=[];
 q.enqueue(seed);q.enqueue(seed+1);
 for(const value of q){log.push(value);if(log.length===1)q.enqueue(seed+2);if(log.length>6)break}
 return {log,remaining:[...q],size:q.size};
}`],
 ['empty-edge-cases','empty dequeue and final tail clean-up',`
function run(seed){
 const Queue=__require('yocto-queue').default,q=new Queue(),results=[];
 results.push(q.dequeue(),q.peek());q.enqueue(seed);results.push(q.dequeue(),q.dequeue(),q.peek());
 q.enqueue(seed+1);return {results,remaining:[...q],size:q.size};
}`],
 ['partial-drain','iterator consumed partially followed by writes',`
function run(seed){
 const Queue=__require('yocto-queue').default,q=new Queue();
 [seed,seed+1,seed+2,seed+3].forEach(x=>q.enqueue(x));
 const iterator=q.drain(),first=iterator.next().value;q.enqueue(seed+4);
 const second=iterator.next().value;
 return {first,second,left:[...q],size:q.size};
}`],
 ['iterator-abrupt-exit','queue iterator interrupted by error after first delivery',`
function run(seed){
 const Queue=__require('yocto-queue').default,q=new Queue();
 q.enqueue(seed);q.enqueue(seed+1);
 for(const value of q){console.info('queue-visited',value);throw new Error('queue-interrupt:'+seed)}
 return 'unreachable';
}`],
 ['reference-aliases','same object references across queue positions',`
function run(seed){
 const Queue=__require('yocto-queue').default,q=new Queue(),record={v:seed};
 q.enqueue(record);q.enqueue(record);
 q.dequeue().v+=1;const same=q.peek()===record;
 return {same,record,head:q.peek(),size:q.size};
}`]
 ]),
 ...group('quick-lru',['quick-lru'],[
 ['rollover-eviction','two-generation eviction and callback order',`
function run(seed){
 const LRU=__require('quick-lru').default,evicted=[],cache=new LRU({maxSize:2,onEviction:(k,v)=>evicted.push([k,v])});
 cache.set('a',seed);cache.set('b',seed+1);cache.set('c',seed+2);cache.set('d',seed+3);
 return {evicted,entries:[...cache],size:cache.size};
}`],
 ['get-refreshes','reading old generation promotes entry',`
function run(seed){
 const LRU=__require('quick-lru').default,cache=new LRU({maxSize:3}),log=[];
 for(let i=0;i<5;i++)cache.set('k'+i,seed+i);
 log.push(cache.get('k2'),cache.get('k4'),cache.get('absent'));
 cache.set('extra',seed+6);return {log,entries:[...cache],size:cache.size};
}`],
 ['expiry-boundary','expiration and eviction callback path with frozen clock',`
function run(seed){
 const LRU=__require('quick-lru').default,evicted=[],cache=new LRU({maxSize:4,onEviction:(k,v)=>evicted.push([k,v])});
 cache.set('expire',seed,{maxAge:-1});cache.set('live',seed+1,{maxAge:300});
 const a=cache.get('expire'),b=cache.get('live');
 return {a,b,evicted,entries:[...cache]};
}`],
 ['peek-vs-get','read without promoting then promote',`
function run(seed){
 const LRU=__require('quick-lru').default,cache=new LRU({maxSize:2});
 cache.set('a',seed);cache.set('b',seed+1);cache.set('c',seed+2);
 const peek=cache.peek('a'),get=cache.get('b'),has=cache.has('missing');
 return {peek,get,has,entries:[...cache]};
}`],
 ['resize-eviction','downsizing and internal ordering',`
function run(seed){
 const LRU=__require('quick-lru').default,evicted=[],cache=new LRU({maxSize:4,onEviction:(k,v)=>evicted.push([k,v])});
 for(let i=0;i<6;i++)cache.set('k'+i,seed+i);
 cache.resize(2+seed%2);
 return {evicted,size:cache.size,maxSize:cache.maxSize,entries:[...cache]};
}`],
 ['explicit-evict','evict count boundary and preserved last entry',`
function run(seed){
 const LRU=__require('quick-lru').default,log=[],cache=new LRU({maxSize:5,onEviction:(k,v)=>log.push(k)});
 for(let i=0;i<5;i++)cache.set('k'+i,seed+i);
 cache.evict(seed%7);
 return {log,entries:[...cache],size:cache.size};
}`],
 ['callback-reentry','eviction observer mutates external side effects',`
function run(seed){
 const LRU=__require('quick-lru').default,log=[],seen={n:0};
 const cache=new LRU({maxSize:2,onEviction:(k,v)=>{seen.n++;log.push([k,v,seen.n])}});
 cache.set('a',seed);cache.set('b',seed+1);cache.set('c',seed+2);cache.set('d',seed+3);
 return {log,seen,entries:[...cache]};
}`],
 ['eviction-abrupt-completion','cache eviction callback throws after durable observation',`
function run(seed){
 const LRU=__require('quick-lru').default;
 const c=new LRU({maxSize:2,onEviction:(k,v)=>{console.warn('evicting',k,v);throw Error('eviction-uncaught:'+seed)}});
 for(let i=0;i<5;i++)c.set('k'+i,seed+i);
 return 'unreachable';
}`],
 ['clear-and-restore','clear resets entries and generations',`
function run(seed){
 const LRU=__require('quick-lru').default,cache=new LRU({maxSize:2});
 cache.set('a',seed);cache.set('b',seed+1);cache.clear();
 const after=cache.get('a');cache.set('fresh',seed+2);
 return {after,size:cache.size,entries:[...cache]};
}`]
 ]),
 ...group('koa-compose',['koa-compose'],[
 ['onion-order','onion order before and after awaited next',`
async function run(seed){
 const compose=__require('koa-compose'),ctx={value:seed,log:[]};
 const mw=compose([async(c,next)=>{c.log.push('a>');await next();c.log.push('<a')},
   async(c,next)=>{c.value++;c.log.push('b>');await next();c.log.push('<b')}]);
 await mw(ctx,()=>{ctx.log.push('end')});return ctx;
}`],
 ['response-mutation','simulated request response side effects',`
async function run(seed){
 const compose=__require('koa-compose'),ctx={request:{id:seed},response:{headers:{}},log:[]};
 const mw=compose([async(c,next)=>{c.response.headers.trace=String(seed);await next();c.response.done=true},
   async(c,next)=>{c.log.push('handler');c.response.status=seed%2?201:200;await next()}]);
 await mw(ctx,()=>{ctx.response.body='ok:'+ctx.request.id});return ctx;
}`],
 ['double-next','middleware calls next twice and catches error',`
async function run(seed){
 const compose=__require('koa-compose'),ctx={log:[]},mw=compose([
   async(c,next)=>{c.log.push('outer');await next();try{await next()}catch(e){c.log.push(e.message)}},
   async(c,next)=>{c.log.push('inner:'+seed);await next()}
 ]);
 await mw(ctx);return ctx;
}`],
 ['missing-await','detected premature middleware completion',`
async function run(seed){
 const compose=__require('koa-compose'),ctx={log:[]};
 const mw=compose([async(c,next)=>{c.log.push('enter');next();c.log.push('unawaited')},
  async(c,next)=>{await Promise.resolve();c.log.push('downstream:'+seed);await next()}]);
 let error;try{await mw(ctx)}catch(e){error=e.message}
 await Promise.resolve();return {ctx,error};
}`],
 ['downstream-error','error recovery unwinds middleware stack',`
async function run(seed){
 const compose=__require('koa-compose'),ctx={log:[]};
 const mw=compose([async(c,next)=>{try{await next()}catch(e){c.log.push('caught:'+e.message)}},
   async(c,next)=>{c.log.push('inner');throw new Error('fail:'+seed)}]);
 await mw(ctx);return ctx;
}`],
 ['early-return','middleware omits next and stops pipeline',`
async function run(seed){
 const compose=__require('koa-compose'),ctx={status:0,log:[]};
 const mw=compose([async(c,next)=>{if(seed%2){c.status=403;return}await next()},
   async(c,next)=>{c.status=200;c.log.push('handled');await next()}]);
 await mw(ctx);return ctx;
}`],
 ['nested-pipeline','nested composed middlewares and shared context',`
async function run(seed){
 const compose=__require('koa-compose'),ctx={trace:[],count:seed};
 const nested=compose([async(c,next)=>{c.trace.push('n1');await next();c.trace.push('n1-end')},
  async(c,next)=>{c.count*=2;await next()}]);
 const top=compose([async(c,next)=>{c.trace.push('top');await next();c.trace.push('top-end')},nested]);
 await top(ctx,()=>{ctx.trace.push('root')});return ctx;
}`],
 ['uncaught-downstream-error','asynchronous middleware rejects after side effect',`
async function run(seed){
 const compose=__require('koa-compose'),ctx={count:0};
 const pipeline=compose([
  async(c,next)=>{c.count++;console.log('middleware-start',c.count);await next()},
  async(c,next)=>{c.count++;console.error('middleware-failure',seed);throw new Error('middleware-uncaught:'+seed)}
 ]);
 await pipeline(ctx);return 'unreachable';
}`],
 ['bad-middleware','invalid argument throws before request begins',`
function run(seed){
 const compose=__require('koa-compose');let error;
 try{compose([async()=>{},seed%2?false:null])}catch(e){error=e.message}
 return {error};
}`]
 ]),
 ...group('p-limit',['p-limit','yocto-queue'],[
 ['concurrency-order','worker start/finish order and activeCount',`
async function run(seed){
 const limit=__require('p-limit').default(2),log=[];
 const jobs=[0,1,2,3,4].map(i=>limit(async()=>{log.push(['start',i,limit.activeCount]);
   await Promise.resolve();log.push(['done',i]);return seed+i}));
 const result=await Promise.all(jobs);
 return {log,result,active:limit.activeCount,pending:limit.pendingCount};
}`],
 ['rejected-worker','rejection recovery without blocking queued work',`
async function run(seed){
 const limit=__require('p-limit').default(1),log=[];
 const work=i=>limit(async()=>{log.push(['start',i]);await Promise.resolve();
   if(i===2)throw new Error('bad:'+seed);log.push(['ok',i]);return i+seed});
 const result=await Promise.allSettled([work(1),work(2),work(3)]);
 return {log,result:result.map(x=>x.status==='fulfilled'?x.value:x.reason.message),active:limit.activeCount};
}`],
 ['microtask-before-work','no synchronous execution of scheduled job',`
async function run(seed){
 const limit=__require('p-limit').default(1),log=[];
 const x=limit(()=>{log.push('task');return seed+1});
 log.push('scheduled');const answer=await x;log.push('joined');
 return {answer,log};
}`],
 ['clear-pending','clear queued jobs while one active task is held',`
async function run(seed){
 const limit=__require('p-limit').default(1),log=[];
 let release;const gate=new Promise(resolve=>release=resolve);
 const active=limit(async()=>{log.push('active');await gate;return seed});
 const unstarted=limit(()=>{log.push('wrong');return seed+1});
 await Promise.resolve();await Promise.resolve();
 const pending=limit.pendingCount;limit.clearQueue();release();
 await active;return {log,pending,pendingAfter:limit.pendingCount,active:limit.activeCount,unstarted:!!unstarted};
}`],
 ['concurrency-resize','mutable concurrency resumes queued tasks',`
async function run(seed){
 const limit=__require('p-limit').default(1),log=[];
 const promises=Array.from({length:4},(_,i)=>limit(async()=>{
  log.push(['begin',i,limit.activeCount]);await Promise.resolve();return seed+i}));
 limit.concurrency=2;const output=await Promise.all(promises);
 return {output,log,max:limit.concurrency};
}`],
 ['map-indexes','concurrent map passes original indices',`
async function run(seed){
 const limit=__require('p-limit').default(3),log=[];
 const result=await limit.map([seed,seed+1,seed+2],async(v,i)=>{
  log.push(['begin',i]);await Promise.resolve();return v*i});
 return {result,log,pending:limit.pendingCount};
}`],
 ['nested-limiter','task schedules a nested bounded task',`
async function run(seed){
 const limit=__require('p-limit').default(2),log=[];
 const result=await limit(async()=>{
  log.push('outer');const v=await limit(async()=>{log.push('inner');return seed+1});
  log.push('joined');return v+1});
 return {log,result};
}`],
 ['uncaught-worker-rejection','bounded worker rejects after logged start',`
async function run(seed){
 const limit=__require('p-limit').default(1);
 return await limit(async()=>{console.log('worker-start',seed);await Promise.resolve();throw new Error('worker-uncaught:'+seed)});
}`],
 ['sync-throw','synchronous work failure becomes rejected promise',`
async function run(seed){
 const limit=__require('p-limit').default(1),log=[];
 const tasks=[limit(()=>{log.push('error');throw Error('bad:'+seed)}),
  limit(()=>{log.push('next');return seed+1})];
 const result=await Promise.allSettled(tasks);
 return {log,result:result.map(x=>x.status==='rejected'?x.reason.message:x.value)};
}`]
 ]),
 ...group('application',['koa-compose','mitt','zustand','quick-lru','p-limit','yocto-queue','eventemitter3'],[
 ['event-sourced-state','event dispatcher updates subscribed state',`
function run(seed){
 const bus=__require('mitt').default(),store=__require('zustand').createStore(()=>({n:0,items:[]})),log=[];
 store.subscribe(v=>log.push(['state',v.n,v.items.length]));
 bus.on('record',v=>{store.setState(s=>({n:s.n+v,items:[...s.items,v]}))});
 bus.on('*',(type,v)=>log.push(['event',type,v]));
 for(let i=0;i<4;i++)bus.emit('record',seed+i);
 return {log,state:store.getState(),registered:bus.all.size};
}`],
 ['cache-backed-request','middleware and LRU cache service effects',`
async function run(seed){
 const compose=__require('koa-compose'),LRU=__require('quick-lru').default,cache=new LRU({maxSize:2}),writes=[];
 const processRequest=compose([async(c,next)=>{c.meta='request:'+c.key;await next()},
  async(c,next)=>{const v=cache.get(c.key);if(v!==undefined){c.response=v;return}
    c.response=seed+c.key.length;cache.set(c.key,c.response);writes.push(['store',c.key,c.response]);await next()}]);
 const responses=[];for(const key of ['a','b','a','c','a']){const c={key};await processRequest(c);responses.push(c.response)}
 return {responses,writes,entries:[...cache]};
}`],
 ['queued-events','queue delivers event emitter notifications to stateful sink',`
function run(seed){
 const E=__require('eventemitter3'),Queue=__require('yocto-queue').default,em=new E(),q=new Queue(),db={total:0,log:[]};
 em.on('item',v=>{db.total+=v;db.log.push(v)});
 for(let i=0;i<5;i++)q.enqueue(seed+i);
 while(q.size)em.emit('item',q.dequeue());
 return {db,remaining:q.size,events:em.eventNames()};
}`],
 ['limited-state-transactions','concurrent tasks update shared store through limiter',`
async function run(seed){
 const limit=__require('p-limit').default(2),store=__require('zustand').createStore(()=>({n:0})),log=[];
 store.subscribe((v,p)=>log.push([p.n,v.n]));
 const all=[0,1,2,3].map(i=>limit(async()=>{await Promise.resolve();
  store.setState(s=>({n:s.n+seed+i}));return store.getState().n}));
 return {results:await Promise.all(all),log,state:store.getState()};
}`],
 ['route-with-side-effects','middleware updates store and emits audit events',`
async function run(seed){
 const compose=__require('koa-compose'),bus=__require('mitt').default(),store=__require('zustand').createStore(()=>({hits:0})),audit=[];
 bus.on('request',x=>audit.push(['request',x]));store.subscribe(s=>audit.push(['hits',s.hits]));
 const middleware=compose([async(ctx,next)=>{bus.emit('request',ctx.id);await next();audit.push(['finish',ctx.status])},
  async(ctx,next)=>{store.setState(s=>({hits:s.hits+1}));ctx.status=ctx.id%2?200:403;if(ctx.status===200)await next()}]);
 const results=[];for(let i=0;i<3;i++){const ctx={id:seed+i};await middleware(ctx);results.push(ctx.status)}
 return {audit,results,state:store.getState()};
}`],
 ['eviction-notification-pipeline','cache eviction signals event emitter and mutable store',`
function run(seed){
 const E=__require('eventemitter3'),em=new E(),store=__require('zustand').createStore(()=>({evictions:0})),log=[];
 em.on('evicted',(key,value)=>{log.push([key,value]);store.setState(s=>({evictions:s.evictions+1}))});
 const LRU=__require('quick-lru').default,cache=new LRU({maxSize:2,onEviction:(k,v)=>em.emit('evicted',k,v)});
 for(let i=0;i<6;i++)cache.set('k'+i,seed+i);
 return {log,state:store.getState(),entries:[...cache]};
}`]
 ])
];
if(new Set(scenarios.map(s=>s.id)).size!==scenarios.length)throw new Error('Duplicate adversarial scenario name');
