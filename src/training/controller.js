// Transactional selected-trajectory state machine for semantic-trace/5.
// No teacher records, VM instructions or source interpreter are loaded here.
import {decodeWitness,CONTINUATION_VERSION,canonicalCompletionPolicy,assertValue} from './format.js';
import {checkWitnessClaim} from './witness-check.js';
import {describeGraph} from './graph.js';
import {analyzeSemanticProgram} from './semantic-program.js';
import {materializeHostArguments,decodeHostPayload} from '../host/materialize.js';
import {hostOperation} from '../host/operations.js';

const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function fail(category,message) {
  const error=new Error(message);error.category=category;throw error;
}
function primitive(value){
  switch(value[0]){
    case 'null':return null;
    case 'undefined':return undefined;
    case 'str':case 'bool':return value[1];
    case 'bigint':return BigInt(value[1]);
    case 'num':return value[1]==='-0'?-0:value[1]==='NaN'?NaN:
      value[1]==='+Infinity'?Infinity:value[1]==='-Infinity'?-Infinity:value[1];
    default:fail('boundary','Unsupported primitive transport');
  }
}
export class SemanticController {
  constructor(context,{completionPolicy='call-return',capabilities=[],fixtureReplies=[],
    maxGenerated=4096,maxPacketBytes=1048576,observationAuthority='fixture',
    rootInvocation='i1',trackId='t0',receiver=['undefined'],retainedState=null,
    initialBindings={},captureAliases={},strictRequests=false}={}){
    if(!Array.isArray(context)||context.length!==2)fail('context','Expected code and input');
    const [code,input]=context.map(decodeWitness);
    if(code.kind!=='code'||input.kind!=='input')
      fail('context','Observed source/graph order');
    completionPolicy=canonicalCompletionPolicy(completionPolicy);
    if(!/^[a-z][a-z0-9:_-]*$/.test(rootInvocation)||
       !/^[a-z][a-z0-9:_-]*$/.test(trackId))fail('identity','Invalid execution owner');
    assertValue(receiver);
    if(!['fixture','broker'].includes(observationAuthority))
      fail('policy','Unrecognized external observation authority');
    if(observationAuthority==='broker'&&fixtureReplies.length)
      fail('policy','Broker observations cannot be combined with teacher fixtures');
    this.observationAuthority=observationAuthority;
    this.rootInvocation=rootInvocation;this.trackId=trackId;this.receiver=structuredClone(receiver);
    this.strictRequests=strictRequests;this.captureAliases=new Map(Object.entries(captureAliases));
    this.source=code.fields;this.input=input.fields;this.completionPolicy=completionPolicy;
    this.callSites=new Map(analyzeSemanticProgram(this.source.source).sites
      .filter(site=>site.role==='CallExpression'&&site.operation)
      .map(site=>[site.start+':'+site.end,site.operation]));
    this.randomState=this.source.randomSeed??null;
    this.capabilities=new Set(capabilities);this.fixtureReplies=structuredClone(fixtureReplies);
    this.maxGenerated=maxGenerated;this.maxPacketBytes=maxPacketBytes;
    this.heap=retainedState?.heap??new Map();
    this.locals=retainedState?.locals??new Map();
    for(const reference of this.input.retained??[])
      if(!this.heap.has(reference))fail('identity','Input claims an unavailable retained reference');
    for(const node of this.input.graph.objects){
      if(this.heap.has(node.id))fail('identity','Input overwrites a retained identity');
      this.heap.set(node.id,{
      kind:node.kind,prototype:node.prototype??'ordinary',
      properties:new Map(node.properties.map(p=>[p.key,structuredClone(p.value)]))
      });
    }
    for(const [name,value] of Object.entries(initialBindings)){
      assertValue(value);this.locals.set(this.captureAliases.get(name)??name,structuredClone(value));
    }
    for(const cell of this.captureAliases.values())
      if(!this.locals.has(cell))fail('capture','Closure captures an unavailable cell');
    this.stack=[rootInvocation];this.completion=null;
    this.effects=new Map();this.jobs=new Map();this.ready=[];
    this.claims=[];this.history=[];this.generated=0;this.pending=null;
    this.lastReturn=null;
    this.continuations=new Map();this.reactionSequence=0;this.blockedSync=null;
    this.callReturn=null;
    this.activeJob=null;this.scheduler=retainedState?.scheduler??{registration:0,ready:0};
    this.frameFunctions=new Map([[rootInvocation,this.source.entry]]);
    this.jobErrors=[];
  }
  setLocal(name,value){this.locals.set(this.captureAliases.get(name)??name,structuredClone(value));}
  visibleLocals(){
    const values=new Map(this.locals);
    for(const [name,cell] of this.captureAliases)values.set(name,this.locals.get(cell));
    return values;
  }
  promise(identity){
    const promise=this.heap.get(identity);
    if(promise?.kind!=='promise')fail('promise','Unknown owned Promise');
    return promise;
  }
  createPromise(identity,{external=null}={}){
    if(this.heap.has(identity))fail('identity','Duplicate Promise identity');
    this.heap.set(identity,{kind:'promise',properties:new Map(),state:'pending',
      result:null,adopted:null,external,reactions:[]});
  }
  settlePromise(identity,status,value,{external=false}={}){
    const promise=this.promise(identity);
    if(promise.state!=='pending')fail('promise','Promise already settled');
    if(promise.external&&!external)fail('authority','Only a broker observation settles an external Promise');
    if(status==='fulfilled'&&value[0]==='ref'&&this.heap.get(value[1])?.kind==='promise'){
      const target=value[1];let cursor=target;
      while(cursor){
        if(cursor===identity)fail('promise','Promise adoption cycle');
        cursor=this.promise(cursor).adopted;
      }
      const adopted=this.promise(target);promise.adopted=target;
      if(adopted.state==='pending')return;
      status=adopted.state;value=adopted.result;
    }
    promise.state=status;promise.result=structuredClone(value);
    this.refreshReady();
  }
  refreshReady(){
    // Adoption and reaction readiness are deterministic consequences of a
    // committed settlement. They are not invented model observations.
    let changed=true;
    while(changed){
      changed=false;
      for(const entity of this.heap.values())if(entity.kind==='promise'&&
          entity.state==='pending'&&entity.adopted){
        const target=this.promise(entity.adopted);
        if(target.state!=='pending'){
          entity.state=target.state;entity.result=structuredClone(target.result);changed=true;
        }
      }
    }
    const eligible=[];
    for(const [identity,continuation] of this.continuations){
      const promise=this.promise(continuation.promise);
      if(continuation.state==='waiting'&&promise.state!=='pending')
        eligible.push({identity,sequence:continuation.sequence,continuation});
    }
    for(const [identity,job] of this.jobs)if(job.status==='waiting'&&job.promise&&
      this.promise(job.promise).state!=='pending')eligible.push({identity,sequence:job.sequence,job});
    eligible.sort((a,b)=>a.sequence-b.sequence);
    for(const item of eligible){
      if(item.continuation){item.continuation.state='ready';item.continuation.readySequence=++this.scheduler.ready;}
      else {item.job.status='queued';item.job.readySequence=++this.scheduler.ready;}
      this.ready.push(item.identity);
    }
    for(const job of this.jobs.values())if(job.status==='waiting-cleanup'){
      const cleanup=this.promise(job.cleanup);
      if(cleanup.state!=='pending'){
        job.status='completed';
        if(job.target)this.settlePromise(job.target,
          cleanup.state==='rejected'?'rejected':job.originalStatus,
          cleanup.state==='rejected'?cleanup.result:job.originalResult);
      }
    }
  }
  get firstWitnessViolation(){return this.claims.find(v=>!v.consistent)??null;}
  readProperty(object,key){
    const target=this.heap.get(object);
    if(!target)fail('identity','Read from unallocated object');
    return target.properties.get(key)??['undefined'];
  }
  materialize(value,visited=new Map()) {
    const recur=v=>{
      if(v[0]!=='ref')return primitive(v);
      const id=v[1];
      if(visited.has(id))return visited.get(id);
      const entity=this.heap.get(id);
      if(!entity)fail('identity','Returned unknown identity');
      if(!['array','object'].includes(entity.kind))
        fail('unsupported-boundary','Rich behavioral identity cannot cross ordinary data graph');
      const length=entity.kind==='array'?primitive(entity.properties.get('length')):null;
      const obj=entity.kind==='array'?new Array(length):
        entity.prototype===null?Object.create(null):{};
      visited.set(id,obj);
      for(const [key,member] of entity.properties)
        if(entity.kind!=='array'||key!=='length')
          Object.defineProperty(obj,key,{value:recur(member),
            writable:true,configurable:true,enumerable:true});
      return obj;
    };
    return recur(value);
  }
  observedGraph(){
    if(!this.completion)return null;
    const seen=new Map();
    return describeGraph([
      ...this.input.graph.roots.map(v=>this.materialize(v,seen)),
      this.materialize(this.completion.value,seen)
    ]);
  }
  commit(line,{mode='generated',track=this.trackId}={}){
    const prior=structuredClone({
      heap:this.heap,locals:this.locals,stack:this.stack,completion:this.completion,
      effects:this.effects,jobs:this.jobs,ready:this.ready,
      pending:this.pending,lastReturn:this.lastReturn,fixtureReplies:this.fixtureReplies,
      claims:this.claims,generated:this.generated,history:this.history,
      randomState:this.randomState,continuations:this.continuations,
      reactionSequence:this.reactionSequence,blockedSync:this.blockedSync,callReturn:this.callReturn,
      activeJob:this.activeJob,captureAliases:this.captureAliases,scheduler:this.scheduler,
      frameFunctions:this.frameFunctions,jobErrors:this.jobErrors
    });
    try {
      if(typeof line!=='string'||Buffer.byteLength(line,'utf8')>65536)
        fail('resource-limit','Selected semantic record exceeds byte budget');
      const {kind,fields:f}=decodeWitness(line);
      if(track!==this.trackId)fail('lane','Unregistered witness lane');
      if(this.completion)fail('completion','Record after terminal end');
      if(mode==='observed'&&kind!=='observe')fail('visibility','Only delivered observations are observed');
      if(mode==='generated'&&kind==='observe')fail('visibility','Model cannot supply external facts');
      if(mode==='generated'&&++this.generated>this.maxGenerated)
        fail('resource-limit','Generated record limit');
      if(mode==='generated'&&this.blockedSync)
        fail('synchronous-effect','Synchronous call requires its observed return before guest continuation');
      if(mode==='generated'&&!this.stack.length&&
         !['resume','job','end','promise'].includes(kind))
        fail('suspended','Selected work requires a runnable guest frame');
      const active=this.stack.at(-1);
      if(f.invocation&&f.invocation!==active&&kind!=='resume')
        fail('invocation','Selected work is not in the active invocation');
      const known=value=>{
        if(value?.[0]==='ref'&&!this.heap.has(value[1])&&
           !(kind==='allocate'&&value[1]===f.name))
          fail('identity','Selected value refers to an unallocated owned identity');
      };
      if(kind!=='observe'){
        for(const field of ['value','result','decision','receiver'])if(f[field]!==undefined)known(f[field]);
        for(const value of f.arguments??[])known(value);
        for(const property of f.properties??[])known(property.value);
      }
      if(kind==='compute'||kind==='choose'){
        const claimed=kind==='compute'?f.result:f.decision;
        const claim=checkWitnessClaim(f.expr,claimed,{
          locals:this.visibleLocals(),randomState:this.randomState,
          readProperty:(id,key)=>this.readProperty(id,key)});
        if(f.expr.op==='random'){
          if(this.randomState===null)
            fail('capability','Random computation requires a declared fixture seed');
          this.randomState=(Math.imul(this.randomState,1664525)+1013904223)>>>0;
        }
        this.claims.push({index:this.history.length,kind,...claim});
        // Witness inconsistency is a diagnostic; selected state is not
        // silently repaired from the checker or a reference outcome.
        if(kind==='compute'&&f.bind)this.setLocal(f.bind,f.result);
        if(kind==='choose'){
          const selected=['then','evaluate-right'].includes(f.path);
          const evaluated=f.decision[0]==='ref'?true:Boolean(primitive(f.decision));
          // JavaScript ToBoolean accepts every object reference; no host-side
          // conversion hook is invoked for a truthiness decision.
          if(['then','else'].includes(f.path)&&selected!==evaluated)
            this.claims.push({index:this.history.length,kind,consistent:false,
              reason:'Choice contradicts its own declared decision'});
        }
      }else if(kind==='bind'){
        const locals=this.visibleLocals();
        if(f.from!==undefined&&
           (!locals.has(f.from)||!eq(locals.get(f.from),f.value)))
          fail('binding','Iteration cell copy contradicts the committed source cell');
        this.setLocal(f.name,f.value);
      }else if(kind==='allocate'){
        if(this.heap.has(f.name))fail('identity','Duplicate allocation');
        const props=new Map();
        for(const property of f.properties){
          if(!property||typeof property.key!=='string'||props.has(property.key))
            fail('identity','Malformed allocation property');
          props.set(property.key,structuredClone(property.value));
        }
        if(f.kind==='array'){
          if(!Number.isSafeInteger(f.length)||f.length<0||f.length>4096)
            fail('array','Invalid allocated array length');
          props.set('length',['num',f.length]);
        }
        const captures=structuredClone(f.captures??[]).map(capture=>({...capture,
          cell:this.captureAliases.get(capture.cell)??capture.cell}));
        if(f.kind==='closure')for(const {cell} of captures)
          if(!this.locals.has(cell))
            fail('capture','Closure references a cell not yet committed');
        this.heap.set(f.name,{kind:f.kind,code:f.code??null,
          captures,prototype:'ordinary',properties:props});
      }else if(kind==='read'){
        const obj=this.heap.get(f.object);
        if(!obj)fail('identity','Unallocated read');
        const present=obj.properties.has(f.key);
        if(present!==f.present||!eq(this.readProperty(f.object,f.key),f.value))
          fail('read','Read contradicts committed public heap');
      }else if(kind==='write'){
        const obj=this.heap.get(f.object);
        if(!obj)fail('identity','Unallocated write');
        if(obj.kind==='array'&&f.key==='length'){
          if(!f.present||f.value[0]!=='num'||!Number.isSafeInteger(f.value[1])||
             f.value[1]<0||f.value[1]>4096)fail('array','Invalid length mutation');
          for(const key of obj.properties.keys())
            if(/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)>=f.value[1])
              obj.properties.delete(key);
        }
        if(f.present)obj.properties.set(f.key,structuredClone(f.value));
        else obj.properties.delete(f.key);
        if(obj.kind==='array'&&/^(0|[1-9][0-9]*)$/.test(f.key)&&
           Number(f.key)>=obj.properties.get('length')[1])
          obj.properties.set('length',['num',Number(f.key)+1]);
      }else if(kind==='call'){
        if(typeof f.child!=='string'||this.frameFunctions.has(f.child))
          fail('invocation','Duplicate child invocation');
        const callee=this.heap.get(f.callee)?.code??f.callee;
        if(this.strictRequests){
          const functions=analyzeSemanticProgram(this.source.source).functions;
          if(!functions.some(fn=>fn.name===callee||'function:'+fn.start===callee))
            fail('invocation','Guest callee is absent from immutable source context');
          for(const value of [f.receiver,...f.arguments])
            if(value[0]==='ref'&&!this.heap.has(value[1]))fail('identity','Call uses an unowned receiver or argument');
        }
        this.frameFunctions.set(f.child,callee);
        this.stack.push(f.child);
      }else if(kind==='return'||kind==='throw'){
        if(this.stack.length===1&&this.activeJob){
          this.stack.pop();this.jobs.get(this.activeJob).returned={kind,value:structuredClone(f.value)};
        }else if(this.stack.length>1){
          this.stack.pop();
          this.lastReturn={kind,value:structuredClone(f.value)};
        }else {
          this.pending={kind,value:structuredClone(f.value)};
          // Root has actually returned. Only now may queued microtasks
          // legally dispatch; terminal end waits for their disposition.
          this.stack.pop();
        }
      }else if(kind==='transfer'){
        if(!['return','throw','cleanup'].includes(f.kind))
          fail('completion','Unsupported completion transfer');
        this.pending={kind:f.kind,value:structuredClone(f.value),handler:f.handler};
      }else if(kind==='request'){
        if(!this.capabilities.has(f.operation))fail('capability','External operation not granted');
        if(this.effects.has(f.effect))fail('effect','Effect identity reused');
        if(f.invocation!==active||
           this.callSites.get(f.site.start+':'+f.site.end)!==f.operation)
          fail('invocation','External request must identify its active JS callsite');
        if(this.strictRequests){
          const enclosing=analyzeSemanticProgram(this.source.source).functions.filter(fn=>
            fn.start<=f.site.start&&fn.end>=f.site.end).sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
          const entry=this.frameFunctions.get(active);
          if(!enclosing||(entry!==enclosing.name&&entry!=='function:'+enclosing.start))
            fail('invocation','External callsite belongs to another guest function');
        }
        let spec;
        try {spec=hostOperation(f.operation);}
        catch{fail('capability','Unregistered external operation');}
        if(spec.kind==='promise'&&this.strictRequests&&!f.promise)
          fail('promise','Promise-returning request must bind an owned Promise identity');
        if(f.promise&&spec.kind!=='promise')fail('promise','Synchronous request cannot return a Promise');
        if(this.strictRequests&&this.firstWitnessViolation)
          fail('witness','Inconsistent selected semantics cannot authorize an external effect');
        if(f.arguments.length!==spec.arity||
           (spec.key!==null&&f.arguments[spec.key]?.[0]!=='str'))
          fail('request-arguments','External invocation violates operation signature');
        // The owned host codec is the single authority for guest argument
        // materialization. The current committed heap, not a future final
        // graph or a parallel primitive-only path, supplies references.
        const heap=Object.fromEntries([...this.heap].map(([id,node])=>[id,{
          kind:node.kind,prototype:node.prototype,
          properties:Object.fromEntries([...node.properties].map(([key,value])=>[
            key,{value}
          ]))
        }]));
        let prepared;
        try {prepared=materializeHostArguments(heap,f.arguments,{codec:spec.codec,
          callbackIndices:spec.callbackIndices??[],callbackGraph:spec.callbackGraph??false});}
        catch(error){fail('request-arguments',error.message);}
        if(prepared.payload!==f.payload)
          fail('request-arguments','External payload differs from grounded arguments');
        // Continuations retain canonical transport data, not decoded native
        // cycles or BigInts. Native realization belongs only to dispatch.
        const args=spec.codec==='owned-graph/1'?JSON.parse(prepared.payload):
          decodeHostPayload(prepared.payload,spec.codec,
            {callbackIndices:spec.callbackIndices??[],callbackGraph:spec.callbackGraph??false});
        // Ordering of authorized effects is observable: do not search for
        // a convenient matching future reply in an unordered fixture bag.
        const matched=this.observationAuthority==='fixture'?
          this.fixtureReplies.find(e=>!e.claimed):null;
        if(this.observationAuthority==='fixture'){
          if(!matched||matched.operation!==f.operation||!eq(matched.arguments,args))
            fail('request-mismatch','Selected request differs from next authorized fixture');
          matched.claimed=true;
        }
        this.effects.set(f.effect,{operation:f.operation,invocation:f.invocation,
          site:structuredClone(f.site),payload:f.payload,
          arguments:structuredClone(args),argumentCodec:spec.codec,status:'requested',
          fixture:structuredClone(matched),promise:f.promise??null});
        if(f.promise)this.createPromise(f.promise,{external:f.effect});
        if(spec.kind==='synchronous')this.blockedSync=f.effect;
      }else if(kind==='observe'){
        const effect=this.effects.get(f.effect);
        if(!effect||effect.status!=='requested')
          fail('effect','Observation lacks an outstanding request');
        if((f.graph||f.result[0]==='ref')&&hostOperation(effect.operation).resultCodec!=='owned-graph/1')
          fail('observation','Operation has no declared result graph codec');
        if(effect.fixture&&(effect.fixture.status!==f.status||!eq(effect.fixture.result,f.result)))
          fail('observation','External delivery differs from committed fixture');
        if(f.graph)for(const node of f.graph.objects){
          if(this.heap.has(node.id))fail('identity','Observed graph overwrites an owned identity');
          this.heap.set(node.id,{kind:node.kind,prototype:node.prototype??'ordinary',
            properties:new Map(node.properties.map(property=>[property.key,
              structuredClone(property.value)]))});
        }
        if(f.result[0]==='ref'&&!this.heap.has(f.result[1]))
          fail('identity','Observed result references an unknown identity');
        effect.status=f.status;effect.result=structuredClone(f.result);
        if(effect.promise)this.settlePromise(effect.promise,f.status,f.result,{external:true});
        if(this.blockedSync===f.effect)this.blockedSync=null;
      }else if(kind==='promise'){
        if(f.action==='create')this.createPromise(f.promise);
        else if(f.action==='resolve'||f.action==='reject')
          this.settlePromise(f.promise,f.action==='resolve'?'fulfilled':'rejected',f.value);
        else if(f.action==='adopt')
          this.settlePromise(f.promise,'fulfilled',['ref',f.target]);
        else {
          this.promise(f.promise);
          if(this.jobs.has(f.job)||this.continuations.has(f.job))fail('job','Duplicate reaction identity');
          if(f.closure&&this.heap.get(f.closure)?.kind!=='closure')fail('capture','Reaction requires owned closure');
          if(f.rejectionClosure&&this.heap.get(f.rejectionClosure)?.kind!=='closure')
            fail('capture','Rejected reaction requires owned closure');
          if(f.target)this.createPromise(f.target);
          this.jobs.set(f.job,{status:'waiting',owner:this.rootInvocation,promise:f.promise,
            reaction:f.reaction,closure:f.closure??null,rejectionClosure:f.rejectionClosure??null,target:f.target??null,
            sequence:++this.scheduler.registration});
          this.refreshReady();
        }
      }else if(kind==='await'){
        this.promise(f.promise);
        if(f.returnPromise){
          this.promise(f.returnPromise);
          if(this.stack.length!==1||this.callReturn)
            fail('promise','Immediate async call return requires first root suspension');
          this.callReturn={kind:'return',value:['ref',f.returnPromise]};
        }
        if(this.continuations.has(f.continuation)||this.jobs.has(f.continuation))
          fail('continuation','Duplicate continuation identity');
        this.continuations.set(f.continuation,{state:'waiting',promise:f.promise,
          invocation:this.stack.pop(),sequence:++this.scheduler.registration,
          activeJob:this.activeJob,captureAliases:[...this.captureAliases]});
        if(this.activeJob){
          this.captureAliases=new Map(this.jobs.get(this.activeJob).priorAliases);
          this.activeJob=null;
        }
        this.refreshReady();
      }else if(kind==='resume'){
        const continuation=this.continuations.get(f.continuation);
        if(this.stack.length||this.ready[0]!==f.continuation||
           continuation?.state!=='ready'||continuation.invocation!==f.invocation)
          fail('continuation','Resume violates owned dependency, turn ownership or FIFO order');
        const promise=this.promise(continuation.promise);
        if(promise.state!==f.status||!eq(promise.result,f.result))
          fail('continuation','Resume contradicts its observed Promise settlement');
        this.ready.shift();continuation.state='resumed';
        this.stack.push(continuation.invocation);
        this.activeJob=continuation.activeJob;
        this.captureAliases=new Map(continuation.captureAliases);
      }else if(kind==='job'){
        if(f.action==='enqueue'){
          if(this.jobs.has(f.job)||this.continuations.has(f.job))fail('job','Duplicate scheduled job');
          if(f.owner!==this.rootInvocation)fail('job','Job owner must match its invocation domain');
          if(f.closure&&this.heap.get(f.closure)?.kind!=='closure')fail('capture','Job requires an owned closure');
          this.jobs.set(f.job,{status:'queued',owner:f.owner,closure:f.closure??null,
            readySequence:++this.scheduler.ready});
          this.ready.push(f.job);
        }else if(f.action==='dispatch'){
          if(this.jobs.get(f.job)?.owner!==f.owner)fail('job','Job owner mismatch');
          if(this.stack.length)
            fail('job','Owned jobs cannot dispatch before current stack unwinds');
          if(this.ready[0]!==f.job||this.jobs.get(f.job)?.status!=='queued')
            fail('job','Dispatch violates owned FIFO queue');
          this.ready.shift();this.jobs.get(f.job).status='running';
          const job=this.jobs.get(f.job);
          let callback=job.closure,argument=['undefined'];
          if(job.promise){
            const promise=this.promise(job.promise);
            job.originalStatus=promise.state;job.originalResult=structuredClone(promise.result);
            if(job.reaction==='then'&&promise.state==='rejected')callback=job.rejectionClosure;
            else if(job.reaction==='catch'&&promise.state==='fulfilled')callback=null;
            if(job.reaction!=='finally')argument=promise.result;
          }
          if(callback){
              const closure=this.heap.get(callback);
              job.priorAliases=[...this.captureAliases];
              this.captureAliases=new Map((closure.captures??[]).map(c=>[c.binding,c.cell]));
              const fn=analyzeSemanticProgram(this.source.source).functions.find(fn=>
                fn.name===closure.code||'function:'+fn.start===closure.code);
              if(!fn)fail('capture','Promise reaction closure has no source site');
              for(const [index,name] of fn.params.entries())if(name){
                const base='j'+f.job+'p'+index;
                let cell=base,ordinal=0;
                while(this.locals.has(cell))cell=base+'x'+(++ordinal);
                this.captureAliases.set(name,cell);
                this.locals.set(cell,index===0?structuredClone(argument):['undefined']);
              }
              this.activeJob=f.job;this.stack.push('job:'+f.job);
              this.frameFunctions.set('job:'+f.job,closure.code);
          }
        }else{
          if(this.jobs.get(f.job)?.owner!==f.owner)fail('job','Job owner mismatch');
          if(this.jobs.get(f.job)?.status!=='running')
            fail('job','Complete requires a running owned job');
          const job=this.jobs.get(f.job);
          if(this.stack.length||this.activeJob&&this.activeJob!==f.job)
            fail('job','Cannot complete a running callback frame');
          job.status='completed';
          if(this.activeJob===f.job){
            this.captureAliases=new Map(job.priorAliases);this.activeJob=null;
          }
          if(job.promise){
            const returned=job.returned;
            if(job.target){
              if(returned?.kind==='throw')this.settlePromise(job.target,'rejected',returned.value);
              else if(job.reaction==='finally'&&returned?.value[0]==='ref'&&
                  this.heap.get(returned.value[1])?.kind==='promise'){
                job.status='waiting-cleanup';job.cleanup=returned.value[1];this.refreshReady();
              }else if(job.reaction==='finally'||!returned)
                this.settlePromise(job.target,job.originalStatus,job.originalResult);
              else this.settlePromise(job.target,'fulfilled',returned.value);
            }
          }else if(job.returned?.kind==='throw')this.jobErrors.push({job:f.job,
            value:structuredClone(job.returned.value)});
        }
      }else if(kind==='end'){
        const terminal=this.completionPolicy==='owned-quiescence'&&this.jobErrors.length?
          {kind:'throw',value:this.jobErrors[0].value}:this.pending;
        if(!terminal||terminal.kind!==f.kind)
          fail('completion','End does not match selected root completion');
        if(this.ready.length||[...this.jobs.values()].some(j=>j.status!=='completed')||
           [...this.continuations.values()].some(c=>c.state!=='resumed')||
           [...this.effects.values()].some(e=>e.status==='requested'))
          fail('incomplete','Required work remains pending');
        this.completion=structuredClone(terminal);
        if(this.completionPolicy==='await-returned-promise'&&
           this.pending.value[0]==='ref'&&this.heap.get(this.pending.value[1])?.kind==='promise'){
          const returned=this.promise(this.pending.value[1]);
          if(returned.state==='pending')fail('incomplete','Returned Promise remains pending');
          this.completion={kind:returned.state==='fulfilled'?'return':'throw',
            value:structuredClone(returned.result)};
        }
        delete this.pending;
      }else fail('operation','Unsupported selected semantic record');
      this.history.push({mode,track,record:line});
      return {status:this.completion?'completed':'committed',firstWitnessViolation:this.firstWitnessViolation};
    }catch(error){
      // Other invocations in a retained realm hold these same maps. Rollback
      // must preserve their identity, not strand them on an obsolete heap.
      for(const field of ['heap','locals']){
        this[field].clear();for(const [key,value] of prior[field])this[field].set(key,value);
        prior[field]=this[field];
      }
      Object.assign(this.scheduler,prior.scheduler);prior.scheduler=this.scheduler;
      Object.assign(this,prior);
      throw error;
    }
  }
  segmentPacket(){
    const packet={schema:CONTINUATION_VERSION,source:'committed-selected-state',
      input:this.input,context:this.source,policy:this.completionPolicy,
      observationAuthority:this.observationAuthority,
      capabilities:[...this.capabilities],heap:[...this.heap].map(([key,node])=>[
        key,{...node,properties:[...node.properties]}]),locals:[...this.locals],
      stack:this.stack,effects:[...this.effects],jobs:[...this.jobs],ready:this.ready,
      claims:this.claims,history:this.history,generated:this.generated,
      randomState:this.randomState,fixtureReplies:this.fixtureReplies,
      maxGenerated:this.maxGenerated,maxPacketBytes:this.maxPacketBytes,
      pending:this.pending??null,lastReturn:this.lastReturn??null,
      completion:this.completion,rootInvocation:this.rootInvocation,trackId:this.trackId,
      receiver:this.receiver,captureAliases:[...this.captureAliases],
      strictRequests:this.strictRequests,continuations:[...this.continuations],
      reactionSequence:this.reactionSequence,blockedSync:this.blockedSync,callReturn:this.callReturn,
      activeJob:this.activeJob,scheduler:this.scheduler};
    packet.frameFunctions=[...this.frameFunctions];
    packet.jobErrors=this.jobErrors;
    if(Buffer.byteLength(JSON.stringify(packet),'utf8')>this.maxPacketBytes)
      fail('resource-limit','Committed continuation exceeds packet budget');
    return structuredClone(packet);
  }
  static fromPacket(packet,options={}){
    if(packet?.schema!==CONTINUATION_VERSION||packet.source!=='committed-selected-state')
      fail('continuation','Wrong committed-state packet version');
    if(!(packet.randomState===null||Number.isInteger(packet.randomState)&&packet.randomState>=0&&packet.randomState<=0xffffffff))
      fail('continuation','Committed-state packet requires an explicit null or unsigned 32-bit random state');
    const copied=structuredClone(packet);
    const controller=new SemanticController([
      'code '+JSON.stringify(packet.context),'input '+JSON.stringify({graph:{roots:[],objects:[]}})
    ],{...options,completionPolicy:packet.policy,capabilities:packet.capabilities,
      fixtureReplies:packet.fixtureReplies,observationAuthority:packet.observationAuthority??'fixture',
      maxGenerated:packet.maxGenerated,
      maxPacketBytes:packet.maxPacketBytes,rootInvocation:packet.rootInvocation,
      trackId:packet.trackId,receiver:packet.receiver,strictRequests:packet.strictRequests});
    controller.input=copied.input;
    controller.heap=new Map(copied.heap.map(([id,e])=>[id,{...e,properties:new Map(e.properties)}]));
    controller.locals=new Map(copied.locals);controller.stack=copied.stack;
    controller.effects=new Map(copied.effects);controller.jobs=new Map(copied.jobs);
    controller.ready=copied.ready;controller.claims=copied.claims;
    controller.history=copied.history;controller.generated=copied.generated;
    controller.randomState=packet.randomState;
    controller.pending=copied.pending;controller.lastReturn=copied.lastReturn;
    controller.completion=copied.completion;
    controller.captureAliases=new Map(copied.captureAliases);
    controller.continuations=new Map(copied.continuations);
    controller.reactionSequence=copied.reactionSequence;controller.blockedSync=copied.blockedSync;
    controller.callReturn=copied.callReturn;
    controller.activeJob=copied.activeJob;controller.scheduler=copied.scheduler;
    controller.frameFunctions=new Map(copied.frameFunctions);
    controller.jobErrors=copied.jobErrors;
    return controller;
  }
}
