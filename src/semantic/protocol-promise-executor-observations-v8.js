// Independent source observations use the actual native Promise constructor
// and resolving functions. The owned machine and public evaluator are absent.
import {parse} from 'acorn';
import {encode} from '../values.js';
const profile='promise-executor-observations/1',constructorHook='__tracingProtocolPromiseConstructor',
  callHook='__tracingProtocolPromiseCallee',apply=Reflect.apply,construct=Reflect.construct;
const resolver=tag=>tag?.[0]==='builtinfn'&&/^Promise\.executor\.(resolve|reject):p[0-9]+$/.test(tag[1]);
function inventory(source){const constructors=[],calls=[];
  function visit(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}
    if(node.type==='NewExpression'&&node.callee.type==='Identifier'&&node.callee.name==='Promise')constructors.push(node);
    if(node.type==='CallExpression'&&!node.optional&&node.callee.type==='Identifier'&&!node.callee.name.startsWith('__tracing')&&
      !['Number','BigInt','String','Symbol'].includes(node.callee.name))calls.push(node);
    for(const [key,child]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))visit(child);
  }visit(parse(source,{ecmaVersion:'latest',sourceType:'script'}));return {constructors,calls};
}
function ownedRows(bundle,original){
  const rows=[],identities=new Map(),children=new Map(),sites=new Map(bundle.sites.map(site=>[site.siteId,site.start+':'+site.end])),
    constructorSites=new Set(original.constructors.map(node=>node.start+':'+node.end)),callSites=new Set(original.calls.map(node=>node.start+':'+node.end));let next=0;
  const fail=message=>{throw new TypeError('Independent Promise executor observation: '+message);};
  function value(tag){
    if(!Array.isArray(tag))fail('missing observation value');
    if(!['ref','promise','symbol'].includes(tag[0])&&!resolver(tag))return structuredClone(tag);
    const key=JSON.stringify(tag);if(!identities.has(key))identities.set(key,++next);
    return ['identity',resolver(tag)||tag[0]==='ref'&&bundle.finalState.heap[tag[1]]?.kind==='function'?'function':tag[0]==='symbol'?'symbol':'object',identities.get(key)];
  }
  function seed(tag){if(tag?.[0]!=='ref'||identities.has(JSON.stringify(tag)))return;value(tag);
    const node=bundle.initialState.heap[tag[1]];if(!node||Object.keys(node.accessors??{}).length)fail('input graph is not data-only');
    for(const key of Object.keys(node.properties??{}).sort())seed(node.properties[key].value);
  }
  bundle.entrySpec.arguments.forEach(seed);
  const add=(kind,fields)=>{if(rows.length>=32768)fail('observation bound');rows.push({kind,...fields});};
  for(const event of bundle.events){
    const site=sites.get(event.siteId),callee=event.operands[0]?.[0]==='method'?event.operands[0][1]:event.operands[0];
    if(event.operation==='object.construct'&&callee?.[0]==='intrinsic'&&callee[1]==='Promise'){
      if(!constructorSites.has(site))fail('unanchored Promise construction');
      const frame=event.stateChanges.find(change=>change.table==='frames'&&change.before===null)?.after,
        promise=frame?.promiseExecutorTarget,executor=event.operands[1];
      if(!promise||!frame||frame.asyncPromiseId)fail('unsupported executor frame');
      const resolve=['builtinfn','Promise.executor.resolve:'+promise],reject=['builtinfn','Promise.executor.reject:'+promise];
      add('enter',{site,executor:value(executor),resolve:value(resolve),reject:value(reject)});
      children.set(frame.id,{site,executor,promise});
    }
    if(event.operation==='call.enter'&&resolver(callee)){
      if(!callSites.has(site)||event.operands[0][0]==='method')fail('resolving function requires a direct source call');
      add('resolve',{site,method:value(callee),value:value(event.operands[1]??['undefined'])});
    }
    for(const change of event.stateChanges)if(change.table==='frames'&&children.has(change.id)&&
      !['completed','thrown'].includes(change.before?.status)&&['completed','thrown'].includes(change.after?.status)){
      const entry=children.get(change.id),completion=change.after.completion;
      if(!['return','throw'].includes(completion?.type)||!completion.value?.value)fail('missing executor completion');
      add('finish',{site:entry.site,executor:value(entry.executor),completion:{kind:completion.type,value:value(completion.value.value)}});
      add('create',{site:entry.site,promise:value(['promise',entry.promise])});children.delete(change.id);
    }
  }
  if(children.size)fail('unfinished executor');return rows;
}
export function createPromiseExecutorObservationAdapterV8({source,side='native',bundle=null,initialValues=[]}={}){
  const original=inventory(source);if(!original.constructors.length)return null;
  if(side==='owned')return {id:profile,observations:()=>ownedRows(bundle,original)};
  const rows=[],identities=new Map(),resolvers=new WeakSet(),failures=[];let next=0,nativePromise=null,
    invoke=call=>apply(call.callee,call.receiver,call.arguments);
  const fail=message=>{failures.push(message);throw new TypeError('Independent native Promise executor observation: '+message);};
  function value(raw){
    if(raw===null||!['object','function','symbol'].includes(typeof raw))return encode(raw);
    if(!identities.has(raw))identities.set(raw,++next);return ['identity',typeof raw,identities.get(raw)];
  }
  function seed(raw){if(raw===null||!['object','function'].includes(typeof raw)||identities.has(raw))return;value(raw);
    const descriptors=Object.getOwnPropertyDescriptors(raw);for(const key of Object.keys(descriptors).sort()){
      if(!Object.hasOwn(descriptors[key],'value'))fail('input graph is not data-only');seed(descriptors[key].value);}
  }
  initialValues.forEach(seed);
  const add=(kind,fields)=>{if(rows.length>=32768)fail('observation bound');rows.push({kind,...fields});};
  return {id:profile,setCallObserver(observer){invoke=observer;},
    initializeRealm(evaluate){nativePromise=evaluate('Promise');},
    globals:{
      [constructorHook]:(site,callee)=>(...args)=>{
        if(callee!==nativePromise)return construct(callee,args);
        const executor=args[0];if(typeof executor!=='function')return construct(callee,args);
        const observed=function(resolve,reject){
          resolvers.add(resolve);resolvers.add(reject);
          add('enter',{site,executor:value(executor),resolve:value(resolve),reject:value(reject)});
          try{const returned=invoke({callee:executor,receiver:undefined,arguments:[resolve,reject]});
            add('finish',{site,executor:value(executor),completion:{kind:'return',value:value(returned)}});return returned;
          }catch(error){add('finish',{site,executor:value(executor),completion:{kind:'throw',value:value(error)}});throw error;}
        };
        const result=construct(callee,[observed,...args.slice(1)]);add('create',{site,promise:value(result)});return result;
      },
      [callHook]:(site,callee)=>(...args)=>invoke({callee,receiver:undefined,arguments:args,site})
    },
    observeCall(call,nextCall){
      if(!resolvers.has(call.callee))return nextCall();
      if(typeof call.site!=='string')fail('unanchored resolving function call');
      add('resolve',{site:call.site,method:value(call.callee),value:value(call.arguments[0])});return nextCall();
    },
    instrument(text){
      const current=inventory(text);if(current.constructors.length!==original.constructors.length||current.calls.length!==original.calls.length)
        fail('constructor or call source inventory changed');
      const edits=[...current.constructors.map((node,index)=>({start:node.start,end:node.callee.end,
        text:constructorHook+'('+JSON.stringify(original.constructors[index].start+':'+original.constructors[index].end)+',Promise)'})),
      ...current.calls.map((node,index)=>({start:node.callee.start,end:node.callee.end,
        text:callHook+'('+JSON.stringify(original.calls[index].start+':'+original.calls[index].end)+','+text.slice(node.callee.start,node.callee.end)+')'}))]
        .sort((a,b)=>b.start-a.start);
      for(const edit of edits)text=text.slice(0,edit.start)+edit.text+text.slice(edit.end);return text;
    },
    observations(){if(failures.length)fail(failures[0]);return rows;}
  };
}
