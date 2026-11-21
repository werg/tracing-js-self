// Adapt individual direct protocol events to the shared source coordinator.
// Each component uses the real invocation controller, cell/frame names and
// publication transaction. There is no second replay or whole-episode trace.
import {parse} from 'acorn';
import {isDeepStrictEqual as eq} from 'node:util';
import {decode} from '../values.js';
import {protocolSourceClaimsV8,SHARED_PROTOCOL_SOURCE_IDS_V8} from './protocol-source-claims-v8.js';
import {sourceHasSyntaxV8} from './source-projection-base-v8.js';

const copy=structuredClone;
function memberName(node){
  if(node?.type!=='MemberExpression')return null;
  if(!node.computed&&node.property?.type==='Identifier')return node.property.name;
  if(node.computed&&node.property?.type==='Literal'&&typeof node.property.value==='string')return node.property.value;
  return null;
}
function sharedSyntax(adapter,node){
  const name=memberName(node);
  if(adapter.id==='ordinary-array-map-source/1')return node.type==='MemberExpression'&&name==='map';
  if(adapter.id==='builtin-iterator/1')return node.type==='ForOfStatement'&&!node.await||
    node.type==='MemberExpression'&&(['values','keys','entries','next'].includes(name)||
      node.computed&&node.property?.type==='MemberExpression'&&node.property.object?.name==='Symbol'&&
      node.property.property?.name==='iterator');
  return false;
}
function inventory(source,bundle){
  const nodes=new Map(),functions=new Map(),codes=new Map();
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
      codes.set(instruction.arg.codeId,instruction.op==='DEF_FN'?instruction.arg.name:'function:'+instruction.start);
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
  const syntax=inventory(source,bundle);
  return chosen.map(adapter=>{
    const id=adapter.id,claims=adapter.claims??protocolSourceClaimsV8(id),
      stateful=typeof adapter.captureState==='function'&&typeof adapter.restoreState==='function';
    if((adapter.captureState!==undefined||adapter.restoreState!==undefined)&&!stateful)
      throw new TypeError('Shared protocol source state requires both capture and restore: '+id);
    if(!stateful&&adapter.stateless!==true)
      throw new TypeError('Shared protocol source adapter must declare retained state: '+id);
    function invoke(ctx,event,operation){
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
          const identity=ctx.identity(value[1]),node=ctx.state.heap[value[1]];
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
      const context={bundle:ctx.bundle,source:ctx.source,inventory:syntax,
        get state(){return ctx.state;},get beforeState(){return ctx.state;},
        get controller(){return controller();},
        get publicInvocation(){return controller().stack.at(-1);},
        tag,cell:ctx.cell,frame:frame=>ctx.registerFrame(frame,owner),descriptor,publish,
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
      allocation(ctx){ctx.refuse('protocol allocation must be performed by its reserved source event: '+id);},
      event:(ctx,event,row)=>invoke(ctx,event,context=>adapter.event(context,event,row)),
      completion(ctx,event,_row,exit){
        const change=event.stateChanges.find(change=>change.table==='frames'&&change.id===exit.invocation);
        return invoke(ctx,event,context=>adapter.completeFrame(context,change,event));
      },
      beforeEvent:(ctx,event,row)=>invoke(ctx,event,context=>adapter.beforeEvent?.(context,event,row)),
      checkEvent(ctx,event,row){return invoke(ctx,event,context=>{
        for(const change of event.stateChanges)if(change.after){
          if(change.table==='heap'){
            const fields=adapter.heapFields?.(change.after);
            if(fields){
              const allowed=new Set(['id','kind','version',...fields]);
              if(Object.keys(change.after).some(key=>!allowed.has(key))||adapter.checkHeap?.(context,change.after)!==true)
                ctx.refuse('shared protocol heap comparison failed: '+id);
            }
          }else if(change.table==='frames'&&typeof adapter.checkFrame==='function'&&adapter.checkFrame(context,change.after)!==true)
            ctx.refuse('shared protocol frame comparison failed: '+id);
        }
        if(adapter.afterEvent?.(context,event,row)===false)ctx.refuse('shared protocol observer rejected: '+id);
        return true;
      });}
    };
  });
}
