// Transactional selected-trajectory state machine for semantic-trace/3.
// No teacher records, VM instructions or source interpreter are loaded here.
import {decodeWitness,EXECUTION_VERSION,CONTEXT_VERSION} from './format.js';
import {checkWitnessClaim} from './witness-check.js';
import {describeGraph} from './graph.js';
import {analyzeSemanticProgram} from './semantic-program.js';
import {materializeJson} from '../host/materialize.js';
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
  constructor(context,{completionPolicy='immediate-root',capabilities=[],fixtureReplies=[],
    maxGenerated=4096,maxPacketBytes=65536,observationAuthority='fixture'}={}){
    if(!Array.isArray(context)||context.length!==2)fail('context','Expected code and input');
    const [code,input]=context.map(decodeWitness);
    if(code.kind!=='code'||input.kind!=='input')
      fail('context','Observed source/graph order');
    if(!['immediate-root','owned-quiescence'].includes(completionPolicy))
      fail('policy','Unrecognized completion policy');
    if(!['fixture','broker'].includes(observationAuthority))
      fail('policy','Unrecognized external observation authority');
    if(observationAuthority==='broker'&&fixtureReplies.length)
      fail('policy','Broker observations cannot be combined with teacher fixtures');
    this.observationAuthority=observationAuthority;
    this.source=code.fields;this.input=input.fields;this.completionPolicy=completionPolicy;
    this.callSites=new Map(analyzeSemanticProgram(this.source.source).sites
      .filter(site=>site.role==='CallExpression'&&site.operation)
      .map(site=>[site.start+':'+site.end,site.operation]));
    this.randomState=this.source.randomSeed??null;
    this.capabilities=new Set(capabilities);this.fixtureReplies=structuredClone(fixtureReplies);
    this.maxGenerated=maxGenerated;this.maxPacketBytes=maxPacketBytes;
    this.heap=new Map(this.input.graph.objects.map(node=>[node.id,{
      kind:node.kind,prototype:node.prototype??'ordinary',
      properties:new Map(node.properties.map(p=>[p.key,structuredClone(p.value)]))
    }]));
    this.locals=new Map();
    this.stack=['i1'];this.completion=null;
    this.effects=new Map();this.jobs=new Map();this.ready=[];
    this.claims=[];this.history=[];this.generated=0;this.pending=null;
    this.lastReturn=null;
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
  commit(line,{mode='generated',track='t0'}={}){
    const prior=structuredClone({
      heap:this.heap,locals:this.locals,stack:this.stack,completion:this.completion,
      effects:this.effects,jobs:this.jobs,ready:this.ready,
      pending:this.pending,lastReturn:this.lastReturn,fixtureReplies:this.fixtureReplies,
      claims:this.claims,generated:this.generated,history:this.history,
      randomState:this.randomState
    });
    try {
      const {kind,fields:f}=decodeWitness(line);
      if(track!=='t0')fail('lane','Unregistered witness lane');
      if(this.completion)fail('completion','Record after terminal end');
      if(mode==='observed'&&kind!=='observe')fail('visibility','Only delivered observations are observed');
      if(mode==='generated'&&kind==='observe')fail('visibility','Model cannot supply external facts');
      if(mode==='generated'&&++this.generated>this.maxGenerated)
        fail('resource-limit','Generated record limit');
      const active=this.stack.at(-1);
      if(f.invocation&&f.invocation!==active)
        fail('invocation','Selected work is not in the active invocation');
      if(kind==='compute'||kind==='choose'){
        const claimed=kind==='compute'?f.result:f.decision;
        const claim=checkWitnessClaim(f.expr,claimed,{
          locals:this.locals,randomState:this.randomState,
          readProperty:(id,key)=>this.readProperty(id,key)});
        if(f.expr.op==='random'){
          if(this.randomState===null)
            fail('capability','Random computation requires a declared fixture seed');
          this.randomState=(Math.imul(this.randomState,1664525)+1013904223)>>>0;
        }
        this.claims.push({index:this.history.length,kind,...claim});
        // Witness inconsistency is a diagnostic; selected state is not
        // silently repaired from the checker or a reference outcome.
        if(kind==='compute'&&f.bind)this.locals.set(f.bind,structuredClone(f.result));
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
        if(f.from!==undefined&&
           (!this.locals.has(f.from)||!eq(this.locals.get(f.from),f.value)))
          fail('binding','Iteration cell copy contradicts the committed source cell');
        this.locals.set(f.name,structuredClone(f.value));
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
        const captures=structuredClone(f.captures??[]);
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
        if(typeof f.child!=='string'||this.stack.includes(f.child))
          fail('invocation','Duplicate child invocation');
        this.stack.push(f.child);
      }else if(kind==='return'||kind==='throw'){
        if(this.stack.length>1){
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
        let spec;
        try {spec=hostOperation(f.operation);}
        catch{fail('capability','Unregistered external operation');}
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
        try {prepared=materializeJson(heap,f.arguments,{callbackIndices:spec.callbackIndices??[]});}
        catch(error){fail('request-arguments',error.message);}
        if(prepared.payload!==f.payload)
          fail('request-arguments','External payload differs from grounded arguments');
        const args=JSON.parse(prepared.payload);
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
          arguments:structuredClone(args),status:'requested',
          fixture:structuredClone(matched)});
      }else if(kind==='observe'){
        const effect=this.effects.get(f.effect);
        if(!effect||effect.status!=='requested')
          fail('effect','Observation lacks an outstanding request');
        if(effect.fixture&&(effect.fixture.status!==f.status||!eq(effect.fixture.result,f.result)))
          fail('observation','External delivery differs from committed fixture');
        effect.status=f.status;effect.result=structuredClone(f.result);
      }else if(kind==='job'){
        if(f.action==='enqueue'){
          if(this.jobs.has(f.job))fail('job','Duplicate scheduled job');
          this.jobs.set(f.job,{status:'queued',owner:f.owner});
          this.ready.push(f.job);
        }else if(f.action==='dispatch'){
          if(this.stack.length)
            fail('job','Owned jobs cannot dispatch before current stack unwinds');
          if(this.ready[0]!==f.job||this.jobs.get(f.job)?.status!=='queued')
            fail('job','Dispatch violates owned FIFO queue');
          this.ready.shift();this.jobs.get(f.job).status='running';
        }else{
          if(this.jobs.get(f.job)?.status!=='running')
            fail('job','Complete requires a running owned job');
          this.jobs.get(f.job).status='completed';
        }
      }else if(kind==='end'){
        if(!this.pending||this.pending.kind!==f.kind)
          fail('completion','End does not match selected root completion');
        if(this.ready.length||[...this.jobs.values()].some(j=>j.status!=='completed')||
           [...this.effects.values()].some(e=>e.status==='requested'))
          fail('incomplete','Required work remains pending');
        this.completion=structuredClone(this.pending);
        delete this.pending;
      }else fail('operation','Unsupported selected semantic record');
      this.history.push({mode,track,record:line});
      return {status:this.completion?'completed':'committed',firstWitnessViolation:this.firstWitnessViolation};
    }catch(error){
      Object.assign(this,prior);
      throw error;
    }
  }
  segmentPacket(){
    const packet={schema:'semantic-continuation/3',source:'committed-selected-state',
      input:this.input,context:this.source,policy:this.completionPolicy,
      observationAuthority:this.observationAuthority,
      capabilities:[...this.capabilities],heap:[...this.heap],locals:[...this.locals],
      stack:this.stack,effects:[...this.effects],jobs:[...this.jobs],ready:this.ready,
      claims:this.claims,history:this.history,generated:this.generated,
      randomState:this.randomState,fixtureReplies:this.fixtureReplies,
      maxGenerated:this.maxGenerated,maxPacketBytes:this.maxPacketBytes,
      pending:this.pending??null,lastReturn:this.lastReturn??null,
      completion:this.completion};
    if(Buffer.byteLength(JSON.stringify(packet),'utf8')>this.maxPacketBytes)
      fail('resource-limit','Committed continuation exceeds packet budget');
    return structuredClone(packet);
  }
  static fromPacket(packet,options={}){
    if(packet?.schema!=='semantic-continuation/3'||packet.source!=='committed-selected-state')
      fail('continuation','Wrong committed-state packet version');
    const controller=new SemanticController([
      'code '+JSON.stringify(packet.context),'input '+JSON.stringify(packet.input)
    ],{...options,completionPolicy:packet.policy,capabilities:packet.capabilities,
      fixtureReplies:packet.fixtureReplies,observationAuthority:packet.observationAuthority??'fixture',
      maxGenerated:packet.maxGenerated,
      maxPacketBytes:packet.maxPacketBytes});
    controller.heap=new Map(packet.heap.map(([id,e])=>[id,{...e,properties:new Map(e.properties)}]));
    controller.locals=new Map(packet.locals);controller.stack=packet.stack;
    controller.effects=new Map(packet.effects);controller.jobs=new Map(packet.jobs);
    controller.ready=packet.ready;controller.claims=packet.claims;
    controller.history=packet.history;controller.generated=packet.generated;
    controller.randomState=packet.randomState;
    controller.pending=packet.pending;controller.lastReturn=packet.lastReturn;
    controller.completion=packet.completion;
    return controller;
  }
}
