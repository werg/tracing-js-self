// Teacher-only source projection. Every state-bearing source transition is
// represented by a checked operation on the single public controller heap.
// Neither this module nor its archive is part of the serving evaluator.
import {isDeepStrictEqual} from 'node:util';
import {parse} from 'acorn';
import {validateBundle} from '../validation.js';
import {replayExact} from '../replay.js';
import {normalizeJournal} from './normalize.js';
import {propertyKeyValue,symbolPropertyKey,stringPropertyKey} from '../property-keys.js';
import {decode,encode,truthy} from '../values.js';
import {describeOwnedGraph} from '../training/graph.js';
import {ownedEffectfulOutcome} from './source-projection.js';
import {compilePromiseSourceProjectionV8} from './protocol-promise-join-source-v8.js';
import {encodeDetailedRecord} from './detail-v8.js';
import {RegionExecutionHarness} from './region-harness.js';
import {cloneRegionController} from './regions.js';
import {createSourceClaimCoordinatorV8} from './source-claim-coordinator-v8.js';
import {ORDINARY_PROTOCOL_SOURCE_V8,protocolSourceClaimsV8} from './protocol-source-claims-v8.js';
import {encodeProtocolRecordV8,validateProtocolValueV8} from './protocol-codec-v8.js';
import {guardHeap,prototype,descriptor,orderedKeys,frameFields} from './protocol-source-shapes-v8.js';
import {PROTOCOL_SOURCE_ADAPTERS_V8} from './protocol-source-extensions-v8.js';
import {createExperimentalModuleNamespaceSourceAdapterV8} from './protocol-module-namespace-source-v8.js';
import {createSharedProtocolSourceComponentsV8} from './protocol-source-bridge-v8.js';
import {createPromiseExecutorTeacherV8} from './protocol-promise-executor-source-v8.js';
import {assertPromiseSourceObjectProfileV8} from './protocol-promise-adoption-source-v8.js';
import {applyProtocolRecordV8,describeProtocolObjectV8,assertProtocolDetailCompatible} from './protocol-state-v8.js';
import {sourceInvalidInFaultV8} from './protocol-intrinsic-error-source-v8.js';
import {ERROR_CONSTRUCTORS,ERROR_PROTOTYPES} from '../owned-error-objects.js';
import {isPromiseIntrinsicValueV8,promiseIntrinsicIdV8,PROMISE_OBJECT_INTRINSICS_V8} from './protocol-promise-object-v8.js';
import {bindModuleSchedulerSourceProjectionV8} from './module-scheduler-source-bridge-v8.js';

