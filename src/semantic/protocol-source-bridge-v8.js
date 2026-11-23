// Adapt individual direct protocol events to the shared source coordinator.
// Each component uses the real invocation controller, cell/frame names and
// publication transaction. There is no second replay or whole-episode trace.
import {parse} from 'acorn';
import {isDeepStrictEqual as eq} from 'node:util';
import {decode} from '../values.js';
import {protocolSourceClaimsV8,SHARED_PROTOCOL_SOURCE_IDS_V8} from './protocol-source-claims-v8.js';
import {sourceHasSyntaxV8} from './source-projection-base-v8.js';
import {propertyKeyValue} from '../property-keys.js';
import {describeProtocolObjectV8} from './protocol-state-v8.js';
import {guardHeap,prototype,orderedKeys,frameFields} from './protocol-source-shapes-v8.js';
import {asyncIterationSourceSitesV8,asyncIterationSourceCodeV8} from './async-iteration-source-v8.js';

const copy=structuredClone;
function memberName(node){
  if(node?.type!=='MemberExpression')return null;
  if(!node.computed&&node.property?.type==='Identifier')return node.property.name;
  if(node.computed&&node.property?.type==='Literal'&&typeof node.property.value==='string')return node.property.value;
  return null;
}
function sharedSyntax(adapter,node){
  const name=memberName(node);
  if(adapter.id==='synchronous-generator-source/1')return node.generator===true&&!node.async;
  if(adapter.id==='ordinary-array-map-source/1')return node.type==='MemberExpression'&&name==='map';
  if(['custom-iterator-source/1','ordinary-completions-source/1'].includes(adapter.id))
    return node.type==='ForOfStatement'&&node.await;
  if(adapter.id==='builtin-iterator/1')return node.type==='ForOfStatement'||
    node.type==='MemberExpression'&&(['values','keys','entries','next'].includes(name)||
      node.computed&&node.property?.type==='MemberExpression'&&node.property.object?.name==='Symbol'&&
      node.property.property?.name==='iterator');
  return false;
}
function inventory(source,bundle){
  const nodes=new Map(),functions=new Map(),codes=new Map(),asyncSites=asyncIterationSourceSitesV8(source);
  function visit(node){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){node.forEach(visit);return;}
    if(typeof node.type==='string')nodes.set(node.start+':'+node.end,node);
    if(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type))functions.set(node.start,node);
    for(const [key,child]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))visit(child);
  }
  visit(parse(source,{ecmaVersion:'latest',sourceType:'script'}));
  for(const program of Object.values(bundle.programs))for(const instruction of program.instructions)
    if(instruction.arg?.codeId&&['DEF_FN','MAKE_FUNCTION'].includes(instruction.op))
      codes.set(instruction.arg.codeId,bundle.programs[instruction.arg.codeId]?.sourceRole?
        asyncIterationSourceCodeV8(bundle.programs[instruction.arg.codeId].sourceRole,instruction.start,instruction.end,asyncSites):
        instruction.op==='DEF_FN'?instruction.arg.name:'function:'+instruction.start);
  return {nodes,functions,codes};
}
function selected(adapter,input){
  if(!SHARED_PROTOCOL_SOURCE_IDS_V8.includes(adapter.id))return false;
  return sourceHasSyntaxV8(input,node=>adapter.syntax?.(node)===true||sharedSyntax(adapter,node)||
    adapter.id==='primitive-conversion-source/1'&&(node.type==='CallExpression'&&node.callee.type==='Identifier'&&node.callee.name==='Number'||
      node.computed&&['MemberExpression','Property','MethodDefinition','PropertyDefinition'].includes(node.type))||
    adapter.id==='owned-binary-memory/1'&&node.type==='MemberExpression'&&node.object.type==='Identifier'&&
      ['Atomics','ArrayBuffer'].includes(node.object.name));
}

