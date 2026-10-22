// Serving-side semantic controller: it never runs source code, computes missing
// arithmetic, or replaces a selected model trajectory with reference state.
// It validates and commits only explicitly generated records and observations.
import {isDeepStrictEqual} from 'node:util';
import {decodeRecord,restoreLines} from './format.js';

const same=(a,b)=>isDeepStrictEqual(a,b);
const copy=value=>structuredClone(value);
const fail=(category,message)=>{const e=new Error(message);e.category=category;throw e;};

function parseContext(lines) {
  if(!Array.isArray(lines))fail('context','Missing observed source/input lines');
  const normalized=restoreLines(lines);
  if(normalized.length!==2)fail('context','Expected one code and one input graph');
  const source=decodeRecord(normalized[0]),input=decodeRecord(normalized[1]);
  if(source.kind!=='code' || input.kind!=='value' ||
      typeof source.fields.text!=='string'|| !Array.isArray(source.fields.codes) ||
      !input.fields.graph || !Array.isArray(input.fields.graph.roots))
    fail('context','Malformed predictor-visible source/input prefix');
  return {source:source.fields,input:input.fields};
}

export class SemanticController {
  constructor(lines,{maxGenerated=256,maxPacketBytes=65536}={}) {
    const {source,input}=parseContext(lines);
    this.source=copy(source);this.input=copy(input);
    this.maxGenerated=maxGenerated;this.maxPacketBytes=maxPacketBytes;
    this.codes=new Map(source.codes.map(code=>[code.id,code]));
    this.sites=new Set(source.sites.map(site=>site.id));
    this.heap=new Map();
    this.staticFunctions=new Map();
    for(const fn of source.staticFunctions??[]){
      if(!this.codes.has(fn.code)||this.heap.has(fn.identity))
        fail('context','Invalid static function allocation');
      this.heap.set(fn.identity,{kind:'function',code:fn.code,captures:fn.captures,
        shapeVersion:0,properties:new Map(),versions:new Map()});
      this.staticFunctions.set(fn.name,fn.identity);
    }
    const graph=input.graph;
    for(const obj of graph.objects??[]){
      if(this.heap.has(obj.id)||!['array','object'].includes(obj.kind))
        fail('context','Duplicate or unsupported owned input object');
      const props=new Map(),versions=new Map();
      for(const entry of obj.properties??[]){
        if(props.has(entry.key))fail('context','Duplicate input property');
        props.set(entry.key,{value:copy(entry.value),version:entry.version});
        versions.set(entry.key,entry.version);
      }
      this.heap.set(obj.id,{kind:obj.kind,shapeVersion:obj.shapeVersion,properties:props,versions});
    }
    this.cells=new Map();
    this.activations=new Map();
    this.pendingChild=null;
    this.root=null;this.completion=null;
    this.generated=0;this.observed=0;
    this.producers=new Set();
    this.history=[];this.open=null;
  }
  static fromPacket(packet) {
    if(packet?.schema!=='semantic-continuation/1')
      fail('context','Invalid continuation packet');
    const controller=new SemanticController(packet.context,packet.limits);
    for(const row of packet.committed){
      if(row.mode==='generated')controller.commitGenerated(row.record,{track:row.track});
      else controller.commitObserved(row.record,{track:row.track});
    }
    return controller;
  }
  checkValue(value) {
    if(!Array.isArray(value) || !value.length)
      fail('value','Expected a tagged guest value');
    if(value[0]==='ref' && !this.heap.has(value[1]))
      fail('identity','Reference was never allocated in the committed graph');
  }
  commitGenerated(line,{track='t0'}={}){return this.#commit('generated',line,track);}
  commitObserved(line,{track='t0'}={}){return this.#commit('observed',line,track);}
  #commit(mode,line,track) {
    if(!/^t[0-7]$/.test(track))fail('lane','Invalid model lane');
    if(this.completion)fail('completion','No events may follow committed end');
    const {kind,fields}=decodeRecord(line);
    const generated=mode==='generated';
    if(generated && ++this.generated>this.maxGenerated)
      fail('profile_limit','Segment generated event budget exceeded');
    if(this.open){
      if(fields.id!==this.open.id || track!==this.open.track || mode!==this.open.mode)
        fail('fragment','Value fragment is not a contiguous same-lane group');
      if(kind==='value-part'){
        this.open.parts.push(fields.data);
        this.history.push({mode,track,record:line});
        return {status:'fragment'};
      }
      if(kind!=='value-close')fail('fragment','Open value interrupted');
      const completed=decodeRecord(this.open.parts.join(''));
      this.open=null;
      this.#apply(completed.kind,completed.fields,mode,track);
    } else if(kind==='value-open') {
      if(typeof fields.id!=='string')fail('fragment','Unnamed fragmented value');
      this.open={id:fields.id,parts:[],track,mode};
      this.history.push({mode,track,record:line});
      return {status:'fragment'};
    } else {
      if(['value-part','value-close'].includes(kind))
        fail('fragment','Unexpected value piece');
      this.#apply(kind,fields,mode,track);
    }
    this.history.push({mode,track,record:line});
    if(!generated)this.observed++;
    return {status:this.completion?'completed':'committed'};
  }
  #apply(kind,fields,mode,track) {
    if(mode==='observed'){
      if(kind!=='observe'&&kind!=='code')
        fail('visibility','Nonenvironment operation cannot be observed');
      if(kind==='code')fail('profile_limit','Lazy code loading is not yet enabled');
      return;
    }
    if(['observe','code','request','await','resume','settle'].includes(kind))
      fail('profile_limit',kind+' is not enabled in the synchronous serving profile');
    for(const dep of [...(fields.dependsOn??[]),fields.control].filter(Boolean))
      if(!this.producers.has(dep))fail('dependency','Producer has not committed');
    if(fields.id!==undefined){
      if(!/^e[1-9]\d*$/.test(fields.id)||this.producers.has(fields.id))
        fail('identity','Duplicate or invalid semantic producer');
    }
    if(fields.site && !this.sites.has(fields.site))
      fail('source','Unknown source site');
    if(kind==='enter') {
      const invocation=fields.invocation;
      if(typeof invocation!=='string'||this.activations.has(invocation))
        fail('invocation','Duplicate or invalid function activation');
      if(!this.codes.has(fields.code)||!Array.isArray(fields.arguments))
        fail('code','Unregistered callee or absent argument references');
      if(this.root===null){
        if(track!=='t0'||fields.entry!==this.input.entry ||
           !same(fields.arguments,this.input.graph.roots))
          fail('entry','Root entry differs from observed invocation');
        this.root=invocation;
      }else{
        if(!this.pendingChild||!same(this.pendingChild,{
          invocation,code:fields.code,arguments:fields.arguments,
          receiver:fields.receiver,captures:fields.captures}))
          fail('invocation','Child entry differs from committed call');
        this.pendingChild=null;
      }
      const params=this.codes.get(fields.code).params;
      this.activations.set(invocation,{code:fields.code,track,status:'running',
        params:Object.fromEntries(params.map((key,i)=>[key,copy(fields.arguments[i]??['undefined'])]))});
    } else if(kind==='alloc'){
      for(const item of fields.allocations??[]) {
        if(this.heap.has(item.identity))fail('identity','Allocation identity already exists');
        this.heap.set(item.identity,{kind:item.kind,shapeVersion:0,properties:new Map(),versions:new Map()});
      }
    } else if(kind==='read') {
      for(const read of fields.reads??[]){
        if(read.kind==='property'){
          const obj=this.heap.get(read.objectId),property=obj?.properties.get(read.key);
          if(!obj || (property!==undefined)!==read.present ||
             (obj.versions.get(read.key)??0)!==read.version ||
             !same(property?.value??['undefined'],read.value))
            fail('read','First inconsistent owned property observation');
        }else if(read.kind==='binding'){
          const key=read.envId+':'+read.name;
          const prior=this.cells.get(key);
          const active=this.activations.get(fields.invocation);
          const seeded=active?.params[read.name] ??
            (this.staticFunctions.has(read.name) ?
              ['ref',this.staticFunctions.get(read.name)] : undefined);
          if(prior && (prior.version!==read.version || !same(prior.value,read.value)))
            fail('read','Captured binding version/value disagrees with committed state');
          if(!prior && seeded && !same(seeded,read.value))
            fail('read','Parameter or static function read differs from observed context');
          if(!prior && !seeded && read.version!==0)
            fail('read','Unknown binding has a noninitial read version');
          if(!prior)this.cells.set(key,{version:0,value:copy(read.value)});
        }else fail('read','Unsupported location observation');
      }
    } else if(kind==='value'||kind==='write'){
      // Apply model-produced patches atomically. Never calculate a missing RHS.
      const cellDraft=new Map(this.cells);
      const heapDraft=new Map([...this.heap].map(([id,obj])=>[id,{
        ...obj,properties:new Map(obj.properties),versions:new Map(obj.versions)}]));
      for(const write of fields.writes??[]){
        if(write.kind==='cell'){
          const key=write.env+':'+write.key,old=cellDraft.get(key);
          if((old?.version??0)!==write.previous ||
             write.version!==write.previous+1)
            fail('write','Stale lexical cell write');
          cellDraft.set(key,{version:write.version,value:copy(write.value)});
        }else if(write.kind==='property'){
          const obj=heapDraft.get(write.object);
          const before=this.heap.get(write.object);
          if(!obj || !before || (before.versions.get(write.key)??0)!==write.oldVersion ||
             write.version!==write.oldVersion+1 ||
             before.shapeVersion!==write.shapeBefore)
            fail('write','Stale object property or shape version');
          if(write.present)obj.properties.set(write.key,{version:write.version,value:copy(write.value)});
          else obj.properties.delete(write.key);
          obj.versions.set(write.key,write.version);
          obj.shapeVersion=write.shapeAfter;
        }else fail('write','Unrecognized predicted mutation kind');
      }
      this.cells=cellDraft;this.heap=heapDraft;
    } else if(kind==='call'){
      if(this.pendingChild)fail('invocation','Unentered child call');
      if(fields.child){
        this.pendingChild={invocation:fields.child,code:fields.code,
          arguments:fields.arguments,receiver:fields.receiver,captures:fields.captures};
        const caller=this.activations.get(fields.invocation);
        if(!caller||caller.status!=='running')
          fail('invocation','Call has no active owning frame');
      }
    } else if(kind==='return'||kind==='throw'){
      const activation=this.activations.get(fields.invocation);
      if(!activation||activation.status!=='running')
        fail('completion','A missing or completed frame cannot return/throw twice');
      activation.status=kind;
      activation.value=copy(fields.result);
    } else if(kind==='branch'||kind==='loop'){
      if(!this.activations.has(fields.invocation) ||
         (kind==='branch' && typeof fields.decision!=='boolean'))
        fail('control','Unresolvable source control decision');
    } else if(kind==='end'){
      if(fields.invocation!==this.root || this.pendingChild)
        fail('completion','Root completion is missing or a call is pending');
      const root=this.activations.get(this.root);
      if(!root || fields.kind!==root.status ||
         [...this.activations.values()].some(f=>f.status==='running'))
        fail('completion','Terminal record contradicts committed invocation outcomes');
      this.completion={kind:root.status,value:copy(root.value)};
    } else fail('profile_limit','Unknown semantic operation: '+kind);
    if(fields.id)this.producers.add(fields.id);
  }
  continuationPacket() {
    if(this.open)fail('fragment','Cannot segment while a value definition is incomplete');
    const packet={schema:'semantic-continuation/1',limits:{
      maxGenerated:this.maxGenerated,maxPacketBytes:this.maxPacketBytes},
      context:[
        'code '+JSON.stringify(this.source),
        'value '+JSON.stringify(this.input)
      ],committed:copy(this.history)};
    if(Buffer.byteLength(JSON.stringify(packet),'utf8')>this.maxPacketBytes)
      fail('profile_limit','Cannot fit exact committed continuation in packet budget');
    return packet;
  }
}
