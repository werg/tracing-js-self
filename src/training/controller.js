// Serving-side semantic controller: it never runs source code, computes missing
// arithmetic, or replaces a selected model trajectory with reference state.
// It validates and commits only explicitly generated records and observations.
import {isDeepStrictEqual} from 'node:util';
import {decodeRecord,restoreLines} from './format.js';
import {decode} from '../values.js';
import {supportsPinnedRegExp} from '../owned-pinned-regexp.js';

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
    if(source.randomSeed!==undefined &&
       (!Number.isInteger(source.randomSeed)||source.randomSeed<0||source.randomSeed>0xffffffff))
      fail('context','Invalid seeded random fixture');
    this.randomState=source.randomSeed??null;
    this.randomSites=new Set(source.sites.filter(site=>
      /^Math\.random\(\)$/.test(source.text.slice(site.start,site.end).trim()))
      .map(site=>site.id));
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
    this.staticRegExps=new Map();
    for(const regex of source.staticRegExps??[]){
      if(!regex || typeof regex.name!=='string'||
         typeof regex.identity!=='string'||
         !supportsPinnedRegExp(regex.pattern,regex.flags)||
         this.heap.has(regex.identity)||this.staticRegExps.has(regex.name))
        fail('context','Invalid pinned static RegExp allocation');
      const properties=new Map([
        ['[[Source]]',{value:['str',regex.pattern],version:0}],
        ['[[Flags]]',{value:['str',regex.flags],version:0}],
        ['lastIndex',{value:['num',0],version:0}]
      ]);
      this.heap.set(regex.identity,{kind:'regexp',shapeVersion:3,properties,
        versions:new Map([['[[Source]]',0],['[[Flags]]',0],['lastIndex',0]])});
      this.staticRegExps.set(regex.name,regex.identity);
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
      this.heap.set(obj.id,{kind:obj.kind,prototype:obj.prototype??'ordinary',
        shapeVersion:obj.shapeVersion,properties:props,versions});
    }
    this.cells=new Map();
    this.activations=new Map();
    this.pendingChild=null;this.enteredFrom=null;
    this.root=null;this.completion=null;
    this.generated=0;this.observed=0;
    this.producers=new Set();
    this.history=[];this.open=null;
  }
  // Commit effects accompanying an owned callback invocation/return.
  // The controller never computes a missing mutation or invokes guest code.
  applyCallbackEffects(fields){
    const draft=new Map([...this.heap].map(([id,o])=>[id,{
      ...o,properties:new Map(o.properties),versions:new Map(o.versions)}]));
    for(const alloc of fields.allocations??[]){
      if(!['array','object','function','set','regexp'].includes(alloc.kind)||
         draft.has(alloc.identity)||!Array.isArray(alloc.properties)||
         !Number.isSafeInteger(alloc.shapeVersion)||alloc.shapeVersion<0)
        fail('identity','Invalid callback-associated allocation');
      const props=new Map(),versions=new Map();
      for(const item of alloc.properties){
        if(props.has(item.key)||!Number.isSafeInteger(item.version)||item.version<0)
          fail('identity','Invalid allocation property');
        props.set(item.key,{value:copy(item.value),version:item.version});
        versions.set(item.key,item.version);
      }
      draft.set(alloc.identity,{kind:alloc.kind,shapeVersion:alloc.shapeVersion,
        properties:props,versions});
    }
    const writes=(fields.writes??[]);
    const keys=new Set(),counts=new Map();
    for(const w of writes){
      if(w.kind!=='property'||typeof w.key!=='string'||
         keys.has(w.object+':'+w.key))fail('write','Invalid callback write');
      keys.add(w.object+':'+w.key);
      counts.set(w.object,(counts.get(w.object)??0)+1);
    }
    for(const w of writes){
      const old=this.heap.get(w.object),obj=draft.get(w.object);
      const count=counts.get(w.object);
      if(!old||!obj||(old.versions.get(w.key)??0)!==w.oldVersion||
         !Number.isSafeInteger(w.version)||w.version<=w.oldVersion||
         w.version-w.oldVersion>count||old.shapeVersion!==w.shapeBefore||
         !Number.isSafeInteger(w.shapeAfter)||w.shapeAfter<w.shapeBefore||
         w.shapeAfter-w.shapeBefore>count)
        fail('write','Stale callback-associated property mutation');
      if(w.present)obj.properties.set(w.key,{version:w.version,value:copy(w.value)});
      else obj.properties.delete(w.key);
      obj.versions.set(w.key,w.version);
      obj.shapeVersion=w.shapeAfter;
    }
    this.heap=draft;
    for(const alloc of fields.allocations??[])
      for(const x of alloc.properties)this.checkValue(x.value);
    for(const w of writes)if(w.present)this.checkValue(w.value);
  }
  checkValue(value) {
    if(!Array.isArray(value) || !value.length)
      fail('value','Expected a tagged guest value');
    if(value[0]==='ref') {
      if(value.length!==2 || typeof value[1]!=='string' || !this.heap.has(value[1]))
        fail('identity','Reference was never allocated in the committed graph');
    }else if(value[0]==='intrinsic'){
      if(value.length!==2||!['Object','Array','Number','Math',
        'Object.prototype','Array.prototype','Promise','Set','Error','TypeError'].includes(value[1]))
        fail('value','Unknown owned intrinsic tag');
    }else if(value[0]==='builtinfn'){
      const names=new Set([
        ...['abs','ceil','floor','trunc','round','max','min','pow','sign','sqrt','hypot','random']
          .map(x=>'Math.'+x),
        ...['isFinite','isNaN','isInteger','isSafeInteger'].map(x=>'Number.'+x),
        ...['toString','toFixed'].map(x=>'Number.prototype.'+x),
        ...['push','pop','includes','indexOf','lastIndexOf','slice','concat',
          'join','splice','unshift','shift','at','filter','map','reduce','sort','reverse','fill','copyWithin',
          'toReversed','with'].map(x=>'Array.prototype.'+x),
        ...['charAt','charCodeAt','at','substring','substr','slice','indexOf','lastIndexOf',
          'includes','startsWith','endsWith','toLowerCase','toUpperCase','trim',
          'trimStart','trimEnd','split','replace'].map(x=>'String.prototype.'+x),
        'Array.isArray','Array.from','Array.toString',
        'Set.prototype.has','Set.prototype.add','RegExp.prototype.test','parseInt','isNaN',
        'Object.hasOwn','Object.keys','Object.values','Object.entries','Object.assign','Object.is','Object.create','Object.setPrototypeOf',
        'Object.getPrototypeOf','Object.defineProperty','Object.valueOf','Object.toString',
        'Promise.resolve','Promise.reject','Promise.prototype.then',
        'Promise.prototype.catch','Promise.prototype.finally'
      ]);
      if(value.length!==2||!names.has(value[1]))
        fail('value','Unknown owned builtin tag');
    }else if(value[0]==='method'){
      if(value.length!==3)fail('value','Malformed method reference');
      this.checkValue(value[1]);
      this.checkValue(value[2]);
    }else {
      try { decode(value); }
      catch { fail('value','Unknown or invalid scalar tag in selected trace'); }
    }
  }
  commitGenerated(line,{track='t0'}={}){return this.#commit('generated',line,track);}
  commitObserved(line,{track='t0'}={}){return this.#commit('observed',line,track);}
  #commit(mode,line,track) {
    // A rejected model prediction must not change live state, producer identities,
    // fragment buffers, history, or the segment budget. The controller is bounded;
    // clone the owned graph before validation just as the archival VM snapshots
    // its state for an authoritative transaction.
    const snapshot=structuredClone({
      heap:this.heap,cells:this.cells,activations:this.activations,
      producers:this.producers,pendingChild:this.pendingChild,
      root:this.root,completion:this.completion,open:this.open,
      generated:this.generated,observed:this.observed,history:this.history,randomState:this.randomState
    });
    try {return this.#commitUnchecked(mode,line,track);}
    catch(error) {
      Object.assign(this,snapshot);
      throw error;
    }
  }
  #commitUnchecked(mode,line,track) {
    if(!/^t[0-7]$/.test(track))fail('lane','Invalid model lane');
    if(this.completion)fail('completion','No events may follow committed end');
    const {kind,fields}=decodeRecord(line);
    const generated=mode==='generated';
    if(generated && this.generated>=this.maxGenerated)
      fail('profile_limit','Segment generated event budget exceeded');
    if(this.open){
      if(fields.id!==this.open.id || track!==this.open.track || mode!==this.open.mode)
        fail('fragment','Value fragment is not a contiguous same-lane group');
      if(kind==='value-part'){
        if(typeof fields.data!=='string' || !fields.data.length)
          fail('fragment','Invalid empty or non-string fragment payload');
        this.open.parts.push(fields.data);
        if(generated)this.generated++;
        this.history.push({mode,track,record:line});
        return {status:'fragment'};
      }
      if(kind!=='value-close')fail('fragment','Open value interrupted');
      if(!this.open.parts.length)fail('fragment','Empty fragmented record');
      const completed=decodeRecord(this.open.parts.join(''));
      if(this.open.id!==(completed.fields.id??('record:'+completed.kind)))
        fail('fragment','Fragment identity disagrees with reconstructed record');
      if(['value-open','value-part','value-close'].includes(completed.kind))
        fail('fragment','Nested fragmented records are not permitted');
      this.open=null;
      this.#apply(completed.kind,completed.fields,mode,track);
    } else if(kind==='value-open') {
      if(typeof fields.id!=='string' || !fields.id || fields.type!=='semantic-record')
        fail('fragment','Invalid fragmented record identity or type');
      this.open={id:fields.id,parts:[],track,mode};
      if(generated)this.generated++;
      this.history.push({mode,track,record:line});
      return {status:'fragment'};
    } else {
      if(['value-part','value-close'].includes(kind))
        fail('fragment','Unexpected value piece');
      this.#apply(kind,fields,mode,track);
    }
    if(generated)this.generated++;
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
    for(const dep of [...(fields.dependsOn??[]),fields.control,
      ...(fields.reads??[]).map(read=>read.supplyingSemantic)].filter(Boolean))
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
        const pending=this.pendingChild;
        if(!pending||!same({
          invocation:pending.invocation,code:pending.code,arguments:pending.arguments,
          receiver:pending.receiver,captures:pending.captures},{
          invocation,code:fields.code,arguments:fields.arguments,
          receiver:fields.receiver,captures:fields.captures}))
          fail('invocation','Child entry differs from committed call');
        this.pendingChild=null;
        this.enteredFrom=pending.caller;
      }
      if(fields.rest?.allocation){
        if(this.root!==invocation || this.heap.has(fields.rest.value?.[1]))
          fail('entry','Unjustified or duplicate rest allocation');
        this.applyCallbackEffects({allocations:[fields.rest.allocation]});
      }
      const code=this.codes.get(fields.code);
      const params=code.params;
      const restIndex=code.restIndex??-1;
      if((restIndex<0)!==!fields.rest)
        fail('entry','Rest parameter visibility disagrees with source');
      if(restIndex>=0){
        const rest=fields.rest;
        if(rest.name!==params[restIndex]||rest.value?.[0]!=='ref')
          fail('entry','Rest binding name or identity disagrees with source');
        const array=this.heap.get(rest.value[1]);
        const expanded=fields.arguments.slice(restIndex);
        if(!array||array.kind!=='array'||
           !same(array.properties.get('length')?.value,['num',expanded.length]))
          fail('entry','Rest parameter array not committed');
        for(let i=0;i<expanded.length;i++)
          if(!same(array.properties.get(String(i))?.value,expanded[i]))
            fail('entry','Rest parameter expansion is not source-ordered');
      }
      this.activations.set(invocation,{code:fields.code,track,status:'running',
        caller:this.enteredFrom??null,
        params:Object.fromEntries(params.map((key,i)=>[key,copy(i===restIndex?
          fields.rest.value:(fields.arguments[i]??['undefined']))]))});
      this.enteredFrom=null;
    } else if(kind==='alloc'){
      // Allocation commits initialized heap properties, not just an identity.
      // Array length (even when zero) and built-in-created array elements must
      // exist before the model can predict any later reads.
      for(const item of fields.allocations??[]) {
        if(this.heap.has(item.identity))fail('identity','Allocation identity already exists');
        if(!['object','array','function','set','regexp'].includes(item.kind)||
           !Number.isSafeInteger(item.shapeVersion??0) ||
           (item.shapeVersion??0)<0 ||
           !Array.isArray(item.properties??[]))
          fail('identity','Invalid owned allocation shape');
        const props=new Map(),versions=new Map();
        for(const entry of item.properties??[]){
          if(typeof entry.key!=='string'||props.has(entry.key)||
             !Number.isSafeInteger(entry.version)||entry.version<0)
            fail('identity','Malformed initial allocation property');
          props.set(entry.key,{value:copy(entry.value),version:entry.version});
          versions.set(entry.key,entry.version);
        }
        this.heap.set(item.identity,{
          kind:item.kind,shapeVersion:item.shapeVersion??0,
          properties:props,versions
        });
      }
      for(const item of fields.allocations??[])
        for(const entry of item.properties??[])this.checkValue(entry.value);
      // Defining a function publishes its lexical name and closure reference
      // as part of the same effective allocation. No hidden binding creation.
      for(const write of fields.writes??[]){
        if(write.kind!=='cell')continue;
        if(write.previous!==0||write.version!==0)
          fail('write','Malformed function-definition binding');
        const key=write.env+':'+write.key;
        if(this.cells.has(key))fail('write','Repeated function-definition binding');
        this.checkValue(write.value);
        this.cells.set(key,{version:0,value:copy(write.value)});
      }
      // An array builtin may allocate its return value and write the receiver
      // in one atomic event. Validate the patches against pre-event versions.
      const writes=(fields.writes??[]).filter(w=>w.kind==='property');
      if((fields.writes??[]).length!==writes.length+
          (fields.writes??[]).filter(w=>w.kind==='cell').length)
        fail('write','Unknown allocation-associated mutation kind');
      if(writes.length){
        const seen=new Set(),counts=new Map();
        for(const write of writes){
          const key=write.object+':'+write.key;
          if(seen.has(key))fail('write','Duplicate predicted property location');
          seen.add(key);
          counts.set(write.object,(counts.get(write.object)??0)+1);
        }
        const draft=new Map([...this.heap].map(([id,obj])=>[id,{
          ...obj,properties:new Map(obj.properties),versions:new Map(obj.versions)}]));
        for(const write of writes){
          const obj=draft.get(write.object),before=this.heap.get(write.object);
          const count=counts.get(write.object);
          if(!obj||!before||typeof write.key!=='string'||
             (before.versions.get(write.key)??0)!==write.oldVersion||
             !Number.isSafeInteger(write.version)||
             write.version<=write.oldVersion||
             write.version-write.oldVersion>count||
             before.shapeVersion!==write.shapeBefore||
             !Number.isSafeInteger(write.shapeAfter)||
             write.shapeAfter<write.shapeBefore||
             write.shapeAfter-write.shapeBefore>count)
            fail('write','Stale or implausible atomic allocation-associated patch');
          if(write.present)obj.properties.set(write.key,{
            version:write.version,value:copy(write.value)});
          else obj.properties.delete(write.key);
          obj.versions.set(write.key,write.version);
          obj.shapeVersion=write.shapeAfter;
        }
        this.heap=draft;
      }
    } else if(kind==='carry') {
      // Iteration cells matter when closures capture distinct values. Copy
      // committed state; do not ask the model to recompute a scope mechanism.
      if(fields.copies && (fields.from||fields.to))
        fail('binding','Ambiguous iteration binding copy');
      const copies=fields.copies??[{from:fields.from,to:fields.to}];
      if(!Array.isArray(copies)||!copies.length||copies.length>8)
        fail('binding','Invalid iteration binding group');
      const patches=new Map();
      for(const item of copies){
        const from=item?.from,to=item?.to;
        if(!from||!to||typeof from.env!=='string'||typeof to.env!=='string'||
           typeof from.key!=='string'||from.key!==to.key||
           !Number.isSafeInteger(from.version)||from.version<0||
           to.version!==from.version)
          fail('binding','Malformed iteration binding copy');
        const key=to.env+':'+to.key,prior=this.cells.get(from.env+':'+from.key);
        if(!prior||prior.version!==from.version||
           this.cells.has(key)||patches.has(key)||from.env===to.env)
          fail('binding','Iteration copy cannot read committed source cell');
        patches.set(key,copy(prior));
      }
      for(const [key,value] of patches)this.cells.set(key,value);
    } else if(kind==='read') {
      for(const read of fields.reads??[]){
        if(read.kind==='property'){
          const obj=this.heap.get(read.objectId),property=obj?.properties.get(read.key);
          // The named ordinary builtins are inherited virtual values with no
          // own property. Validate only their exact well-known receiver/key
          // pairs; unknown prototype reads are not silently hallucinated.
          const builtin=read.value?.[0]==='builtinfn'?read.value[1]:null;
          const virtual=property===undefined && (
            (obj?.kind==='array' && (
              (['push','pop','includes','indexOf','lastIndexOf','slice','concat',
                 'join','splice','unshift','shift','at','filter','map','reduce','sort'].includes(read.key) &&
                builtin==='Array.prototype.'+read.key) ||
              (read.key==='toString'&&builtin==='Array.toString'))) ||
            (['object','array'].includes(obj?.kind) &&
              ['valueOf','toString'].includes(read.key) &&
              builtin==='Object.'+read.key));
          const observed=virtual?read.value:property?.value??['undefined'];
          if(!obj) {
            // A source-level prototype/accessor result can be observed before
            // its internal holder is projected as a model-visible data object.
            // It must remain a labelled effective read, not a fabricated own
            // property in the committed heap.
            this.checkValue(read.value);
          }else if((property!==undefined)===read.present &&
             obj.versions.get(read.key)!==undefined) {
            if((obj.versions.get(read.key)??0)!==read.version ||
               obj.shapeVersion!==read.shapeVersion ||
               !same(observed,read.value))
              fail('read','First inconsistent owned property observation');
          }else if(property!==undefined && read.present) {
            if(!same(observed,read.value))
              fail('read','First inconsistent owned property observation');
          }else {
            // Dynamic inherited lookup: retain the evaluated value and its
            // source dependency, without reconstructing the prototype walk.
            this.checkValue(read.value);
          }
        }else if(read.kind==='binding'){
          const key=read.envId+':'+read.name;
          const prior=this.cells.get(key);
          const active=this.activations.get(fields.invocation);
          const seeded=active?.params[read.name] ??
            (this.staticFunctions.has(read.name) ?
              ['ref',this.staticFunctions.get(read.name)] :
              this.staticRegExps.has(read.name) ? ['ref',this.staticRegExps.get(read.name)] :
              undefined);
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
      if(this.randomSites.has(fields.site)) {
        if(kind!=='value'||this.randomState===null)
          fail('entropy','Random call lacks a declared deterministic fixture seed');
        const next=(Math.imul(this.randomState,1664525)+1013904223)>>>0;
        if(!same(fields.result,['num',next/4294967296]))
          fail('entropy','Model-produced random value disagrees with declared fixture');
        this.randomState=next;
      }
      // Apply model-produced patches atomically. Never calculate a missing RHS.
      const cellDraft=new Map(this.cells);
      const heapDraft=new Map([...this.heap].map(([id,obj])=>[id,{
        ...obj,properties:new Map(obj.properties),versions:new Map(obj.versions)}]));
      if(fields.update){
        // A lexical update contains a read AND a write in one source-level
        // step. Verify the observed old location before accepting the new
        // version. Otherwise a model could fabricate the read and still pass
        // structural serving validation (the independent V8 gate is separate).
        const reads=fields.reads??[],writes=fields.writes??[];
        if(kind!=='write'||!['++','--'].includes(fields.update.operator)||
           typeof fields.update.prefix!=='boolean'||
           reads.length!==1||writes.length!==1)
          fail('read','Malformed owned update observation');
        const read=reads[0],write=writes[0];
        if(read.kind==='binding'&&write.kind==='cell'){
          const key=read.envId+':'+read.name,prior=cellDraft.get(key);
          const active=this.activations.get(fields.invocation);
          const seeded=active?.params[read.name] ??
            (this.staticFunctions.has(read.name) ?
              ['ref',this.staticFunctions.get(read.name)] :
              this.staticRegExps.has(read.name) ? ['ref',this.staticRegExps.get(read.name)] :
              undefined);
          if(prior && (prior.version!==read.version || !same(prior.value,read.value)))
            fail('read','Updated binding read differs from committed state');
          if(!prior && seeded && !same(seeded,read.value))
            fail('read','Updated parameter read differs from observed context');
          if(!prior && !seeded && read.version!==0)
            fail('read','Unknown updated binding has a noninitial read version');
          if(write.env!==read.envId||write.key!==read.name||
             write.previous!==read.version)
            fail('read','Updated binding write does not match read location and version');
          if(!prior)cellDraft.set(key,{version:0,value:copy(read.value)});
        }else if(read.kind==='property'&&write.kind==='property'){
          const obj=heapDraft.get(read.objectId);
          const prior=obj?.properties.get(read.key);
          // Inherited/accessor reads require full [[Get]]/[[Set]] replay and
          // cannot be verified by a source-only own-property observation.
          if(!obj||!read.present||!prior||
             (obj.versions.get(read.key)??0)!==read.version||
             obj.shapeVersion!==read.shapeVersion||
             !same(prior.value,read.value)||
             write.object!==read.objectId||write.key!==read.key||
             write.oldVersion!==read.version||
             write.shapeBefore!==read.shapeVersion)
            fail('read','Updated property read is not the committed own value');
        }else fail('read','Mismatched update location kind');
      }
      const writes=fields.writes??[];
      const perObject=new Map();
      for(const write of writes)if(write.kind==='property'){
        const key=write.object+':'+write.key;
        if(perObject.has(key))fail('write','Duplicate predicted property location');
        perObject.set(key,write);
      }
      // Validate all property patches against the *same* pre-call snapshot.
      // A dense push can update several indices and length in one committed
      // builtin step; the later patch must not see an invented intermediate
      // shape version or reject a legitimate multi-increment length version.
      const counts=new Map();
      for(const write of perObject.values())
        counts.set(write.object,(counts.get(write.object)??0)+1);
      for(const write of writes){
        if(write.kind==='cell'){
          const key=write.env+':'+write.key,old=cellDraft.get(key);
          if((old?.version??0)!==write.previous ||
             write.version!==write.previous+1)
            fail('write','Stale lexical cell write');
          cellDraft.set(key,{version:write.version,value:copy(write.value)});
        }else if(write.kind==='property'){
          const obj=heapDraft.get(write.object);
          const before=this.heap.get(write.object);
          const count=counts.get(write.object);
          if(!obj||!before||typeof write.key!=='string'||
             (before.versions.get(write.key)??0)!==write.oldVersion||
             !Number.isSafeInteger(write.version)||
             write.version<=write.oldVersion ||
             write.version-write.oldVersion>count||
             before.shapeVersion!==write.shapeBefore||
             !Number.isSafeInteger(write.shapeAfter)||
             write.shapeAfter<write.shapeBefore||
             write.shapeAfter-write.shapeBefore>count)
            fail('write','Stale or implausible atomic property patch');
          if(write.present)obj.properties.set(write.key,{version:write.version,value:copy(write.value)});
          else obj.properties.delete(write.key);
          obj.versions.set(write.key,write.version);
          obj.shapeVersion=write.shapeAfter;
        }else fail('write','Unrecognized predicted mutation kind');
      }
      this.cells=cellDraft;this.heap=heapDraft;
    } else if(kind==='call'){
      this.applyCallbackEffects(fields);
      if(this.pendingChild)fail('invocation','Unentered child call');
      if(fields.child){
        this.pendingChild={invocation:fields.child,code:fields.code,
          arguments:fields.arguments,receiver:fields.receiver,captures:fields.captures,
          caller:fields.invocation};
        const caller=this.activations.get(fields.invocation);
        if(!caller||caller.status!=='running')
          fail('invocation','Call has no active owning frame');
      }
    } else if(kind==='return'||kind==='throw'){
      this.applyCallbackEffects(fields);
      const activation=this.activations.get(fields.invocation);
      if(!activation||activation.status!=='running')
        fail('completion','A missing or completed frame cannot return/throw twice');
      if((fields.destination??null)!==(activation.caller??null))
        fail('completion','Return destination is not the committed caller');
      activation.status=kind;
      activation.value=copy(fields.result);
    } else if(kind==='branch'||kind==='loop'){
      if(!this.activations.has(fields.invocation))
        fail('control','Unresolvable source control decision');
      if(kind==='branch') {
        if(!Array.isArray(fields.test)||
           !['then','else','use-left','evaluate-right'].includes(fields.path))
          fail('control','Malformed effective source decision');
        this.checkValue(fields.test);
      }else if(fields.path!=='repeat')
        fail('control','Malformed loop continuation');
    } else if(kind==='end'){
      if(fields.invocation!==this.root || this.pendingChild)
        fail('completion','Root completion is missing or a call is pending');
      const root=this.activations.get(this.root);
      if(!root || fields.kind!==root.status ||
         [...this.activations.values()].some(f=>f.status==='running'))
        fail('completion','Terminal record contradicts committed invocation outcomes');
      this.completion={kind:root.status,value:copy(root.value)};
    } else fail('profile_limit','Unknown semantic operation: '+kind);
    if(Array.isArray(fields.result))this.checkValue(fields.result);
    for(const write of fields.writes??[])
      if(write.present!==false && Array.isArray(write.value))this.checkValue(write.value);
    if(fields.id)this.producers.add(fields.id);
  }
  /** Finite-context rollover. Only already committed, model-selected semantic
   * state enters the observed packet. A new model session may reload this packet
   * and reset its t0..t7 registry; invocation/object/cell identities do not reset.
   * The packet is trusted SERVER state, not a user-supplied model prediction. */
  segmentPacket() {
    if(this.open)fail('fragment','Cannot segment in the middle of an open value');
    if(this.completion)fail('completion','A completed execution has no continuation');
    const heap=[...this.heap].map(([id,obj])=>[id,{...obj,
      properties:[...obj.properties],versions:[...obj.versions]}]);
    const state={heap,cells:[...this.cells],activations:[...this.activations],
      staticFunctions:[...this.staticFunctions],pendingChild:copy(this.pendingChild),
      root:this.root,completion:copy(this.completion),producers:[...this.producers]};
    const context=[
      'code '+JSON.stringify(this.source),
      'value '+JSON.stringify(this.input)
    ];
    const packet={schema:'semantic-continuation/2',source:'committed-model-state',
      context,state,limits:{maxGenerated:this.maxGenerated,
        maxPacketBytes:this.maxPacketBytes}};
    if(Buffer.byteLength(JSON.stringify(packet),'utf8')>this.maxPacketBytes)
      fail('profile_limit','Exact live state exceeds the continuation transport capacity');
    // Freeze the handoff at the committed boundary. Returning live Map entry
    // objects would let later rejected model output rewrite older packets.
    return copy(packet);
  }
  static fromSegmentPacket(packet) {
    if(packet?.schema!=='semantic-continuation/2' ||
       packet.source!=='committed-model-state' ||
       !Array.isArray(packet.context) || !packet.state)
      fail('context','Invalid semantic segment handoff');
    const controller=new SemanticController(packet.context,packet.limits);
    const state=packet.state;
    if(!Array.isArray(state.heap)||!Array.isArray(state.cells) ||
       !Array.isArray(state.activations)||!Array.isArray(state.producers))
      fail('context','Malformed segmented live graph');
    const heap=new Map();
    for(const [id,obj] of state.heap) {
      if(typeof id!=='string'||heap.has(id)||!Array.isArray(obj.properties)||
         !Array.isArray(obj.versions))fail('context','Duplicate or corrupt packet object');
      const properties=new Map(obj.properties),versions=new Map(obj.versions);
      if(properties.size!==obj.properties.length||versions.size!==obj.versions.length)
        fail('context','Duplicate packet location');
      for(const [key,property] of properties)
        if(!Number.isSafeInteger(property.version)||property.version<0||
           versions.get(key)!==property.version)
          fail('context','Inconsistent property version in packet');
      heap.set(id,{...obj,properties,versions});
    }
    const activations=new Map(state.activations),cells=new Map(state.cells);
    if(heap.size!==state.heap.length || activations.size!==state.activations.length ||
       cells.size!==state.cells.length ||
       new Set(state.producers).size!==state.producers.length)
      fail('context','Duplicate packet semantic identity');
    for(const [key,cell] of cells)
      if(typeof key!=='string'||!Number.isSafeInteger(cell.version)||cell.version<0)
        fail('context','Invalid packet lexical cell');
    if(state.root!==null && !activations.has(state.root))
      fail('context','Missing resumed root activation');
    if(state.completion)fail('completion','Completed packet cannot be resumed');
    controller.heap=heap;controller.activations=activations;
    controller.cells=cells;controller.staticFunctions=new Map(state.staticFunctions);
    controller.pendingChild=copy(state.pendingChild);
    controller.root=state.root;controller.completion=null;
    controller.producers=new Set(state.producers);
    // A fresh model session begins here. Only the committed live state survives,
    // not the previous session's attention tokens or generated chunk counter.
    controller.generated=0;controller.history=[];controller.observed=0;
    return controller;
  }
}
