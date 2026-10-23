// Extension suite: original vendored package implementations remain unchanged.
// Drivers are authored scenarios and NOT upstream tests; independently checked
// native-V8 final-observable diagnostics only, never admitted owned traces.
export const adversarialScenarios = [
  {
    "id": "adversarial/mitt--recursive-mutation",
    "project": "mitt",
    "modules": [
      "mitt"
    ],
    "adversarial": "reentrant listener mutation and wildcard timing",
    "run": "function run(seed) {\n const bus=__require('mitt').default(),trace=[],payload={n:seed},depth=3+Math.abs(seed%3);\n let calls=0;const late=x=>trace.push(['late',x.n]),b=x=>trace.push(['b',x.n]);\n bus.on('change',function onA(x){\n   calls++;trace.push(['a',x.n,calls]);\n   if(calls===1){bus.off('change',b);bus.on('change',late)}\n   if(calls<depth){x.n++;bus.emit('change',x)}\n });\n bus.on('change',b);bus.on('*',(type,x)=>trace.push(['wild',type,x.n]));\n bus.emit('change',payload);bus.emit('change',{n:seed+9});\n return {trace,payload,calls,listeners:bus.all.get('change').length};\n}"
  },
  {
    "id": "adversarial/mitt--callback-throw-recovery",
    "project": "mitt",
    "modules": [
      "mitt"
    ],
    "adversarial": "nested throw, state mutation and listener recovery",
    "run": "function run(seed) {\n const bus=__require('mitt').default(),log=[],payload={n:seed};\n bus.on('inner',x=>{log.push('inner');x.n++;throw Error('inner:'+x.n)});\n bus.on('outer',x=>{log.push('before');try{bus.emit('inner',x)}catch(e){log.push(e.message)};log.push('after')});\n bus.on('*',(name,x)=>log.push(['wild',name,x.n]));\n bus.emit('outer',payload);return {log,payload};\n}"
  },
  {
    "id": "adversarial/zustand--getter-side-effects",
    "project": "zustand",
    "modules": [
      "zustand"
    ],
    "adversarial": "accessor execution during store merge",
    "run": "function run(seed) {\n const store=__require('zustand').createStore(()=>({count:0,history:[]})),log=[];\n store.subscribe((now,prev)=>log.push(['notify',prev.count,now.count]));\n const incoming={get count(){log.push('getter');return seed+log.length}};\n store.setState(incoming);\n store.setState(s=>({count:s.count+1,history:[...s.history,s.count]}));\n return {log,current:store.getState()};\n}"
  },
  {
    "id": "adversarial/zustand--cross-store-cycle",
    "project": "application",
    "modules": [
      "zustand",
      "mitt"
    ],
    "adversarial": "cross-store synchronous callback cycle",
    "run": "function run(seed) {\n const create=__require('zustand').createStore,bus=__require('mitt').default();\n const a=create(()=>({n:0})),b=create(()=>({n:0})),log=[];\n let remaining=4+Math.abs(seed%3);\n a.subscribe(v=>{log.push(['a',v.n]);if(--remaining>0)bus.emit('sync',v.n)});\n bus.on('sync',n=>b.setState({n:n+1}));\n b.subscribe(v=>{log.push(['b',v.n]);if(remaining>0)a.setState({n:v.n+1})});\n a.setState({n:seed});return {log,a:a.getState(),b:b.getState(),remaining};\n}"
  },
  {
    "id": "adversarial/eventemitter--nested-once",
    "project": "eventemitter3",
    "modules": [
      "eventemitter3"
    ],
    "adversarial": "once-handler re-registration during recursion",
    "run": "function run(seed) {\n const E=__require('eventemitter3'),em=new E(),log=[];\n let depth=0;\n em.once('event',function first(v){\n   log.push(['first',v,this===em]);em.once('event',w=>log.push(['rearmed',w]));\n   if(++depth<3)em.emit('event',v+1);\n },em);\n em.on('event',v=>log.push(['persistent',v]));\n em.emit('event',seed);em.emit('event',seed+5);\n return {log,count:em.listenerCount('event'),names:em.eventNames()};\n}"
  },
  {
    "id": "adversarial/queue--iterator-structural-churn",
    "project": "yocto-queue",
    "modules": [
      "yocto-queue"
    ],
    "adversarial": "iterator visits object aliases during queue mutations",
    "run": "function run(seed) {\n const Queue=__require('yocto-queue').default,q=new Queue(),shared={v:seed},log=[];\n q.enqueue(shared);q.enqueue({v:seed+1});q.enqueue(shared);\n let i=0;for(const item of q){\n  log.push(item.v);if(++i===1){item.v++;q.enqueue(shared)}\n  if(i===2){q.dequeue();q.enqueue({v:seed+4})}\n  if(i===4)break;\n }\n return {log,shared,remaining:[...q].map(x=>x.v),size:q.size};\n}"
  },
  {
    "id": "adversarial/lru--eviction-callback-interaction",
    "project": "quick-lru",
    "modules": [
      "quick-lru"
    ],
    "adversarial": "cache eviction callback updates another live cache",
    "run": "function run(seed) {\n const LRU=__require('quick-lru').default,events=[],aux=new LRU({maxSize:3});\n const cache=new LRU({maxSize:2,onEviction:(k,v)=>{\n   events.push([k,v]);aux.set('evicted:'+k,v);if(events.length===2)aux.delete('evicted:'+events[0][0]);\n }});\n for(let i=0;i<7;i++){cache.set('k'+i,{id:seed+i});if(i%2)cache.get('k'+(i-1))}\n return {events,cache:[...cache],aux:[...aux]};\n}"
  },
  {
    "id": "adversarial/koa--nested-error-unwinding",
    "project": "koa-compose",
    "modules": [
      "koa-compose"
    ],
    "adversarial": "nested async try/finally and recovery",
    "run": "async function run(seed) {\n const compose=__require('koa-compose'),ctx={log:[],response:{status:200}};\n const inside=compose([\n  async(c,next)=>{c.log.push('in>');try{await next()}finally{c.log.push('<in')}},\n  async(c,next)=>{c.response.status=500;throw Error('request:'+seed)}\n ]);\n const outside=compose([\n  async(c,next)=>{c.log.push('out>');try{await next()}catch(e){c.log.push(['caught',e.message]);c.response.status=418}finally{c.log.push('<out')}},\n  inside\n ]);\n await outside(ctx);return ctx;\n}"
  },
  {
    "id": "adversarial/koa--unawaited-downstream",
    "project": "koa-compose",
    "modules": [
      "koa-compose"
    ],
    "adversarial": "unawaited downstream microtasks and temporal ordering",
    "run": "async function run(seed) {\n const compose=__require('koa-compose'),ctx={log:[]};\n const app=compose([\n  async(c,next)=>{c.log.push('pre');next().then(()=>c.log.push('down-done'));c.log.push('post')},\n  async(c,next)=>{await Promise.resolve();c.log.push(['microtask',seed]);await next()}\n ]);\n await app(ctx);ctx.log.push('root-done');await Promise.resolve();await Promise.resolve();\n return ctx;\n}"
  },
  {
    "id": "adversarial/limit--thenable-assimilation",
    "project": "p-limit",
    "modules": [
      "p-limit",
      "yocto-queue"
    ],
    "adversarial": "custom thenable assimilation with concurrency",
    "run": "async function run(seed) {\n const limit=__require('p-limit').default(2),log=[];\n const thenable={then(resolve){log.push('then');resolve(seed+3)}};\n const jobs=[limit(async()=>{log.push('a');return await thenable}),\n   limit(async()=>{log.push('b');await Promise.resolve();return seed+1}),\n   limit(async()=>{log.push('c');return seed+2})];\n const values=await Promise.all(jobs);\n return {log,values,active:limit.activeCount,pending:limit.pendingCount};\n}"
  },
  {
    "id": "adversarial/limit--rejection-and-queue-cancel",
    "project": "p-limit",
    "modules": [
      "p-limit",
      "yocto-queue"
    ],
    "adversarial": "rejected task with pending cancellation",
    "run": "async function run(seed) {\n const limit=__require('p-limit').default(2),log=[];\n let release;const gate=new Promise(r=>release=r);\n const jobs=[limit(async()=>{log.push('held');await gate;return seed}),\n   limit(async()=>{log.push('rejected');throw Error('bad:'+seed)}),\n   limit(async()=>{log.push('third');await Promise.resolve();return seed+2})];\n await Promise.resolve();await Promise.resolve();\n const before={active:limit.activeCount,pending:limit.pendingCount};\n // Do not abandon an unhandled rejected promise: handlers are attached at creation.\n const outcomes=jobs.map(p=>p.then(v=>({ok:true,value:v}),e=>({ok:false,error:e.message})));\n limit.clearQueue();release();\n const settled=await Promise.all(outcomes.slice(0,2));\n return {log,before,settled,active:limit.activeCount,pending:limit.pendingCount};\n}"
  },
  {
    "id": "adversarial/axios--reentrant-handler-mutation",
    "project": "axios",
    "modules": [
      "axios-interceptors"
    ],
    "adversarial": "mutation during nested interceptor enumeration",
    "run": "function run(seed) {\n const Manager=__require('axios-interceptors').default,m=new Manager(),log=[];\n let entered=0,second;\n m.use(x=>{log.push(['first',x]);if(entered++===0){m.eject(second);m.use(v=>v*2)}return x+1});\n second=m.use(x=>{log.push(['second',x]);return x+seed});\n m.use(x=>{log.push(['third',x]);return x+3});\n const apply=v=>{let current=v;m.forEach(h=>{current=h.fulfilled(current)});return current};\n return {first:apply(1),second:apply(2),log,ids:m.handlers.map((h,i)=>h?i:null)};\n}"
  },
  {
    "id": "adversarial/application--cache-events-state",
    "project": "application",
    "modules": [
      "quick-lru",
      "mitt",
      "zustand",
      "yocto-queue"
    ],
    "adversarial": "aliased queue commands, LRU eviction and event-driven state",
    "run": "function run(seed) {\n const Queue=__require('yocto-queue').default,LRU=__require('quick-lru').default;\n const bus=__require('mitt').default(),store=__require('zustand').createStore(()=>({count:0})),log=[];\n const cache=new LRU({maxSize:2,onEviction:(k,v)=>{log.push(['evict',k,v]);bus.emit('evict',v)}});\n bus.on('evict',v=>store.setState(s=>({count:s.count+v})));\n store.subscribe(s=>log.push(['state',s.count]));\n const q=new Queue(),command={key:'a',value:seed};q.enqueue(command);q.enqueue(command);\n q.enqueue({key:'b',value:seed+1});q.enqueue({key:'c',value:seed+2});\n let n=0;for(const item of q){if(n++===1)item.value++;cache.set(item.key,item.value)}\n return {log,command,cache:[...cache],state:store.getState()};\n}"
  },
  {
    "id": "adversarial/application--async-request-bus",
    "project": "application",
    "modules": [
      "koa-compose",
      "mitt",
      "p-limit",
      "yocto-queue",
      "zustand"
    ],
    "adversarial": "concurrent middleware request and event state",
    "run": "async function run(seed) {\n const compose=__require('koa-compose'),limit=__require('p-limit').default(2);\n const bus=__require('mitt').default(),store=__require('zustand').createStore(()=>({hits:0})),log=[];\n bus.on('processed',id=>{store.setState(s=>({hits:s.hits+1}));log.push(['event',id])});\n const handle=compose([\n  async(c,next)=>{log.push(['enter',c.id]);try{await next()}finally{log.push(['leave',c.id])}},\n  async(c,next)=>{await Promise.resolve();bus.emit('processed',c.id);c.response={id:c.id,hits:store.getState().hits};await next()}\n ]);\n const tasks=[0,1,2,3].map(i=>limit(async()=>{const ctx={id:seed+i};await handle(ctx);return ctx.response}));\n return {responses:await Promise.all(tasks),log,state:store.getState()};\n}"
  }
];