const copy=structuredClone,eq=isDeepStrictEqual,lit=value=>({op:'literal',value:copy(value)});
function refuse(message){const error=new TypeError('Protocol source projection: '+message);error.category='unsupported.protocol-source';throw error;}
const valueTag=value=>Array.isArray(value)&&(['undefined','null','bool','str','num','bigint','ref','symbol'].includes(value[0])||isPromiseIntrinsicValueV8(value));
function sourceInventory(source,admitSyntax=()=>false){const functions=new Map(),nodes=new Map();
  function visit(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}
    if(typeof node.type==='string')nodes.set(node.start+':'+node.end,node);
    if(node.type==='Identifier'&&(/^__tracing/.test(node.name)||['__args','__result','__kind'].includes(node.name)))refuse('reserved independent observation name');
    if(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type))functions.set(node.start,node);
    if(['AwaitExpression','YieldExpression','ClassDeclaration','ClassExpression','NewExpression','TaggedTemplateExpression'].includes(node.type)&&!admitSyntax(node))refuse(node.type+' requires its own protocol profile');
    for(const [key,child]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))visit(child);
  }visit(parse(source,{ecmaVersion:'latest',sourceType:'script'}));return {functions,nodes};
}
function referencedNames(node){const names=new Set();
  function visit(value,parent=null,field=null){if(!value||typeof value!=='object')return;if(Array.isArray(value)){value.forEach(child=>visit(child,parent,field));return;}
    if(value.type==='Identifier'&&!(parent?.type==='MemberExpression'&&field==='property'&&!parent.computed)&&
      !(parent?.type==='Property'&&field==='key'&&!parent.computed&&!parent.shorthand)&&!['id','params','label'].includes(field))names.add(value.name);
    for(const [key,child]of Object.entries(value))if(!['start','end','loc','raw'].includes(key))visit(child,value,key);
  }visit(node.body);
  // Parameters resolve in the call's own environment, even when an outer
  // binding with the same spelling remains in its temporal dead zone.
  function bound(pattern){
    if(!pattern)return;
    if(pattern.type==='Identifier')names.delete(pattern.name);
    else if(pattern.type==='AssignmentPattern')bound(pattern.left);
    else if(pattern.type==='RestElement')bound(pattern.argument);
    else if(pattern.type==='ArrayPattern')pattern.elements.forEach(bound);
    else if(pattern.type==='ObjectPattern')pattern.properties.forEach(property=>bound(property.type==='RestElement'?property.argument:property.value));
  }
  node.params?.forEach(bound);return names;
}
export function compileProtocolSourceV8(bundle,{maxGenerated=16384,adapters=PROTOCOL_SOURCE_ADAPTERS_V8,
  moduleNamespacePlan=null,moduleSchedulerPlan=null,moduleSchedulerRequest=null}={}){
  if(validateBundle(bundle).valid!==true||replayExact(bundle).valid!==true)refuse('invalid owned archive');
  assertPromiseSourceObjectProfileV8(bundle);
  const entry=bundle.entrySpec;if(entry?.kind!=='function')refuse('explicit function entry required');
  const source=bundle.sources.find(row=>row.sourceId===entry.sourceId)?.text;
  if(moduleSchedulerPlan){
    if(moduleNamespacePlan)refuse('module scheduler/namespace composition requires its own profile');
    const projection=compileProtocolSourceV8(bundle,{maxGenerated:maxGenerated-1,adapters});
    return bindModuleSchedulerSourceProjectionV8({bundle,projection,plan:moduleSchedulerPlan,request:moduleSchedulerRequest,maxGenerated});
  }
  adapters=adapters.map(adapter=>typeof adapter==='function'?adapter({bundle,source}):adapter).filter(Boolean);
  // Nested async bodies still call ordinary source helpers. The existing
  // synchronous callable peer retains those scopes even without new Promise.
  if(adapters.some(adapter=>['async-scoped-call-source/1','promise-object-source/1'].includes(adapter.id))&&!adapters.some(adapter=>adapter.id==='promise-executor/1'))
    adapters.push({id:'promise-executor/1',sourceComponent:createPromiseExecutorTeacherV8()});
  if(moduleNamespacePlan)adapters.push(createExperimentalModuleNamespaceSourceAdapterV8({source,moduleNamespacePlan,bundle}));
  if(adapters.some(adapter=>typeof adapter.id!=='string'||!adapter.id||adapter.id.length>128)||
    new Set(adapters.map(adapter=>adapter.id)).size!==adapters.length)refuse('distinct versioned extension identities required');
  adapters.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const components=adapters.filter(adapter=>adapter.sourceComponent).sort((a,b)=>a.id.localeCompare(b.id));
  if(moduleNamespacePlan&&components.length)refuse('experimental module namespaces cannot yet compose with shared source components');
  if(components.length){
    const shared=createSharedProtocolSourceComponentsV8({source,bundle,adapters}),
      extensions=[...components.map(adapter=>adapter.sourceComponent),...shared].sort((a,b)=>a.id.localeCompare(b.id));
    return compilePromiseSourceProjectionV8(bundle,{maxGenerated,extensions,extensionIds:extensions.map(component=>component.id),
      sourceProfile:shared.length?'composed-protocol-source/1':components.some(adapter=>adapter.id==='promise-executor/1')?
        'promise-executors-source/1':components.some(adapter=>adapter.id==='promise-adoption/1')?
        'promise-adoption-source/1':'promise-joins-source/1'});
  }
  for(const adapter of adapters){
    const stateful=typeof adapter.captureState==='function'&&typeof adapter.restoreState==='function';
    if((adapter.captureState!==undefined||adapter.restoreState!==undefined)&&!stateful)
      refuse('source adapter state requires both capture and restore: '+adapter.id);
    if(['event','allocate','completeFrame','beforeEvent','afterEvent'].some(name=>typeof adapter[name]==='function')&&
      adapter.stateless!==true&&!stateful)refuse('source adapter must declare retained state or be stateless: '+adapter.id);
  }
  const componentRegistry=[{id:ORDINARY_PROTOCOL_SOURCE_V8,claims:protocolSourceClaimsV8(ORDINARY_PROTOCOL_SOURCE_V8)},
    ...adapters.map(adapter=>({id:adapter.id,claims:adapter.claims??protocolSourceClaimsV8(adapter.id)??{},
      event:adapter.event,allocation:adapter.allocate,completion:adapter.completeFrame,prepare:adapter.prepare}))]
    .map(component=>({...component,prepare:Object.fromEntries(Object.keys(component.claims).map(kind=>[
      kind,component.prepare?.[kind]??((_view,input)=>({kind,identity:input.id??input.event?.eventId??null}))]))}));
  const coordinator=createSourceClaimCoordinatorV8(componentRegistry),adapterById=new Map(adapters.map(adapter=>[adapter.id,adapter]));
  let usedAdapters=new Set(),heapOwners=new Map(),frameOwners=new Map();
  const use=adapter=>{if(typeof adapter.id!=='string'||!adapter.id)refuse('extension requires a stable profile identity');usedAdapters.add(adapter.id);};
  function extension(method,...args){
    const results=[];
    for(const adapter of adapters){const result=adapter[method]?.(...args);
      if(result!==undefined&&result!==null&&result!==false){use(adapter);results.push(result);}}
    if(method==='syntax'||method==='program')return results.length?true:null;
    if(results.length>1)refuse('ambiguous static source declaration: '+method);
    return results[0]??null;
  }
  function guardedHeap(node){const owners=adapters.filter(adapter=>adapter.heapFields?.(node)!=null),extraFields=[];
    for(const adapter of owners){const fields=adapter.heapFields(node);if(!Array.isArray(fields)||typeof adapter.checkHeap!=='function')refuse('heap extension requires fields and a complete state check');
      extraFields.push(...fields);use(adapter);}
    if(owners.length)heapOwners.set(node.id,owners);
    guardHeap(node,{extraFields,allowUnknown:owners.length>0,allowFunctionMetadata:owners.length>0});
  }
  const inventory=sourceInventory(source,node=>extension('syntax',node)),semantic=normalizeJournal(bundle),rows=new Map(semantic.events.map(row=>[row.journalEvent,row]));
  for(const program of Object.values(bundle.programs))if(!program.strict||program.async||program.generator||program.parameterExpressions||program.restIndex>=0)
    if(!extension('program',program))refuse('first protocol source profile requires strict synchronous functions with simple parameters');
  for(const table of ['effects','promises','inputs'])if(Object.keys(bundle.finalState[table]??{}).length)refuse('effects/jobs require their declared protocol profile');
  for(const node of Object.values(bundle.initialState.heap))guardedHeap(node);
  const ownedInitial=describeOwnedGraph(bundle.initialState.heap,entry.arguments);
  const inputGraph={roots:copy(ownedInitial.roots),objects:ownedInitial.objects.map(node=>({id:node.id,kind:node.kind,
    ...(node.prototype===null?{prototype:null}:{}),properties:node.properties.map(({key,value})=>({key,value}))}))};
  const harness=new RegionExecutionHarness({sessionId:'protocol-source',automaticDelivery:false,now:()=>-Infinity,maxGenerated});
  harness.publishProgram({programId:'program1',source,entry:entry.functionName,capabilities:[],
    ...(moduleNamespacePlan?{moduleNamespacePlan}: {})});
  harness.admitInvocation({programId:'program1',invocationId:'invocation1',trackId:'worker1',realmId:'realm1',
    triggerId:'protocol-entry',inputGraph,realmPolicy:'fresh',completionPolicy:'call-return'});
  let controller=harness.controller,claims=[],consumedJournalEvents=[],state=copy(bundle.initialState),names=new Map(),used=new Set(),frames=new Map([[semantic.rootInvocation,'invocation1']]),
    pendingAccessors=new Map(),published=new Set(controller.heap.keys()),publishing=new Set(),extensionState=new Map();
  const functionCodes=new Map(),functionNodes=new Map();
  let cellCounter=0,frameCounter=0,accessorCounter=0;
  for(const program of Object.values(bundle.programs))for(const instruction of program.instructions)
    if(instruction.arg?.codeId&&['DEF_FN','MAKE_FUNCTION'].includes(instruction.op)){
      functionCodes.set(instruction.arg.codeId,instruction.op==='DEF_FN'?instruction.arg.name:'function:'+instruction.start);
      const custom=extension('functionDefinition',instruction,inventory),node=custom?.node??inventory.functions.get(instruction.start);
      if(custom?.code)functionCodes.set(instruction.arg.codeId,custom.code);
      if(!node)refuse('missing exact source function');functionNodes.set(instruction.arg.codeId,node);
    }
  const frame=id=>{if(!frames.has(id))frames.set(id,'guest'+(++frameCounter));return frames.get(id);};
  const cell=(env,name)=>{const key=env+':'+name;if(!names.has(key)){
    const stem=/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)?name:'value';let result=stem;
    while(used.has(result))result=stem+'_'+(++cellCounter);used.add(result);names.set(key,result);
  }return names.get(key);};
  const codeFor=node=>functionCodes.get(node.codeId)??refuse('owned function has no exact source definition');
  function emit(record,event=null,rule='owned-protocol-transition/1',{detail=false,journalEvents=null}={}){
    if(claims.length>=maxGenerated)throw new RangeError('Protocol source record bound');
    const selectedEvents=journalEvents??(event?[event.eventId]:[]),positions=selectedEvents.map(id=>consumedJournalEvents.indexOf(id));
    if(selectedEvents.some(id=>typeof id!=='string')||new Set(selectedEvents).size!==selectedEvents.length||
      positions.some(index=>index<0)||positions.some((index,offset)=>offset>0&&index<=positions[offset-1])||
      (event&&selectedEvents.at(-1)!==event.eventId)||(!event&&selectedEvents.length))
      refuse('source transition journal events must be an ordered unique subset of the consumed prefix ending at the current event');
    if(detail){assertProtocolDetailCompatible(controller,record);controller.commitRecord(record,{mode:'generated',track:'worker1'});
      if(controller.firstWitnessViolation)refuse('incorrect selected primitive claim');}
    else applyProtocolRecordV8(controller,record);
    const source=event?bundle.sites.find(site=>site.siteId===event.siteId):null,
      eventSites=selectedEvents.map(id=>{const observed=bundle.events.find(row=>row.eventId===id),site=observed&&bundle.sites.find(item=>item.siteId===observed.siteId);
        return {eventId:id,site:site?{start:site.start,end:site.end}:null};});
    claims.push({kind:detail?'detail':'protocol',record:copy(record),line:detail?encodeDetailedRecord(record,{role:'generated'}):encodeProtocolRecordV8(record),
      certificate:{rule,journalEvents:selectedEvents,source:source?{start:source.start,end:source.end}:null,
        ...(selectedEvents.length>1?{sourceEvents:eventSites}:{})}});
  }
  const publicIdentity=id=>ERROR_PROTOTYPES.includes(id)?promiseIntrinsicIdV8(id):id;
  function initializeIntrinsics(event){if(!controller.protocol?.promiseObjects?.initialized)
    emit({kind:'promise.intrinsics'},event,'owned-source-ordinary-intrinsics/1');
    for(const name of PROMISE_OBJECT_INTRINSICS_V8)published.add(promiseIntrinsicIdV8(name));}
  function publicDescriptor(node,key,event=null){const value=descriptor(node,key);
    return value?.kind==='data'?{...value,value:tag(value.value,event)}:value?{...value,get:tag(value.get,event),set:tag(value.set,event)}:null;}
  function normalizeValueTag(value,event=null){
    const normalized=extension('normalizeTag',context,value,event);
    if(normalized===null)return value;
    if(!valueTag(normalized))refuse('callable normalization produced an invalid protocol value');
    validateProtocolValueV8(normalized);return normalized;
  }
  function tag(value,event=null){
    value=normalizeValueTag(value,event);
    if(isPromiseIntrinsicValueV8(value)){initializeIntrinsics(event);return ['ref',promiseIntrinsicIdV8(value[1])];}
    if(!valueTag(value))refuse('value requires an explicit callable/protocol interface: '+JSON.stringify(value));
    if(value[0]==='ref'&&!published.has(value[1])){
      const initial=bundle.initialState.heap[value[1]];
      if(!initial||initial.kind!=='function'||!eq(initial,state.heap[value[1]]))refuse('reference used before its owned allocation');
      publish(initial,event);
    }validateProtocolValueV8(value);return copy(value);
  }
  const bind=(name,value,event=null)=>{
    value=tag(value,event);emit(value[0]==='symbol'?{kind:'bind',name,value}:{kind:'bind',fields:{name,value}},event,'owned-source-cell/1',{detail:value[0]!=='symbol'});
  };
  function publish(node,event){
    guardedHeap(node);if(published.has(node.id))return;
    const owner=prepared('allocation:'+node.id);
    if(owner.owner===ORDINARY_PROTOCOL_SOURCE_V8)return baseAllocate(node,event);
    const adapter=adapterById.get(owner.owner);
    if(adapter?.allocate?.(context,node,event,owner.prepared)!==true)
      refuse('claimed source allocation handler declined: '+owner.owner);
    use(adapter);published.add(node.id);
  }
  function baseAllocate(node,event){
    guardedHeap(node);if(published.has(node.id))return;
    if(node.declaredError)refuse('intrinsic Error allocation requires its derived fault transition');
    if(ERROR_PROTOTYPES.includes(node.id)){initializeIntrinsics(event);published.add(node.id);return;}
    if(publishing.has(node.id))refuse('recursive unpublished closure capture');publishing.add(node.id);
    if(node.kind==='symbol'){
      emit(node.registeredKey===undefined?{kind:'symbol.create',id:node.id,description:copy(node.description)}:
        {kind:'symbol.for',id:node.id,key:node.registeredKey},event,'owned-source-symbol/1');published.add(node.id);publishing.delete(node.id);return;
    }
    const captures=[];
    if(node.kind==='function'){
      const wanted=referencedNames(functionNodes.get(node.codeId)),seen=new Set();
      for(let env=node.closureEnvId;env;env=state.envs[env]?.parent)for(const [name,binding]of Object.entries(state.envs[env]?.bindings??{})){
        if(!wanted.has(name)||seen.has(name))continue;seen.add(name);
        if(binding.initialized&&!valueTag(binding.token?.value))continue; // Immutable builtins remain source operations, never fake closures.
        // Hoisted functions capture the declared cell before a later lexical
        // initializer runs. Retain its identity without exposing the owned
        // placeholder token or a value from a future transition.
        const nameOfCell=cell(env,name);if(binding.initialized&&!controller.locals.has(nameOfCell))bind(nameOfCell,binding.token.value,event);
        captures.push({binding:name,cell:nameOfCell});
      }
    }
    const properties=Object.entries(node.properties??{}).filter(([key])=>!(node.kind==='array'&&key==='length')).map(([key,member])=>({key:propertyKeyValue(key),value:tag(member.value,event)}));
    emit({kind:'allocate',name:node.id,objectKind:node.kind==='function'?'closure':node.kind,length:node.kind==='array'?node.properties.length.value[1]:null,
      properties,code:node.kind==='function'?codeFor(node):null,captures,
      functionKind:node.kind==='function'?(node.arrow?'arrow':'ordinary'):null,
      lexicalReceiver:node.kind==='function'&&node.arrow?tag(node.lexicalThis,event):null},event,'owned-source-allocation/1');
    published.add(node.id);publishing.delete(node.id);
    if(prototype(node)!=='ordinary')emit({kind:'property.prototype',object:node.id,prototype:prototype(node),success:true},event);
    for(const key of orderedKeys(node))if(Object.hasOwn(node.accessors??{},key)||Object.hasOwn(node.dataAttributes??{},key))emit({kind:'property.define',object:node.id,key:propertyKeyValue(key),descriptor:descriptor(node,key),success:true},event);
    if(node.extensible===false)emit({kind:'property.preventExtensions',object:node.id},event);
  }
  function resolve(name,frameId){for(let env=state.frames[frameId]?.envId;env;env=state.envs[env]?.parent)
    if(Object.hasOwn(state.envs[env]?.bindings??{},name)){const selected=names.get(env+':'+name);return selected&&controller.locals.has(controller.captureAliases.get(selected)??selected)?selected:null;}return null;}
  function operand(value,node,event){
    value=tag(value,event);const name=node?.type==='Identifier'?resolve(node.name,event.invocationId):null;
    return name&&eq(controller.locals.get(controller.captureAliases.get(name)??name),value)?{op:'local',name}:lit(value);
  }
  function compute(expr,result,event,{name=null}={}){
    const map=value=>{if(!value||typeof value!=='object')return value;if(Array.isArray(value))return isPromiseIntrinsicValueV8(value)?tag(value,event):value.map(map);return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,map(item)]));};expr=map(expr);
    result=tag(result,event);let hasSymbol=false;const inspect=value=>{if(!value||typeof value!=='object')return;if(Array.isArray(value)&&value[0]==='symbol'||value.op==='local'&&controller.locals.get(controller.captureAliases.get(value.name)??value.name)?.[0]==='symbol')hasSymbol=true;for(const item of Object.values(value))inspect(item);};inspect(expr);
    if(!hasSymbol&&result[0]!=='symbol'&&!(expr.op==='unary'&&expr.operator==='typeof'&&expr.arg.value?.[0]==='ref')){
      emit({kind:'compute',fields:{expr,result}},event,'owned-source-computation/1',{detail:true});if(name!==null)bind(name,result,event);
    }else emit({kind:'compute',expr,result,bind:name},event,'owned-source-computation/1');
  }
  function key(value){if(value?.[0]==='symbol')return copy(value);if(!['undefined','null','str','num','bool','bigint'].includes(value?.[0]))refuse('observable ToPropertyKey requires a coercion protocol');return ['str',String(decode(value))];}
  function projectInvalidInFault(event,row,error,heapChanges){
    const fault=sourceInvalidInFaultV8(bundle,state,event,row);
    if(fault.error!==error.id||heapChanges.length!==1)refuse('invalid in fault allocation differs');
    emit({kind:'property.fault',operation:'has',target:tag(fault.target,event),key:tag(fault.key,event),error:fault.error},
      event,'owned-source-in-invalid-rhs/1');
    published.add(fault.error);return true;
  }
  function checkNode(node){guardedHeap(node);
    for(const adapter of heapOwners.get(node.id)??[])if(adapter.checkHeap(context,node)!==true)refuse('extension failed its complete heap comparison: '+adapter.id);
    if(!['object','array','function','symbol'].includes(node.kind))return;
    return baseCheckHeap(node);
  }
  function baseCheckHeap(node){if(node.kind==='symbol'){
      const row=controller.protocol?.symbols.find(row=>row.id===node.id);if(!row||!eq(row.description,node.description)||
        (node.registeredKey===undefined?row.kind!=='unique':row.kind!=='registry'||row.key!==node.registeredKey))refuse('Symbol declaration differs from owned identity');return;}
    const expected={kind:node.kind==='function'?'closure':node.kind,prototype:ERROR_PROTOTYPES.includes(node.id)&&node.prototype==='Object.prototype'?['ref',promiseIntrinsicIdV8('Object.prototype')]:prototype(node),extensible:node.extensible!==false,
      properties:orderedKeys(node).map(key=>({key:propertyKeyValue(key),descriptor:publicDescriptor(node,key)})),
      ...(node.kind==='function'?{code:codeFor(node),functionKind:node.arrow?'arrow':'ordinary',lexicalReceiver:node.arrow?node.lexicalThis:null}:{})};
    if(!eq(expected,describeProtocolObjectV8(controller,publicIdentity(node.id))))refuse('shared descriptor/heap state differs after owned transition '+node.id);
    if(node.declaredError&&controller.heap.get(node.id)?.declaredError!==node.declaredError)
      refuse('intrinsic Error type differs from its derived public fault '+node.id);
  }
  function arrayMutationReceiver(value,method){
    const node=value?.[0]==='ref'?state.heap[value[1]]:null;
    if(node?.kind!=='array'||!['Array.prototype',undefined].includes(node.prototype)||
      descriptor(node,method.slice('Array.prototype.'.length))!==null)
      refuse('array mutation requires an unchanged ordinary builtin method');
    const length=node.properties.length?.value;
    if(length?.[0]!=='num'||!Number.isSafeInteger(length[1])||length[1]<0||length[1]>10000)
      refuse('array mutation requires a bounded own length');
    return node;
  }
  function builtin(event,row,changes){
    const raw=row.operands[0],callee=raw?.[0]==='method'?raw[1]:raw,args=row.operands.slice(1),name=callee?.[0]==='intrinsic'?callee[1]:callee?.[0]==='builtinfn'?callee[1]:null;
    if(name==='Function.prototype.hasInstance'){
      if(raw?.[0]!=='method'||args.length!==1)refuse('hasInstance requires its selected builtin method and original receiver');
      initializeIntrinsics(event);emit({kind:'object.hasInstance',constructor:tag(raw[2],event),value:tag(args[0],event),result:tag(row.result,event)},event,'owned-source-has-instance/1');return;
    }
    if(['Array.prototype.push','Array.prototype.pop'].includes(name)){
      if(raw[0]!=='method')refuse('array mutation requires its original method receiver');
      const receiver=tag(raw[2],event),node=arrayMutationReceiver(receiver,name),length=node.properties.length.value[1];
      if(changes.some(change=>change.id!==node.id))refuse('array mutation has an undeclared heap effect');
      emit({kind:'property.get',object:node.id,key:['str','length'],receiver,result:['num',length]},event,'owned-source-array-length/1');
      if(name==='Array.prototype.push'){
        if(length+args.length>10000)refuse('array push exceeds the bounded length');
        args.forEach((value,index)=>emit({kind:'property.set',object:node.id,key:['str',String(length+index)],
          receiver,value:tag(value,event),success:true},event,'owned-source-array-append/1'));
        emit({kind:'property.set',object:node.id,key:['str','length'],receiver,value:['num',length+args.length],success:true},event,'owned-source-array-length/1');
        compute({op:'binary',operator:'+',left:lit(['num',length]),right:lit(['num',args.length])},row.result,event);
      }else{
        if(length){
          const last=descriptor(node,String(length-1));
          if(last?.kind!=='data')refuse('array pop requires an own final data element');
          emit({kind:'property.get',object:node.id,key:['str',String(length-1)],receiver,result:tag(row.result,event)},event,'owned-source-array-pop/1');
        }else if(!eq(row.result,['undefined']))refuse('empty array pop must return undefined');
        emit({kind:'property.set',object:node.id,key:['str','length'],receiver,value:['num',Math.max(0,length-1)],success:true},event,'owned-source-array-length/1');
      }
      return;
    }
    if(name==='Symbol'||name==='Symbol.for'){
      const value=args[0]??['undefined'];if(value[0]==='ref'||value[0]==='symbol')refuse('Symbol description/key conversion needs a coercion protocol');
      const id=row.result?.[1];if(row.result?.[0]!=='symbol')refuse('Symbol result identity missing');
      if(name==='Symbol')emit({kind:'symbol.create',id,description:value[0]==='undefined'?['undefined']:['str',String(decode(value))]},event,'owned-source-symbol/1');
      else emit({kind:'symbol.for',id,key:String(decode(value))},event,'owned-source-symbol/1');published.add(id);return;
    }
    if(name==='Symbol.keyFor'||name==='Symbol.prototype.toString'||name==='Symbol.prototype.valueOf'){
      const symbol=name==='Symbol.keyFor'?args[0]:raw[2];tag(symbol,event);
      if(name==='Symbol.prototype.valueOf')compute(lit(symbol),row.result,event);
      else emit({kind:'symbol.read',symbol,operation:name==='Symbol.keyFor'?'keyFor':'toString',result:tag(row.result,event),bind:null},event);return;
    }
    if(['Object.getPrototypeOf','Object.isExtensible','Object.getOwnPropertyDescriptor'].includes(name)){
      const input=args[0],node=input?.[0]==='ref'||input?.[0]==='intrinsic'?state.heap[input[1]]:null;
      if(!node||!['object','array'].includes(node.kind))refuse('ordinary reflection requires owned object storage');
      initializeIntrinsics(event);const object=tag(input,event)[1];
      if(name==='Object.getOwnPropertyDescriptor'){
        const encoded=key(args[1]??['undefined']),storage=encoded[0]==='str'?stringPropertyKey(encoded[1]):symbolPropertyKey(encoded[1]),
          described=publicDescriptor(node,storage,event),allocation=row.result?.[0]==='ref'?row.result[1]:null;
        if(described===null?row.result?.[0]!=='undefined':allocation===null)refuse('descriptor result identity differs');
        emit({kind:'property.descriptor',object,key:encoded,descriptor:described,name:allocation},event,'owned-source-object-descriptor/1');
        if(allocation!==null)published.add(allocation);
      }else emit({kind:name==='Object.getPrototypeOf'?'property.getPrototypeOf':'property.isExtensible',object,result:tag(row.result,event)},event,'owned-source-object-reflection/1');
      return;
    }
    if(name==='Object.hasOwn'){
      if(args[0]?.[0]!=='ref'||changes.length)refuse('own-property check requires ordinary storage without heap effects');
      emit({kind:'property.hasOwn',object:tag(args[0],event)[1],key:key(args[1]??['undefined']),result:tag(row.result,event)},event,'owned-source-own-property/1');return;
    }
    if(name==='Reflect.has'){
      if(args[0]?.[0]!=='ref'||changes.length)refuse('property existence requires ordinary storage without heap effects');
      emit({kind:'property.has',object:tag(args[0],event)[1],key:key(args[1]??['undefined']),result:tag(row.result,event)},event,'owned-source-property-existence/1');return;
    }
    if(name==='Reflect.deleteProperty'){
      if(args[0]?.[0]!=='ref'||row.result?.[0]!=='bool'||changes.some(change=>change.id!==args[0][1]))
        refuse('property deletion requires an ordinary receiver and exact boolean result');
      emit({kind:'property.delete',object:tag(args[0],event)[1],key:key(args[1]??['undefined']),success:row.result[1]},event,'owned-source-property-deletion/1');return;
    }
    if(['Reflect.ownKeys','Object.keys','Object.getOwnPropertyNames','Object.getOwnPropertySymbols'].includes(name)){
      if(args[0]?.[0]!=='ref'||row.result?.[0]!=='ref')refuse('key enumeration requires an ordinary object');
      const allocation=changes.find(change=>change.before===null&&change.id===row.result[1]);if(!allocation)refuse('key list allocation missing');
      const mode={'Reflect.ownKeys':'own','Object.keys':'enumerable-strings','Object.getOwnPropertyNames':'strings','Object.getOwnPropertySymbols':'symbols'}[name];
      const keys=Array.from({length:allocation.after.properties.length.value[1]},(_,index)=>allocation.after.properties[index].value);
      emit({kind:'property.keys',object:args[0][1],mode,name:row.result[1],keys},event,'owned-source-key-enumeration/1');published.add(row.result[1]);return;
    }
    if(['Object.entries','Object.values'].includes(name)){
      const input=args[0]?.[0]==='ref'?state.heap[args[0][1]]:null,
        output=row.result?.[0]==='ref'?changes.find(change=>change.id===row.result[1]&&change.before===null)?.after:null;
      if(!['object','array'].includes(input?.kind)||Object.keys(input.accessors??{}).length||output?.kind!=='array')
        refuse('value enumeration requires an ordinary object with own data properties');
      const keys=orderedKeys(input).filter(storage=>{
        const described=descriptor(input,storage);return propertyKeyValue(storage)[0]==='str'&&described?.kind==='data'&&described.enumerable;
      }).map(propertyKeyValue),allocated=new Set([output.id]);
      // The result array temporarily holds the checked key list, then each
      // slot is replaced by its value or freshly allocated entry pair.
      emit({kind:'property.keys',object:input.id,mode:'enumerable-strings',name:output.id,keys},event,'owned-source-value-enumeration-keys/1');
      published.add(output.id);
      for(const [index,property]of keys.entries()){
        const value=descriptor(input,stringPropertyKey(property[1])).value;
        emit({kind:'property.get',object:input.id,key:property,receiver:args[0],result:tag(value,event)},event,'owned-source-value-enumeration-read/1');
        let replacement=value;
        if(name==='Object.entries'){
          const pairValue=output.properties[String(index)]?.value,pair=pairValue?.[0]==='ref'?
            changes.find(change=>change.id===pairValue[1]&&change.before===null)?.after:null;
          if(pair?.kind!=='array'||!eq(pair.properties.length?.value,['num',2])||
            !eq(pair.properties['0']?.value,property)||!eq(pair.properties['1']?.value,value))
            refuse('entry pair differs from its enumerated key and current data value');
          publish(pair,event);allocated.add(pair.id);replacement=pairValue;
        }
        emit({kind:'property.set',object:output.id,key:['str',String(index)],receiver:['ref',output.id],
          value:tag(replacement,event),success:true},event,'owned-source-value-enumeration-slot/1');
      }
      if(changes.length!==allocated.size||changes.some(change=>change.before!==null||!allocated.has(change.id)))
        refuse('value enumeration has an undeclared heap effect');
      return;
    }
    if(name==='Object.defineProperty'){
      if(!(['ref','intrinsic'].includes(args[0]?.[0]))||args[2]?.[0]!=='ref')refuse('ordinary descriptor arguments required');
      const object=tag(args[0],event)[1],ownedId=args[0][1],encoded=key(args[1]),storage=encoded[0]==='str'?stringPropertyKey(encoded[1]):symbolPropertyKey(encoded[1]);
      const target=changes.find(change=>change.id===ownedId)?.after??state.heap[ownedId];
      const described=publicDescriptor(target,storage,event);if(!described)refuse('defined property missing');
      emit({kind:'property.define',object,key:encoded,descriptor:described,success:true},event,'owned-source-descriptor/1');return;
    }
    if(name==='Object.preventExtensions'){
      const object=args[0]?.[0]==='ref'?args[0][1]:null,
        changed=changes.find(change=>change.id===object)?.after??state.heap[object];
      if(object===null||changes.some(change=>change.id!==object)||changed?.extensible!==false||
        !eq(row.result,['ref',object]))refuse('preventExtensions requires one exact ordinary object result');
      emit({kind:'property.preventExtensions',object},event,'owned-source-object-prevent-extensions/1');return;
    }
    if(name==='Object.setPrototypeOf'){
      if(!['ref','intrinsic'].includes(args[0]?.[0])||!['null','ref','intrinsic'].includes(args[1]?.[0]))refuse('ordinary prototype operands required');
      emit({kind:'property.prototype',object:tag(args[0],event)[1],prototype:args[1][0]==='null'?null:tag(args[1],event),success:true},event);return;
    }
    if(name==='Object.create'){
      const allocation=changes.find(change=>change.before===null&&change.id===row.result?.[1]);
      if(!allocation||args.length>1)refuse('Object.create with descriptor conversion needs its protocol');publish(allocation.after,event);return;
    }
    refuse('builtin call needs a declared protocol operation: '+name);
  }
  let activePlan=null;
  function prepared(id){const selected=activePlan?.get(id);if(!selected)refuse('unreserved current source slot: '+id);return selected;}
  function planEvent(event,row){
    const ownedFrame=event&&state.frames[event.invocationId],candidate=ownedFrame&&bundle.programs[ownedFrame.codeId]?.instructions[ownedFrame.pc],
      instruction=candidate?.siteId===event?.siteId?candidate:null,
      site=event&&bundle.sites.find(item=>item.siteId===event.siteId),sourceNode=site?inventory.nodes.get(site.start+':'+site.end)??null:null,
      view={source,owned:state,event,row:row??null,instruction,sourceNode:copy(sourceNode),
        components:Object.fromEntries(adapters.map(adapter=>[adapter.id,adapter.captureState?.()??{}]))},slots=[],allocations=new Map();
    for(const node of Object.values(state.heap))if(!published.has(node.id))allocations.set(node.id,node);
    for(const change of event?.stateChanges??[])if(change.table==='heap'&&change.before===null)allocations.set(change.id,change.after);
    for(const node of allocations.values())slots.push({id:'allocation:'+node.id,kind:'allocation',input:node});
    if(event)slots.push({id:'event',kind:'event',input:{event,row:row??null}});
    for(const change of event?.stateChanges??[])if(change.table==='frames'&&change.before&&change.after&&
      !['completed','thrown'].includes(change.before.status)&&['completed','thrown'].includes(change.after.status))
      slots.push({id:'completion:'+change.id,kind:'completion',input:change});
    activePlan=new Map(coordinator.plan({view,slots}).map(slot=>[slot.id,slot]));
  }
  const context={bundle,source,inventory,
    get state(){return state;},get beforeState(){return state;},get controller(){return controller;},get claims(){return claims;},
    emit,bind,tag,cell,frame,codeFor,publish,baseAllocate,baseCheckHeap,
    functionCodes,functionNodes,get published(){return published;},get pendingAccessors(){return pendingAccessors;},
    key,descriptor,prototype,orderedKeys,refuse,copy,eq,
    markPublished(id){published.add(id);},
    get publicInvocation(){return controller.stack.at(-1);},
    getOwnedFrame(id){return state.frames[id];},
    get extensionState(){return extensionState;},delegateEvent};
  function delegateEvent(adapterId,event,row=null){
    const adapter=adapterById.get(adapterId);if(!adapter?.event)refuse('unknown compositional source subtransition: '+adapterId);
    const ownedFrame=event&&state.frames[event.invocationId],candidate=ownedFrame&&bundle.programs[ownedFrame.codeId]?.instructions[ownedFrame.pc],
      instruction=candidate?.siteId===event?.siteId?candidate:null,
      site=event&&bundle.sites.find(item=>item.siteId===event.siteId),sourceNode=site?inventory.nodes.get(site.start+':'+site.end)??null:null,
      view={source,owned:state,event,row:row??null,instruction,sourceNode:copy(sourceNode),
        components:Object.fromEntries(adapters.map(item=>[item.id,item.captureState?.()??{}]))},
      [selected]=coordinator.plan({view,slots:[{id:'delegated-event',kind:'event',input:{event,row:row??null}}]});
    if(selected.owner!==adapterId)refuse('compositional subtransition has a different unique owner: '+selected.owner);
    if(adapter.event(context,event,row,selected.prepared)!==true)refuse('compositional source subtransition declined: '+adapterId);
    use(adapter);return true;
  }
  for(const adapter of adapters)adapter.setup?.(context);
  function observe(method,event,row){
    let failure;
    for(const adapter of [...adapters].sort((a,b)=>a.id.localeCompare(b.id))){
      try{if(adapter[method]?.(context,event,row)===false)refuse('source observer rejected '+method+': '+adapter.id);}
      catch(error){failure??=error;}
    }
    if(failure)throw failure;
  }
  const projectionState=()=>({controller,claims,state,names,used,frames,pendingAccessors,published,publishing,activePlan,
    extensionState,usedAdapters,heapOwners,frameOwners,cellCounter,frameCounter,accessorCounter});
  function selectProjectionState(selected){
    ({controller,claims,state,names,used,frames,pendingAccessors,published,publishing,activePlan,
      extensionState,usedAdapters,heapOwners,frameOwners,cellCounter,frameCounter,accessorCounter}=selected);
  }
  function transaction(run){
    const live=projectionState(),adapterStates=adapters.map(adapter=>adapter.captureState?.()),
      stagedAdapterStates=copy(adapterStates),detached=copy({state,names,used,frames,pendingAccessors,published,publishing,extensionState});
    selectProjectionState({...live,...detached,controller:cloneRegionController(controller),claims:[...claims],
      usedAdapters:new Set(usedAdapters),heapOwners:new Map(heapOwners),frameOwners:new Map(frameOwners)});
    try{
      for(const [index,adapter]of adapters.entries())if(adapter.captureState)adapter.restoreState(stagedAdapterStates[index]);
      return run();
    }
    catch(error){
      selectProjectionState(live);
      for(const [index,adapter]of adapters.entries())if(adapter.captureState)adapter.restoreState(adapterStates[index]);
      throw error;
    }
  }
  const entryEnv=state.frames[semantic.rootInvocation].envId;
  transaction(()=>{planEvent(null,null);for(const [name,binding]of Object.entries(state.envs[entryEnv]?.bindings??{}))
    if(binding.initialized)bind(cell(entryEnv,name),binding.token.value);});
  function projectEvent(event){
    if(consumedJournalEvents.includes(event.eventId))refuse('duplicate source journal event');
    consumedJournalEvents.push(event.eventId);
    const row=rows.get(event.eventId),heapChanges=event.stateChanges.filter(change=>change.table==='heap');
    planEvent(event,row);
    observe('beforeEvent',event,row);
    for(const change of heapChanges)if(change.after)guardedHeap(change.after);else refuse('heap deletion needs a protocol');
    for(const change of event.stateChanges)if(change.table==='frames'&&change.after){
      const owners=adapters.filter(adapter=>adapter.frameFields?.(change.after)!=null),allowed=new Set(frameFields);
      for(const adapter of owners){const fields=adapter.frameFields(change.after);if(!Array.isArray(fields)||typeof adapter.checkFrame!=='function')refuse('frame extension requires fields and state checking');
        fields.forEach(key=>allowed.add(key));use(adapter);}
      if(owners.length)frameOwners.set(change.id,owners);
      if(Object.keys(change.after).some(key=>!allowed.has(key))||
        !owners.length&&(change.after.asyncPromiseId||change.after.awaiting||change.after.handlers?.length))refuse('frame continuation needs its declared protocol');
    }
    const eventOwner=prepared('event'),eventAdapter=adapterById.get(eventOwner.owner),handled=eventOwner.owner!==ORDINARY_PROTOCOL_SOURCE_V8;
    if(handled){
      if(eventAdapter?.event?.(context,event,row,eventOwner.prepared)!==true)
        refuse('claimed source event handler declined: '+eventOwner.owner);
      use(eventAdapter);
    }
    if(!row&&!handled&&heapChanges.length)refuse('unprojected owned heap transition: '+event.operation);
    if(row&&!handled){
      if(row.child){
        if(!['property.read','property.write','call.enter'].includes(event.operation))refuse('implicit callback dispatch needs its declared protocol');
        for(const change of heapChanges.filter(change=>change.before===null))publish(change.after,event);
        const child=frame(row.child);
        if(event.operation==='property.read'||event.operation==='property.write'){
          if(row.operands[0]?.[0]!=='ref')refuse('accessor receiver must be an owned ordinary object');
          const operation=event.operation==='property.read'?'get':'set',id='access'+(++accessorCounter);
          emit({kind:'property.'+operation+'.call',id,child,object:tag(row.operands[0],event)[1],key:key(row.operands[1]),
            receiver:tag(row.receiver,event),...(operation==='set'?{value:tag(row.operands[2],event)}:{})},event,'owned-source-accessor-call/1');
          pendingAccessors.set(child,{id,operation,value:operation==='set'?tag(row.operands[2],event):null});
        }else{
          const raw=row.operands[0],callee=raw?.[0]==='method'?raw[1]:raw;
          if(callee?.[0]!=='ref')refuse('builtin callback dispatch needs an explicit operation');
          emit({kind:'call',child,callee:tag(callee,event),receiver:tag(raw?.[0]==='method'?raw[2]:['undefined'],event),arguments:row.operands.slice(1).map(value=>tag(value,event))},event,'owned-source-call/1');
        }
        const environment=event.stateChanges.find(change=>change.table==='envs'&&change.before===null)?.after;
        for(const [name,binding]of Object.entries(environment?.bindings??{}))if(binding.initialized)bind(cell(environment.id,name),binding.token.value,event);
      }else if(event.operation==='call.enter')builtin(event,row,heapChanges);
      else if(row.allocations?.length)for(const allocation of row.allocations){
        const node=heapChanges.find(change=>change.id===allocation.identity)?.after;if(!node)refuse('allocation patch missing');
        if(node.declaredError){projectInvalidInFault(event,row,node,heapChanges);continue;}
        publish(node,event);
      }
      else if(event.operation==='property.read'){
        const [base,property]=row.operands;
        const output=row.result?.[0]==='method'?row.result[1]:row.result,
          owner=state.frames[event.invocationId],inst=bundle.programs[owner?.codeId]?.instructions[owner?.pc];
        if(inst?.op==='REQUIRE_OBJECT'){
          if(row.operands.length!==1||!['ref','promise','intrinsic','builtinfn','hostfn'].includes(base?.[0])||!eq(row.result,base))refuse('object guard requires its original reference value');
          compute(lit(tag(base,event)),row.result,event);
        }else if(output?.[0]==='builtinfn'&&['Array.prototype.push','Array.prototype.pop'].includes(output[1])){
          // A builtin method is not a public first-class value. Its direct call
          // is expanded into checked length reads and ordinary property writes.
          // Capturing or replacing the method still requires a callable profile.
          arrayMutationReceiver(base,output[1]);
          if(!eq(property,['str',output[1].slice('Array.prototype.'.length)]))refuse('array method lookup key differs');
        }else if(base?.[0]==='intrinsic'&&ERROR_CONSTRUCTORS.includes(base[1])){
          initializeIntrinsics(event);emit({kind:'promise.intrinsic.get',base:base[1],key:key(property),result:tag(output,event)},event,'owned-source-error-intrinsic/1');
        }else if(base?.[0]==='ref'||base?.[0]==='intrinsic'&&ERROR_PROTOTYPES.includes(base[1]))emit({kind:'property.get',object:tag(base,event)[1],key:key(property),receiver:tag(base,event),
          result:tag(row.result?.[0]==='method'?row.result[1]:row.result,event)},event,'owned-source-property-read/1');
        else if(base?.[0]==='symbol'&&property?.[0]==='str'&&property[1]==='description')
          emit({kind:'symbol.read',symbol:tag(base,event),operation:'description',result:tag(row.result,event),bind:null},event);
        else if(!['intrinsic','symbol'].includes(base?.[0])||!['method','builtinfn','symbol'].includes(row.result?.[0]))
          refuse('primitive/intrinsic property needs its own protocol');
      }else if(event.operation==='property.write'){
        if(row.operands[0]?.[0]!=='ref'&&!(row.operands[0]?.[0]==='intrinsic'&&ERROR_PROTOTYPES.includes(row.operands[0][1])))refuse('ordinary write receiver required');
        const owner=state.frames[event.invocationId],instruction=bundle.programs[owner?.codeId]?.instructions[owner?.pc];
        if(instruction?.op==='DEFINE_LITERAL_PROP'&&instruction.siteId===event.siteId){
          const object=row.operands[0][1],node=heapChanges.find(change=>change.id===object)?.after??state.heap[object];
          if(instruction.arg.kind==='prototype')emit({kind:'property.prototype',object,prototype:prototype(node),success:true},event,'owned-source-literal-prototype/1');
          else{
            const property=key(row.operands[1]),storage=property[0]==='str'?stringPropertyKey(property[1]):symbolPropertyKey(property[1]);
            emit({kind:'property.define',object,key:property,descriptor:descriptor(node,storage),success:true},event,'owned-source-literal-definition/1');
          }
        }else emit({kind:'property.set',object:tag(row.operands[0],event)[1],key:key(row.operands[1]),receiver:tag(row.operands[0],event),value:tag(row.operands[2],event),success:true},event,'owned-source-property-write/1');
      }else if(event.operation==='property.delete'){
        const [base,property]=row.operands;
        if(base?.[0]!=='ref'||row.result?.[0]!=='bool'||heapChanges.some(change=>change.id!==base[1]))
          refuse('property deletion requires an ordinary receiver and exact boolean result');
        emit({kind:'property.delete',object:tag(base,event)[1],key:key(property),success:row.result[1]},event,'owned-source-property-deletion/1');
      }else if(event.operation==='property.update'){
        const [base,property,old]=row.operands,encoded=key(property);
        if(base?.[0]!=='ref'||!['undefined','null','bool','str','num','bigint'].includes(old?.[0]))
          refuse('property update requires an ordinary receiver and primitive numeric conversion');
        const storage=encoded[0]==='str'?stringPropertyKey(encoded[1]):symbolPropertyKey(encoded[1]),
          node=heapChanges.find(change=>change.id===base[1])?.after,next=node?.properties?.[storage]?.value;
        if(!next||!row.update)refuse('property update lacks its committed data value');
        const numeric=old[0]==='bigint'?old:encode(Number(decode(old))),
          converted=old[0]==='bigint'?lit(old):{op:'unary',operator:'+',arg:lit(old)};
        emit({kind:'property.get',object:base[1],key:encoded,receiver:tag(base,event),result:tag(old,event)},event,'owned-source-property-update-read/1');
        compute(converted,numeric,event);
        compute({op:'binary',operator:row.update.operator==='++'?'+':'-',left:lit(numeric),
          right:lit(old[0]==='bigint'?['bigint','1']:['num',1])},next,event);
        emit({kind:'property.set',object:base[1],key:encoded,receiver:tag(base,event),value:tag(next,event),success:true},event,'owned-source-property-update-write/1');
        if(!eq(row.result,row.update.prefix?next:numeric))refuse('property update completion differs from its prefix/postfix mode');
      }else if(row.arithmetic){
        const node=inventory.nodes.get(row.source?.start+':'+row.source?.end);
        compute({op:'binary',operator:row.arithmetic.operator,left:operand(row.operands[0],node?.left,event),right:operand(row.operands[1],node?.right,event)},row.result,event);
      }else if(event.operation==='primitive.binary'){
        const owner=state.frames[event.invocationId],inst=bundle.programs[owner?.codeId]?.instructions[owner?.pc];
        if(inst?.op==='INSTANCEOF_RESULT'){compute({op:'unary',operator:'!',arg:{op:'unary',operator:'!',arg:lit(tag(row.operands[0],event))}},row.result,event);}
        else if(inst?.op==='INSTANCEOF_DEFAULT'){initializeIntrinsics(event);emit({kind:'object.hasInstance',constructor:tag(row.operands[1],event),value:tag(row.operands[0],event),result:tag(row.result,event)},event,'owned-source-default-has-instance/1');}
        else {const node=inventory.nodes.get(row.source?.start+':'+row.source?.end);if(!node?.operator)refuse('binary source operator missing');
        if(node.operator==='in'&&event.completion?.type==='throw'){
          refuse('invalid in-operator RHS allocation was not claimed by its derived fault transition');
        }else if(node.operator==='in'){
          if(row.operands[1]?.[0]!=='ref'||heapChanges.length)refuse('in requires an ordinary object and separately checked key conversion');
          emit({kind:'property.has',object:tag(row.operands[1],event)[1],key:key(row.operands[0]),result:tag(row.result,event)},event,'owned-source-property-existence/1');
        }else compute({op:'binary',operator:node.operator,left:operand(row.operands[0],node.left,event),right:operand(row.operands[1],node.right,event)},row.result,event);}
      }else if(event.operation==='primitive.unary'){
        const node=inventory.nodes.get(row.source?.start+':'+row.source?.end);if(!node?.operator)refuse('unary source operator missing');
        compute({op:'unary',operator:node.operator,arg:operand(row.operands[0],node.argument,event)},row.result,event);
      }else if(event.operation==='binding.update'){
        const write=row.writes.find(write=>write.kind==='cell');if(!write||!['num','bigint'].includes(row.operands[0]?.[0]))refuse('update conversion needs its protocol');
        const name=cell(write.env,write.key);compute({op:'binary',operator:row.update.operator==='++'?'+':'-',left:{op:'local',name},right:lit(row.operands[0][0]==='bigint'?['bigint','1']:['num',1])},write.value,event,{name});
      }else if(row.op==='carry'){
        for(const change of row.copies??[{from:row.from,to:row.to}]){
          const source=names.get(change.from.env+':'+change.from.key);
          if(!source||!controller.locals.has(source))refuse('iteration copy lacks a committed source cell');
          bind(cell(change.to.env,change.to.key),controller.locals.get(source),event);
        }
      }else if(row.op==='branch'){
        if(['then','else'].includes(row.path)){
          const decision=tag(row.test,event),expr=operand(decision,inventory.nodes.get(row.source?.start+':'+row.source?.end),event);
          if(decision[0]==='symbol')emit({kind:'choose',expr,decision,path:row.path},event,'owned-source-choice/1');
          else emit({kind:'choose',fields:{expr,decision,path:row.path}},event,'owned-source-choice/1',{detail:true});
        }else{
          const node=inventory.nodes.get(row.source?.start+':'+row.source?.end),
            optional=['MemberExpression','CallExpression'].includes(node?.type)&&node.optional===true,
            hasInstance=node?.type==='BinaryExpression'&&node.operator==='instanceof',
            instruction=bundle.programs[event.codeId]?.instructions.find(item=>item.siteId===event.siteId&&item.op==='LOGICAL_JUMP'),
            operator=optional||hasInstance?'??':node?.type==='LogicalExpression'?node.operator:
              node?.type==='AssignmentExpression'?node.operator.slice(0,-1):null;
          if(!['&&','||','??'].includes(operator))refuse('logical choice lacks its exact source operator');
          if(instruction?.arg.operator!==operator)refuse('logical choice differs from its immutable instruction');
          // This record commits before the right operand executes. Publish the
          // actual left operand and its operator, never a teacher-only decision
          // literal or a value from the future right-hand computation.
          const value=(optional||hasInstance)&&row.test[0]==='method'?row.test[1]:row.test,
            left=hasInstance?null:optional?(node.type==='MemberExpression'?node.object:node.callee):node.left;
          emit({kind:'choose',expr:{op:'logical-test',operator,arg:operand(tag(value,event),left,event)},
            decision:row.result,path:optional?(row.result[1]?'then':'else'):row.path},event,
            optional?'owned-source-optional-choice/1':'owned-source-logical-choice/1');
        }
      }else if(!['binding.read','binding.initialize','binding.write','call.return','completion.throw','control.jump','environment.iteration','binding.default.guard'].includes(event.operation))
        refuse('source operation needs its declared protocol: '+event.operation);
      if(event.operation!=='binding.update')for(const write of row.writes.filter(write=>write.kind==='cell'))bind(cell(write.env,write.key),write.value,event);
      if(event.operation==='binding.read')for(const read of row.reads.filter(read=>read.kind==='binding')){
        if(!valueTag(read.value))continue;const name=cell(read.envId,read.name);
        if(!controller.locals.has(name)){
          const initial=bundle.initialState.envs[read.envId]?.bindings?.[read.name];
          if(!initial?.initialized||!eq(initial.token?.value,read.value))refuse('read of an unprojected source cell');
          bind(name,read.value,event);
        }
        if(!eq(controller.locals.get(controller.captureAliases.get(name)??name),tag(read.value,event)))refuse('source cell read disagrees with shared live cell');
      }
    }
    // Project each completed frame once, deepest first, including propagating
    // abrupt completions; internal unwind bookkeeping is not a public target.
    const finished=event.stateChanges.filter(change=>change.table==='frames'&&change.before&&change.after&&
      !['completed','thrown'].includes(change.before.status)&&['completed','thrown'].includes(change.after.status));
    finished.sort((a,b)=>controller.stack.indexOf(frame(b.id))-controller.stack.indexOf(frame(a.id)));
    for(const change of finished){
      const completionOwner=prepared('completion:'+change.id);
      if(completionOwner.owner!==ORDINARY_PROTOCOL_SOURCE_V8){
        const adapter=adapterById.get(completionOwner.owner);
        if(adapter?.completeFrame?.(context,change,event,completionOwner.prepared)!==true)
          refuse('claimed source completion handler declined: '+completionOwner.owner);
        use(adapter);continue;
      }
      const invocation=frame(change.id),completion=change.after.completion;
      if(!completion?.value?.value)refuse('completed frame lacks a value');
      const kind=completion.type==='throw'?'throw':'return',value=tag(completion.value.value,event);
      if(invocation!==controller.stack.at(-1))refuse('owned completion does not match active public frame');
      if(controller.protocol?.callFrames.length||value[0]==='symbol')emit({kind,value,invocation},event,'owned-source-completion/1');
      else emit({kind,fields:{value}},event,'owned-source-completion/1',{detail:true});
      const pending=pendingAccessors.get(invocation);if(pending){
        emit({kind:'property.finish',id:pending.id,completion:{kind:kind==='throw'?'throw':'normal',value:kind==='throw'||pending.operation==='get'?value:pending.value}},event,'owned-source-accessor-completion/1');pendingAccessors.delete(invocation);
      }
    }
    observe('afterEvent',event,row);
    for(const change of heapChanges)if(published.has(change.id))checkNode(change.after);
    for(const change of event.stateChanges.filter(change=>change.table==='frames'&&change.after))
      for(const adapter of frameOwners.get(change.id)??[])if(adapter.checkFrame(context,change.after,event,change.id,row)!==true)refuse('extension failed its complete frame comparison: '+adapter.id);
    for(const change of event.stateChanges)if(state[change.table]){
      if(change.after===null)delete state[change.table][change.id];else if(change.after!==undefined)state[change.table][change.id]=copy(change.after);
    }
  }
  for(const event of bundle.events)transaction(()=>projectEvent(event));
  if(pendingAccessors.size||controller.stack.length)refuse('incomplete source protocol execution');
  emit({kind:'end',completion:controller.pending.kind},null,'owned-source-terminal/1');
  const outcome=ownedEffectfulOutcome(bundle);
  return {schema:'semantic-protocol-source-projection/1',source,entry:entry.functionName,inputGraph,claims,outcome,
    sourceProfile:usedAdapters.size?'protocol-source-extensions/1':'symbols-ordinary-properties/1',extensions:[...usedAdapters].sort(),protocolRecords:claims.filter(row=>row.kind==='protocol').length,
    detailedRecords:claims.filter(row=>row.kind==='detail').length};
}
