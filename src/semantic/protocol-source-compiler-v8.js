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
import {ownedEffectfulOutcome} from '../training/effectful-compiler.js';
import {encodeWitness} from '../training/format.js';
import {encodeDetailedRecord} from './detailed-v7.js';
import {RegionExecutionHarness} from './region-harness.js';
import {encodeProtocolRecordV8,validateProtocolValueV8} from './protocol-codec-v8.js';
import {PROTOCOL_SOURCE_ADAPTERS_V8} from './protocol-source-extensions-v8.js';
import {applyProtocolRecordV8,describeProtocolObjectV8,assertProtocolDetailCompatible} from './protocol-state-v8.js';

const copy=structuredClone,eq=isDeepStrictEqual,lit=value=>({op:'literal',value:copy(value)});
function refuse(message){const error=new TypeError('Protocol source projection: '+message);error.category='unsupported.protocol-source';throw error;}
const valueTag=value=>Array.isArray(value)&&['undefined','null','bool','str','num','bigint','ref','symbol'].includes(value[0]);
const ordinaryFields=new Set(['id','kind','properties','propertyVersions','shapeVersion','version','propertyOrder','prototype','accessors','dataAttributes','extensible']);
const functionFields=new Set([...ordinaryFields,'codeId','closureEnvId','async','arrow','lexicalThis','nonConstructible']);
const symbolFields=new Set(['id','kind','description','registeredKey','properties','propertyVersions','shapeVersion','version']);
const frameFields=new Set(['id','codeId','pc','stack','envId','callerFrameId','asyncPromiseId','status','blockedOn','awaiting','operationId','pendingCoercionThrow','handlers','loops','thisValue','version','pendingProperty','completion']);
function guardHeap(node,{extraFields=[],allowUnknown=false,allowFunctionMetadata=false}={}){
  const fields=node.kind==='symbol'?symbolFields:node.kind==='function'?functionFields:
    ['object','array'].includes(node.kind)?ordinaryFields:null;
  const allowed=fields?new Set([...fields,...extraFields]):allowUnknown?new Set(['id','kind','version',...extraFields]):null;
  if(!allowed||Object.keys(node).some(key=>!allowed.has(key)))refuse('heap kind or metadata needs a declared protocol: '+node.kind);
  if(node.nonConstructible===true&&!node.arrow&&!allowFunctionMetadata)refuse('method construction capability requires explicit function metadata');
  if(node.kind==='function'&&node.async)refuse('async function state needs the scheduler protocol');
}
function prototype(node){const p=node.prototype;
  if(p===undefined||['Object.prototype','Array.prototype','Function.prototype'].includes(p))return 'ordinary';
  if(p===null)return null;if(typeof p==='string')return ['ref',p];
  refuse('unrecognized owned prototype representation');
}
function descriptor(node,key){
  const accessor=node.accessors?.[key];
  if(accessor)return {kind:'accessor',get:copy(accessor.get?.value??['undefined']),set:copy(accessor.set?.value??['undefined']),
    enumerable:accessor.enumerable,configurable:accessor.configurable};
  const value=node.properties?.[key]?.value;if(!value)return null;
  return {kind:'data',value:copy(value),...(node.kind==='array'&&key==='length'?
    {writable:true,enumerable:false,configurable:false}:{writable:true,enumerable:true,configurable:true}),...copy(node.dataAttributes?.[key]??{})};
}
function orderedKeys(node){
  const keys=[...new Set([...(node.propertyOrder??[]),...Object.keys(node.properties??{}),...Object.keys(node.accessors??{})])]
    .filter(key=>descriptor(node,key)!==null);
  const integer=key=>/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)<4294967295;
  return [...keys.filter(integer).sort((a,b)=>Number(a)-Number(b)),
    ...keys.filter(key=>!integer(key)&&propertyKeyValue(key)[0]==='str'),...keys.filter(key=>propertyKeyValue(key)[0]==='symbol')];
}
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
  }visit(node.body);return names;
}
export function compileProtocolSourceV8(bundle,{maxGenerated=16384,adapters=PROTOCOL_SOURCE_ADAPTERS_V8}={}){
  if(validateBundle(bundle).valid!==true||replayExact(bundle).valid!==true)refuse('invalid owned archive');
  const entry=bundle.entrySpec;if(entry?.kind!=='function')refuse('explicit function entry required');
  const source=bundle.sources.find(row=>row.sourceId===entry.sourceId)?.text;
  adapters=adapters.map(adapter=>typeof adapter==='function'?adapter({bundle,source}):adapter).filter(Boolean);
  if(adapters.some(adapter=>typeof adapter.id!=='string'||!adapter.id||adapter.id.length>128)||
    new Set(adapters.map(adapter=>adapter.id)).size!==adapters.length)refuse('distinct versioned extension identities required');
  const usedAdapters=new Set(),heapOwners=new Map(),frameOwners=new Map();
  const use=adapter=>{if(typeof adapter.id!=='string'||!adapter.id)refuse('extension requires a stable profile identity');usedAdapters.add(adapter.id);};
  function extension(method,...args){for(const adapter of adapters){const result=adapter[method]?.(...args);
    if(result!==undefined&&result!==null&&result!==false){use(adapter);return result;}}return null;}
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
  harness.publishProgram({programId:'program1',source,entry:entry.functionName,capabilities:[]});
  harness.admitInvocation({programId:'program1',invocationId:'invocation1',trackId:'worker1',realmId:'realm1',
    triggerId:'protocol-entry',inputGraph,realmPolicy:'fresh',completionPolicy:'call-return'});
  const controller=harness.controller,claims=[],state=copy(bundle.initialState),names=new Map(),used=new Set(),frames=new Map([[semantic.rootInvocation,'invocation1']]),
    functionCodes=new Map(),functionNodes=new Map(),pendingAccessors=new Map(),published=new Set(controller.heap.keys()),publishing=new Set();
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
  function emit(record,event=null,rule='owned-protocol-transition/1',{detail=false}={}){
    if(claims.length>=maxGenerated)throw new RangeError('Protocol source record bound');
    if(detail){assertProtocolDetailCompatible(controller,record);controller.commit(encodeWitness(record.kind,record.fields),{mode:'generated',track:'worker1'});
      if(controller.firstWitnessViolation)refuse('incorrect selected primitive claim');}
    else applyProtocolRecordV8(controller,record);
    const source=event?bundle.sites.find(site=>site.siteId===event.siteId):null;
    claims.push({kind:detail?'detail':'protocol',record:copy(record),line:detail?encodeDetailedRecord(record,{role:'generated'}):encodeProtocolRecordV8(record),
      certificate:{rule,journalEvents:event?[event.eventId]:[],source:source?{start:source.start,end:source.end}:null}});
  }
  function tag(value,event=null){if(!valueTag(value))refuse('value requires an explicit callable/protocol interface: '+JSON.stringify(value));
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
    guardedHeap(node);if(extension('allocate',context,node,event)){published.add(node.id);return;}return baseAllocate(node,event);
  }
  function baseAllocate(node,event){
    guardedHeap(node);if(published.has(node.id))return;if(publishing.has(node.id))refuse('recursive unpublished closure capture');publishing.add(node.id);
    if(node.kind==='symbol'){
      emit(node.registeredKey===undefined?{kind:'symbol.create',id:node.id,description:copy(node.description)}:
        {kind:'symbol.for',id:node.id,key:node.registeredKey},event,'owned-source-symbol/1');published.add(node.id);publishing.delete(node.id);return;
    }
    const captures=[];
    if(node.kind==='function'){
      const wanted=referencedNames(functionNodes.get(node.codeId)),seen=new Set();
      for(let env=node.closureEnvId;env;env=state.envs[env]?.parent)for(const [name,binding]of Object.entries(state.envs[env]?.bindings??{})){
        if(!wanted.has(name)||seen.has(name))continue;seen.add(name);
        if(!binding.initialized)refuse('closure capture requires an initialized owned cell');
        if(!valueTag(binding.token?.value))continue; // Immutable builtins remain source operations, never fake closures.
        const nameOfCell=cell(env,name);if(!controller.locals.has(nameOfCell))bind(nameOfCell,binding.token.value,event);
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
    for(const key of orderedKeys(node))if(node.accessors?.[key]||node.dataAttributes?.[key])emit({kind:'property.define',object:node.id,key:propertyKeyValue(key),descriptor:descriptor(node,key),success:true},event);
    if(node.extensible===false)emit({kind:'property.preventExtensions',object:node.id},event);
  }
  function resolve(name,frameId){for(let env=state.frames[frameId]?.envId;env;env=state.envs[env]?.parent)
    if(Object.hasOwn(state.envs[env]?.bindings??{},name)){const selected=names.get(env+':'+name);return selected&&controller.locals.has(controller.captureAliases.get(selected)??selected)?selected:null;}return null;}
  function operand(value,node,event){
    value=tag(value,event);const name=node?.type==='Identifier'?resolve(node.name,event.invocationId):null;
    return name&&eq(controller.locals.get(controller.captureAliases.get(name)??name),value)?{op:'local',name}:lit(value);
  }
  function compute(expr,result,event,{name=null}={}){
    result=tag(result,event);let hasSymbol=false;const inspect=value=>{if(!value||typeof value!=='object')return;if(Array.isArray(value)&&value[0]==='symbol'||value.op==='local'&&controller.locals.get(controller.captureAliases.get(value.name)??value.name)?.[0]==='symbol')hasSymbol=true;for(const item of Object.values(value))inspect(item);};inspect(expr);
    if(!hasSymbol&&result[0]!=='symbol'&&!(expr.op==='unary'&&expr.operator==='typeof'&&expr.arg.value?.[0]==='ref')){
      emit({kind:'compute',fields:{expr,result}},event,'owned-source-computation/1',{detail:true});if(name!==null)bind(name,result,event);
    }else emit({kind:'compute',expr,result,bind:name},event,'owned-source-computation/1');
  }
  function key(value){if(value?.[0]==='symbol')return copy(value);if(!['undefined','null','str','num','bool','bigint'].includes(value?.[0]))refuse('observable ToPropertyKey requires a coercion protocol');return ['str',String(decode(value))];}
  function checkNode(node){guardedHeap(node);
    for(const adapter of heapOwners.get(node.id)??[])if(adapter.checkHeap(context,node)!==true)refuse('extension failed its complete heap comparison: '+adapter.id);
    if(!['object','array','function','symbol'].includes(node.kind))return;
    return baseCheckHeap(node);
  }
  function baseCheckHeap(node){if(node.kind==='symbol'){
      const row=controller.protocol?.symbols.find(row=>row.id===node.id);if(!row||!eq(row.description,node.description)||
        (node.registeredKey===undefined?row.kind!=='unique':row.kind!=='registry'||row.key!==node.registeredKey))refuse('Symbol declaration differs from owned identity');return;}
    const expected={kind:node.kind==='function'?'closure':node.kind,prototype:prototype(node),extensible:node.extensible!==false,
      properties:orderedKeys(node).map(key=>({key:propertyKeyValue(key),descriptor:descriptor(node,key)})),
      ...(node.kind==='function'?{code:codeFor(node),functionKind:node.arrow?'arrow':'ordinary',lexicalReceiver:node.arrow?node.lexicalThis:null}:{})};
    if(!eq(expected,describeProtocolObjectV8(controller,node.id)))refuse('shared descriptor/heap state differs after owned transition '+node.id);
  }
  function builtin(event,row,changes){
    const raw=row.operands[0],callee=raw?.[0]==='method'?raw[1]:raw,args=row.operands.slice(1),name=callee?.[0]==='intrinsic'?callee[1]:callee?.[0]==='builtinfn'?callee[1]:null;
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
    if(['Reflect.ownKeys','Object.keys','Object.getOwnPropertyNames','Object.getOwnPropertySymbols'].includes(name)){
      if(args[0]?.[0]!=='ref'||row.result?.[0]!=='ref')refuse('key enumeration requires an ordinary object');
      const allocation=changes.find(change=>change.before===null&&change.id===row.result[1]);if(!allocation)refuse('key list allocation missing');
      const mode={'Reflect.ownKeys':'own','Object.keys':'enumerable-strings','Object.getOwnPropertyNames':'strings','Object.getOwnPropertySymbols':'symbols'}[name];
      const keys=Array.from({length:allocation.after.properties.length.value[1]},(_,index)=>allocation.after.properties[index].value);
      emit({kind:'property.keys',object:args[0][1],mode,name:row.result[1],keys},event,'owned-source-key-enumeration/1');published.add(row.result[1]);return;
    }
    if(name==='Object.defineProperty'){
      if(args[0]?.[0]!=='ref'||args[2]?.[0]!=='ref')refuse('ordinary descriptor arguments required');
      const object=args[0][1],encoded=key(args[1]),storage=encoded[0]==='str'?stringPropertyKey(encoded[1]):symbolPropertyKey(encoded[1]);
      const target=changes.find(change=>change.id===object)?.after??state.heap[object];
      const described=descriptor(target,storage);if(!described)refuse('defined property missing');
      emit({kind:'property.define',object,key:encoded,descriptor:described,success:true},event,'owned-source-descriptor/1');return;
    }
    if(name==='Object.setPrototypeOf'){
      if(args[0]?.[0]!=='ref'||!['null','ref'].includes(args[1]?.[0]))refuse('ordinary prototype operands required');
      emit({kind:'property.prototype',object:args[0][1],prototype:args[1][0]==='null'?null:tag(args[1],event),success:true},event);return;
    }
    if(name==='Object.create'){
      const allocation=changes.find(change=>change.before===null&&change.id===row.result?.[1]);
      if(!allocation||args.length>1)refuse('Object.create with descriptor conversion needs its protocol');publish(allocation.after,event);return;
    }
    refuse('builtin call needs a declared protocol operation: '+name);
  }
  const context={bundle,source,inventory,state,beforeState:state,controller,claims,
    emit,bind,tag,cell,frame,codeFor,publish,baseAllocate,baseCheckHeap,
    functionCodes,functionNodes,published,pendingAccessors,
    key,descriptor,prototype,orderedKeys,refuse,copy,eq,
    markPublished(id){published.add(id);},
    get publicInvocation(){return controller.stack.at(-1);},
    getOwnedFrame(id){return state.frames[id];},
    extensionState:new Map()};
  for(const adapter of adapters)adapter.setup?.(context);
  const entryEnv=state.frames[semantic.rootInvocation].envId;
  for(const [name,binding]of Object.entries(state.envs[entryEnv]?.bindings??{}))if(binding.initialized)bind(cell(entryEnv,name),binding.token.value);
  for(const event of bundle.events){
    const row=rows.get(event.eventId),heapChanges=event.stateChanges.filter(change=>change.table==='heap');
    for(const change of heapChanges)if(change.after)guardedHeap(change.after);else refuse('heap deletion needs a protocol');
    for(const change of event.stateChanges)if(change.table==='frames'&&change.after){
      const owners=adapters.filter(adapter=>adapter.frameFields?.(change.after)!=null),allowed=new Set(frameFields);
      for(const adapter of owners){const fields=adapter.frameFields(change.after);if(!Array.isArray(fields)||typeof adapter.checkFrame!=='function')refuse('frame extension requires fields and state checking');
        fields.forEach(key=>allowed.add(key));use(adapter);}
      if(owners.length)frameOwners.set(change.id,owners);
      if(Object.keys(change.after).some(key=>!allowed.has(key))||
        !owners.length&&(change.after.asyncPromiseId||change.after.awaiting||change.after.handlers?.length))refuse('frame continuation needs its declared protocol');
    }
    const handled=extension('event',context,event,row);
    if(!row&&!handled&&heapChanges.length)refuse('unprojected owned heap transition: '+event.operation);
    if(row&&!handled){
      if(row.child){
        if(!['property.read','property.write','call.enter'].includes(event.operation))refuse('implicit callback dispatch needs its declared protocol');
        for(const change of heapChanges.filter(change=>change.before===null))publish(change.after,event);
        const child=frame(row.child);
        if(event.operation==='property.read'||event.operation==='property.write'){
          if(row.operands[0]?.[0]!=='ref')refuse('accessor receiver must be an owned ordinary object');
          const operation=event.operation==='property.read'?'get':'set',id='access'+(++accessorCounter);
          emit({kind:'property.'+operation+'.call',id,child,object:row.operands[0][1],key:key(row.operands[1]),
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
      else if(row.allocations?.length)for(const allocation of row.allocations){const node=heapChanges.find(change=>change.id===allocation.identity)?.after;if(!node)refuse('allocation patch missing');publish(node,event);}
      else if(event.operation==='property.read'){
        const [base,property]=row.operands;
        if(base?.[0]==='ref')emit({kind:'property.get',object:base[1],key:key(property),receiver:tag(base,event),
          result:tag(row.result?.[0]==='method'?row.result[1]:row.result,event)},event,'owned-source-property-read/1');
        else if(base?.[0]==='symbol'&&property?.[0]==='str'&&property[1]==='description')
          emit({kind:'symbol.read',symbol:tag(base,event),operation:'description',result:tag(row.result,event),bind:null},event);
        else if(!['intrinsic','symbol'].includes(base?.[0])||!['method','builtinfn','symbol'].includes(row.result?.[0]))
          refuse('primitive/intrinsic property needs its own protocol');
      }else if(event.operation==='property.write'){
        if(row.operands[0]?.[0]!=='ref')refuse('ordinary write receiver required');
        emit({kind:'property.set',object:row.operands[0][1],key:key(row.operands[1]),receiver:tag(row.operands[0],event),value:tag(row.operands[2],event),success:true},event,'owned-source-property-write/1');
      }else if(row.arithmetic){
        const node=inventory.nodes.get(row.source?.start+':'+row.source?.end);
        compute({op:'binary',operator:row.arithmetic.operator,left:operand(row.operands[0],node?.left,event),right:operand(row.operands[1],node?.right,event)},row.result,event);
      }else if(event.operation==='primitive.binary'){
        const node=inventory.nodes.get(row.source?.start+':'+row.source?.end);if(!node?.operator)refuse('binary source operator missing');
        compute({op:'binary',operator:node.operator,left:operand(row.operands[0],node.left,event),right:operand(row.operands[1],node.right,event)},row.result,event);
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
        }else emit({kind:'choose',expr:lit(row.result),decision:row.result,path:row.path},event,'owned-source-logical-choice/1');
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
        if(!eq(controller.locals.get(controller.captureAliases.get(name)??name),read.value))refuse('source cell read disagrees with shared live cell');
      }
    }
    // Project each completed frame once, deepest first, including propagating
    // abrupt completions; internal unwind bookkeeping is not a public target.
    const finished=event.stateChanges.filter(change=>change.table==='frames'&&change.before&&change.after&&
      !['completed','thrown'].includes(change.before.status)&&['completed','thrown'].includes(change.after.status));
    finished.sort((a,b)=>controller.stack.indexOf(frame(b.id))-controller.stack.indexOf(frame(a.id)));
    for(const change of finished){
      if(extension('completeFrame',context,change,event))continue;
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
    for(const change of heapChanges)if(published.has(change.id))checkNode(change.after);
    for(const change of event.stateChanges.filter(change=>change.table==='frames'&&change.after))
      for(const adapter of frameOwners.get(change.id)??[])if(adapter.checkFrame(context,change.after,event)!==true)refuse('extension failed its complete frame comparison: '+adapter.id);
    for(const change of event.stateChanges)if(state[change.table]){
      if(change.after===null)delete state[change.table][change.id];else if(change.after!==undefined)state[change.table][change.id]=copy(change.after);
    }
  }
  if(pendingAccessors.size||controller.stack.length)refuse('incomplete source protocol execution');
  emit({kind:'end',completion:controller.pending.kind},null,'owned-source-terminal/1');
  const outcome=ownedEffectfulOutcome(bundle);
  return {schema:'semantic-protocol-source-projection/1',source,entry:entry.functionName,inputGraph,claims,outcome,
    sourceProfile:usedAdapters.size?'protocol-source-extensions/1':'symbols-ordinary-properties/1',extensions:[...usedAdapters].sort(),protocolRecords:claims.filter(row=>row.kind==='protocol').length,
    detailedRecords:claims.filter(row=>row.kind==='detail').length};
}