export function createSharedProtocolSourceComponentsV8({source,bundle,adapters}){
  const chosen=adapters.filter(adapter=>selected(adapter,{source,bundle}));
  if(!chosen.length)return [];
  if(chosen.some(adapter=>adapter.id==='synchronous-generator-source/1')&&
    sourceHasSyntaxV8({source,bundle},node=>node.type==='YieldExpression'&&node.delegate))
    throw new TypeError('Shared generator source: yield delegation requires its explicit composition profile');
  const syntax=inventory(source,bundle);
  return chosen.map(adapter=>{
    const id=adapter.id,claims=adapter.claims??protocolSourceClaimsV8(id),
      stateful=typeof adapter.captureState==='function'&&typeof adapter.restoreState==='function';
    if((adapter.captureState!==undefined||adapter.restoreState!==undefined)&&!stateful)
      throw new TypeError('Shared protocol source state requires both capture and restore: '+id);
    if(!stateful&&adapter.stateless!==true)
      throw new TypeError('Shared protocol source adapter must declare retained state: '+id);
    function invoke(ctx,event,operation,{allocationFields=null}={}){
      const owner=event?ctx.rootFor(event.invocationId):ctx.rootInvocation,
        prior=stateful?adapter.captureState():null,component=ctx.componentState(id);
      const controller=()=>ctx.controller(owner);
      const descriptor=(node,key)=>{
        const accessor=node.accessors?.[key];
        if(accessor)return {kind:'accessor',get:copy(accessor.get?.value??['undefined']),
          set:copy(accessor.set?.value??['undefined']),enumerable:accessor.enumerable,configurable:accessor.configurable};
        const value=node.properties?.[key]?.value;
        if(!value)return null;
        return {kind:'data',value:copy(value),...(node.kind==='array'&&key==='length'?
          {writable:true,enumerable:false,configurable:false}:{writable:true,enumerable:true,configurable:true}),
          ...copy(node.dataAttributes?.[key]??{})};
      };
      const publishing=new Set();
      const publish=(node,at=event)=>{
        if(!node)ctx.refuse('shared source publication lacks an owned node');
        if(controller().heap.has(ctx.identity(node.id)))return true;
        const identity=ctx.identity(node.id);
        if(publishing.has(identity))ctx.refuse('shared source publication found a cyclic ordinary object graph');
        if(node.kind==='function'){
          if(typeof ctx.allocations!=='function')ctx.refuse('shared closure publication requires the owned allocation bridge');
          ctx.allocations({allocations:[{identity:node.id,kind:node.kind,codeId:node.codeId,
            capture:node.closureEnvId,properties:[]}]},owner,at);
          return controller().heap.has(identity);
        }
        if(!['object','array'].includes(node.kind))ctx.refuse('shared source publication requires an ordinary object or array');
        const length=node.kind==='array'?node.properties?.length?.value:null,
          keys=[...new Set([...(node.propertyOrder??[]),...Object.keys(node.properties??{}),...Object.keys(node.accessors??{})])]
            .filter(key=>!(node.kind==='array'&&key==='length')),
          ordinaryPrototype=node.kind==='array'?['Array.prototype']:['Object.prototype'];
        if(node.kind==='array'&&(length?.[0]!=='num'||!Number.isSafeInteger(length[1])||length[1]<0)||
          Object.keys(node.accessors??{}).length||Object.keys(node.dataAttributes??{}).length||
          ![undefined,...ordinaryPrototype].includes(node.prototype)||node.extensible===false||
          keys.some(key=>key.startsWith('\u0000')||!node.properties?.[key]?.value))
          ctx.refuse('shared source publication requires an ordinary default-descriptor data object');
        publishing.add(identity);
        try{
          const properties=keys.map(key=>({key:['str',key],value:tag(node.properties[key].value,at)}));
          ctx.emitProtocol(owner,{kind:'allocate',name:identity,objectKind:node.kind,length:length?.[1]??null,properties,
            code:null,captures:[],functionKind:null,lexicalReceiver:null},at,'owned-source-allocation/1');
        }finally{publishing.delete(identity);}
        return controller().heap.has(identity);
      };
      const tag=value=>{
        if(value?.[0]==='ref'){
          // Allocation adapters run before this event's owned changes commit.
          // A generator declaration, for example, publishes its function and
          // prototype together; either descriptor can already name the other.
          // Only this event's authenticated fresh node extends the pre-state.
          const identity=ctx.identity(value[1]),node=ctx.state.heap[value[1]]??
            event?.stateChanges.find(change=>change.table==='heap'&&change.id===value[1]&&change.before===null)?.after;
          if(!node)ctx.refuse('shared source reference is absent from the owned heap');
          if(!controller().heap.has(identity)){
            if(node.kind==='function')ctx.publishInitialClosure(value[1],owner,event);
            if(!controller().heap.has(identity))publish(node,event);
          }
          if(!controller().heap.has(identity))ctx.refuse('shared source reference has no public allocation');
          return ['ref',identity];
        }
        return ctx.tag(value);
      };
      const baseCheckHeap=node=>{
        const projected=descriptor=>descriptor?.kind==='data'?{...descriptor,value:tag(descriptor.value)}:
          descriptor?{...descriptor,get:tag(descriptor.get),set:tag(descriptor.set)}:null;
        const expected={kind:node.kind==='function'?'closure':node.kind,prototype:prototype(node),extensible:node.extensible!==false,
          properties:orderedKeys(node).map(key=>({key:propertyKeyValue(key),descriptor:projected(descriptor(node,key))})),
          ...(node.kind==='function'?{code:syntax.codes.get(node.codeId),functionKind:node.arrow?'arrow':'ordinary',
            lexicalReceiver:node.arrow?node.lexicalThis:null}:{})};
        if(!eq(expected,describeProtocolObjectV8(controller(),ctx.identity(node.id))))
          ctx.refuse('shared protocol descriptor/heap state differs: '+id+'/'+node.id);
      };
      const context={bundle:ctx.bundle,source:ctx.source,inventory:syntax,
        get state(){return ctx.state;},get beforeState(){return ctx.state;},
        get controller(){return controller();},
        get publicInvocation(){return controller().stack.at(-1);},
        tag,cell:ctx.cell,frame:frame=>ctx.registerFrame(frame,owner),descriptor,publish,orderedKeys,
        functionCodes:syntax.codes,baseCheckHeap,
        baseAllocate(node,at=event){
          if(!allocationFields||node.kind!=='function'||node.id!==allocationFields.name||
            Object.keys(node.properties??{}).length||node.generatorFunction||node.nonConstructible||
            node.prototype!==undefined||Object.keys(node.dataAttributes??{}).length)
            ctx.refuse('shared generator allocation requires its bare reserved source closure');
          ctx.emitProtocol(owner,{kind:'allocate',name:allocationFields.name,objectKind:'closure',length:null,properties:[],
            code:allocationFields.code,captures:copy(allocationFields.captures),functionKind:'ordinary',lexicalReceiver:null},
            at,'owned-source-generator-closure/1');
        },
        codeFor:node=>syntax.codes.get(node?.codeId)??ctx.refuse('shared source function has no exact definition'),
        bind:(name,value,at=event)=>ctx.emit(owner,'bind',{name,value:tag(value)},at,'shared-protocol-cell'),
        bindDerived:(name,value,at=event)=>{
          if(!Array.isArray(value)||!['undefined','null','bool','str','num','bigint'].includes(value[0]))
            ctx.refuse('shared source derived binding must be a checked primitive');
          return ctx.emit(owner,'bind',{name,value:copy(value)},at,'shared-protocol-cell');
        },
        emit(record,at=event,rule='shared-source-protocol/1',{detail=false}={}){
          return detail?ctx.emit(owner,record.kind,record.fields,at,rule):ctx.emitProtocol(owner,record,at,rule);
        },
        markPublished(identity){if(!controller().heap.has(ctx.identity(identity)))ctx.refuse('protocol allocation was not published');},
        get published(){return new Set(controller().heap.keys());},
        getOwnedFrame:frame=>ctx.state.frames[frame],
        get extensionState(){return new Map();},
        key(value){
          if(value?.[0]==='symbol')return copy(value);
          if(!['undefined','null','str','num','bool','bigint'].includes(value?.[0]))
            ctx.refuse('observable ToPropertyKey requires a coercion protocol');
          return ['str',String(decode(value))];
        },refuse:ctx.refuse,copy,eq};
      try{
        if(stateful)adapter.restoreState(copy(component));
        const result=operation(context);
        if(stateful){
          const next=copy(adapter.captureState());
          for(const key of Object.keys(component))delete component[key];
          Object.assign(component,next);
        }
        return result;
      }finally{if(stateful)adapter.restoreState(prior);}
    }
    return {id,
      completionWritesHandled:adapter.completionWritesHandled===true,
      initialize:()=>copy(adapter.captureState?.()??{}),
      claims:{
        event:claims.event,
        allocation:(view,input)=>claims.allocation(view,input.node),
        completion:(view,exit)=>{
          const change=view.event?.stateChanges.find(change=>change.table==='frames'&&change.id===exit.invocation);
          return Boolean(change&&['return','throw','unhandled-throw'].includes(exit.operation)&&claims.completion(view,change));
        }
      },
      prepare:{event:(_view,{event})=>({kind:'shared-protocol-event',event:event.eventId}),
        allocation:(_view,input)=>({kind:'shared-protocol-allocation',identity:input.identity}),
        completion:(_view,exit)=>({kind:'shared-protocol-completion',invocation:exit.invocation})},
      allocation(ctx,event,fields){
        const node=event?.stateChanges.find(change=>change.table==='heap'&&ctx.identity(change.id)===fields.name)?.after??
          ctx.state.heap[fields.name];
        if(id!=='synchronous-generator-source/1'||node?.generatorFunction!==true||fields.kind!=='closure')
          ctx.refuse('protocol allocation must be performed by its reserved source event: '+id);
        return invoke(ctx,event,context=>{
          guardHeap(node,{extraFields:adapter.heapFields(node),allowUnknown:true,allowFunctionMetadata:true});
          if(adapter.allocate(context,node,event)!==true||adapter.checkHeap(context,node)!==true)
            ctx.refuse('shared generator definition allocation failed');
          context.baseCheckHeap(node);
          const prototypeId=node.properties.prototype.value[1],prototypeNode=event?.stateChanges.find(change=>
            change.table==='heap'&&change.id===prototypeId)?.after??ctx.state.heap[prototypeId];
          if(!prototypeNode)ctx.refuse('shared generator definition lacks its owned prototype');
          guardHeap(prototypeNode);context.baseCheckHeap(prototypeNode);
          return true;
        },{allocationFields:fields});
      },
      event:(ctx,event,row)=>invoke(ctx,event,context=>adapter.event(context,event,row)),
      completion(ctx,event,_row,exit){
        const change=event.stateChanges.find(change=>change.table==='frames'&&change.id===exit.invocation);
        return invoke(ctx,event,context=>adapter.completeFrame(context,change,event));
      },
      beforeEvent:(ctx,event,row)=>invoke(ctx,event,context=>adapter.beforeEvent?.(context,event,row)),
      checkEvent(ctx,event,row){return invoke(ctx,event,context=>{
        if(id==='ordinary-completions-source/1'&&adapter.afterEvent?.(context,event,row)===false)
          ctx.refuse('shared protocol observer rejected: '+id);
        for(const change of event.stateChanges)if(change.after){
          if(change.table==='heap'){
            const fields=adapter.heapFields?.(change.after);
            if(fields){
              const generator=id==='synchronous-generator-source/1',allowed=new Set(['id','kind','version',...fields]);
              if(generator)guardHeap(change.after,{extraFields:fields,allowUnknown:true,allowFunctionMetadata:true});
              if(!generator&&Object.keys(change.after).some(key=>!allowed.has(key))||adapter.checkHeap?.(context,change.after)!==true)
                ctx.refuse('shared protocol heap comparison failed: '+id);
              if(generator&&['object','array','function'].includes(change.after.kind))
                context.baseCheckHeap(change.after);
            }
          }else if(change.table==='frames'){
            const fields=adapter.frameFields?.(change.after);
            if(id==='synchronous-generator-source/1'&&fields){
              if(Object.keys(change.after).some(key=>!frameFields.has(key)&&!fields.includes(key))||
                typeof adapter.checkFrame!=='function'||adapter.checkFrame(context,change.after,event)!==true)
                ctx.refuse('shared protocol frame comparison failed: '+id);
            }else if(id!=='synchronous-generator-source/1'&&typeof adapter.checkFrame==='function'&&adapter.checkFrame(context,change.after,event)!==true)
              ctx.refuse('shared protocol frame comparison failed: '+id);
          }
        }
        if(id!=='ordinary-completions-source/1'&&adapter.afterEvent?.(context,event,row)===false)
          ctx.refuse('shared protocol observer rejected: '+id);
        return true;
      });}
    };
  });
}
