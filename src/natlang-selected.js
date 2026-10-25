// Guest source is published, never run with eval, Function or vm. Native
// bindings are explicit broker capabilities; guest callbacks reenter selection.
import {createHash} from 'node:crypto';
import {isPromise} from 'node:util/types';
import ts from 'typescript';
import {SelectedExecutionHarness} from './training/harness-v4.js';
import {SelectedModelDriver} from './training/model-driver.js';
import {inspectDataObject} from './training/data-graph-contract.js';
import {ownedCallbackId} from './host/materialize.js';
import {encode,decode} from './values.js';
import {isProxy} from '#owned-proxy-check';

const own=Object.hasOwn;
const sourceId=text=>'p'+createHash('sha256').update(text).digest('hex').slice(0,24);
function demand(condition,message){if(!condition)throw new TypeError(message);}
// This is public guest source. Returned native callable handles become owned
// wrapper closures through selected steps; the host never runs these bodies.
const BINDING_RESULT_SOURCE=`function __selected_unwrap(value,seen=[]){
  if(value===null||typeof value!=="object")return value;
  if(value.schema!=="natlang-native-value/1")throw new TypeError("Invalid native binding result");
  for(const pair of seen)if(pair[0]===value)return pair[1];
  if(value.kind==="callable"){
    const handle=value.handle;
    const result=value.callKind==="promise"?
      function __selected_dynamic(...args){return host.natlangCall(handle,undefined,__selected_arguments(args)).then(__selected_unwrap);}:
      function __selected_dynamicSync(...args){return __selected_unwrap(host.natlangCallSync(handle,undefined,__selected_arguments(args)));};
    Object.defineProperty(result,"__selected_native_callable",{value:handle});
    seen.push([value,result]);
    for(const property of value.properties||[])__selected_property(result,property,seen);
    return result;
  }
  const result=value.kind==="array"?new Array(value.length):value.nullPrototype?Object.create(null):{};
  seen.push([value,result]);
  if(value.kind==="resource")Object.defineProperty(result,"__selected_resource",
    {value:{schema:"natlang-native-resource/1",handle:value.handle},enumerable:false});
  for(const property of value.properties)__selected_property(result,property,seen);
  return result;
}
function __selected_property(target,property,seen){
  if(property.cell){
    const handle=property.cell.handle;
    Object.defineProperty(target,property.key,{enumerable:true,configurable:true,
      get:function __selected_dynamicGet(){return __selected_unwrap(host.natlangReadCell(handle));},
      set:property.cell.writable?function __selected_dynamicSet(value){return __selected_unwrap(host.natlangWriteCell(handle,value));}:undefined});
  }else Object.defineProperty(target,property.key,
    {value:__selected_unwrap(property.value,seen),enumerable:true,writable:true,configurable:true});
}
function __selected_argument(value,seen=[]){
  if(value===null||!['object','function'].includes(typeof value))return value;
  for(const pair of seen)if(pair[0]===value)return pair[1];
  if(typeof value==="function"){
    if(value.__selected_native_callable)return value;
    const target=value;
    const callback=async function __selected_callback(...args){
      return await target.apply(__selected_unwrap(this),args.map(item=>__selected_unwrap(item)));
    };
    seen.push([value,callback]);return callback;
  }
  if(value.__selected_resource)return {__selected_resource:value.__selected_resource};
  const result=Array.isArray(value)?new Array(value.length):{};seen.push([value,result]);
  for(const key of Object.keys(value))result[key]=__selected_argument(value[key],seen);
  return result;
}
function __selected_arguments(args){
  const seen=[];return args.map(value=>__selected_argument(value,seen));
}`;

/** Source compilation only. Dependencies become observed bindings, not native
 * guest require calls. The caller publishes the transformed and original source. */
function resolveStaticImports(source,resolve){
  const file=ts.createSourceFile('module.js',source,ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS);
  const edits=[],imports=Object.create(null),runtimeNames=new Set();
  function visit(node){
    if(ts.isPropertyAccessExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='__natlang')
      runtimeNames.add(node.name.text);
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='require'){
      demand(node.arguments.length===1&&ts.isStringLiteral(node.arguments[0]),
        'Selected module imports require an immutable literal dependency');
      const specifier=node.arguments[0].text;
      if(!own(imports,specifier))imports[specifier]=resolve(specifier);
      edits.push({start:node.getStart(file),end:node.end,text:'__imports['+JSON.stringify(specifier)+']'});
    }
    ts.forEachChild(node,visit);
  }
  visit(file);
  for(const edit of edits.sort((a,b)=>b.start-a.start))
    source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);
  return {source,imports,runtimeNames};
}

/** Migrate the compiler's immediate native helpers at their real call sites.
 * Ordinary Promise calls keep their original concurrency. Lexically resolved
 * callers of a migrated helper become async and await its value; no guest code
 * is executed while constructing this source revision. */
function migrateImmediateCalls(source){
  const fileName='/selected.js',options={allowJs:true,target:ts.ScriptTarget.ES2022,noLib:true,noResolve:true};
  const host=ts.createCompilerHost(options);
  host.getSourceFile=name=>name===fileName?ts.createSourceFile(name,source,options.target,true,ts.ScriptKind.JS):undefined;
  host.fileExists=name=>name===fileName;host.readFile=name=>name===fileName?source:undefined;
  const program=ts.createProgram([fileName],options,host),file=program.getSourceFile(fileName),checker=program.getTypeChecker();
  const functions=new Map(),aliases=new Map(),calls=[],owners=new Map(),migrated=new Set(),awaited=new Set();
  const unparen=node=>{while(ts.isParenthesizedExpression(node))node=node.expression;return node;};
  const functionLike=node=>ts.isFunctionDeclaration(node)||ts.isFunctionExpression(node)||ts.isArrowFunction(node)||ts.isMethodDeclaration(node);
  const symbol=node=>checker.getSymbolAtLocation(node);
  function scan(node,owner=null){
    if(functionLike(node)){
      owner=node;if(node.name)functions.set(symbol(node.name),node);
      if(ts.isVariableDeclaration(node.parent)||ts.isPropertyAssignment(node.parent))functions.set(symbol(node.parent.name),node);
    }
    if(ts.isVariableDeclaration(node)&&node.initializer&&ts.isIdentifier(node.name))aliases.set(symbol(node.name),node.initializer);
    if(ts.isCallExpression(node)){calls.push(node);owners.set(node,owner);}
    ts.forEachChild(node,child=>scan(child,owner));
  }
  scan(file);functions.delete(undefined);aliases.delete(undefined);
  function target(node,seen=new Set()){
    node=unparen(node);if(functionLike(node))return node;
    const key=symbol(ts.isPropertyAccessExpression(node)?node.name:node);if(!key||seen.has(key))return null;
    seen.add(key);return functions.get(key)??(aliases.has(key)?target(aliases.get(key),seen):null);
  }
  const immediate=node=>{
    node=unparen(node);return ts.isPropertyAccessExpression(node)&&ts.isIdentifier(node.expression)&&
      (['__live','__natlang'].includes(node.expression.text)&&['inline','guard','rebindInline','fuseSite','invokeWithReceiver'].includes(node.name.text)||
        node.expression.text==='nl'&&node.name.text==='__inline');
  };
  let changed=true;
  while(changed){changed=false;
    for(const call of calls){if(!immediate(call.expression)&&!migrated.has(target(call.expression)))continue;
      if(!awaited.has(call)){awaited.add(call);changed=true;}
      const owner=owners.get(call);if(owner&&!migrated.has(owner)){
        demand(!owner.asteriskToken,'Selected asynchronous helper cannot occur in a synchronous generator');
        migrated.add(owner);changed=true;
      }
    }
  }
  if(!awaited.size)return source;
  const transformed=ts.transform(file,[context=>{
    const f=context.factory;
    function visit(node){
      const original=node;node=ts.visitEachChild(node,visit,context);
      if(migrated.has(original)&&!node.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.AsyncKeyword)){
        const modifiers=[...(node.modifiers??[]),f.createModifier(ts.SyntaxKind.AsyncKeyword)];
        if(ts.isFunctionDeclaration(node))node=f.updateFunctionDeclaration(node,modifiers,node.asteriskToken,node.name,node.typeParameters,node.parameters,node.type,node.body);
        else if(ts.isFunctionExpression(node))node=f.updateFunctionExpression(node,modifiers,node.asteriskToken,node.name,node.typeParameters,node.parameters,node.type,node.body);
        else if(ts.isArrowFunction(node))node=f.updateArrowFunction(node,modifiers,node.typeParameters,node.parameters,node.type,node.equalsGreaterThanToken,node.body);
        else if(ts.isMethodDeclaration(node))node=f.updateMethodDeclaration(node,modifiers,node.asteriskToken,node.name,node.questionToken,node.typeParameters,node.parameters,node.type,node.body);
      }
      if(awaited.has(original)&&!ts.isAwaitExpression(original.parent))return f.createAwaitExpression(node);
      return node;
    }
    return node=>ts.visitNode(node,visit);
  }]);
  try{return ts.createPrinter().printFile(transformed.transformed[0]);}finally{transformed.dispose();}
}

// Only host-created objects in this WeakMap grant callable/cell authority.
const declaredBindings=new WeakMap();
let environmentSequence=0;
export function selectedCallable(invoke,{kind='promise',name='callable'}={}){
  demand(typeof invoke==='function'&&['promise','synchronous'].includes(kind),
    'A selected native callable needs a function and declared return class');
  const binding=Object.freeze(Object.create(null));
  declaredBindings.set(binding,{type:'callable',invoke,kind,name});return binding;
}
export function selectedCell(get,set=null,{name='cell'}={}){
  demand(typeof get==='function'&&(set===null||typeof set==='function'),
    'A selected live cell needs a reader and optional writer');
  const binding=Object.freeze(Object.create(null));
  declaredBindings.set(binding,{type:'cell',get,set,name});return binding;
}

export function createNatlangSelectedEnvironment({mode='fresh',select,services={},
    transpile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,
      module:ts.ModuleKind.None,isolatedModules:true,removeComments:false}}).outputText,
    capabilities=null,maxSelections=4096,sessionId='natlang'+(++environmentSequence),onClose=()=>{},
    EvalFailure=null,callKinds={},modules={},adaptValue=value=>value,resourceIdentity=()=>null,resourceCleanup=()=>null}={}){
  demand(mode==='fresh'||mode==='retained','Natlang environment needs an explicit mode');
  demand(typeof select==='function','A Megatoken selected-model adapter is required');
  demand(typeof transpile==='function','Compilation must be an explicit pure transform');
  const registry=new Map(),programGrants=new Map(),referenceMeta=new WeakMap();
  const views=new Map(),moduleRealms=new WeakMap(),active=new Set(),functionBindings=new WeakMap(),resources=new WeakMap(),consoleLogs=[];
  let nextRealm=0,nextInvocation=0,nextHandle=0,closed=false,harness;
  const check=()=>{if(closed)throw new Error('Selected Natlang environment is closed');};
  function register(binding,receiver=undefined){
    const handle='natlang:'+sessionId+':'+(++nextHandle);
    registry.set(handle,{...binding,receiver,active:true});return handle;
  }
  function granted(handle,context,type){
    check();const activation=harness.invocations.get(context.invocationId),binding=registry.get(handle);
    demand(binding?.active&&binding.type===type&&activation&&programGrants.get(activation.programId)?.has(handle),
      'Natlang binding is unknown, revoked, or owned by another program');return binding;
  }
  function callbackArguments(value,context,seen=new Map()){
    if(!value||typeof value!=='object')return value;
    if(seen.has(value))return seen.get(value);
    const resource=value.__selected_resource;
    if(resource?.schema==='natlang-native-resource/1'){
      const binding=granted(resource.handle,context,'resource');seen.set(value,binding.value);return binding.value;
    }
    const callbackId=ownedCallbackId(value);
    if(callbackId){
      const closure=harness.realms.get(context.realmId)?.heap.get(callbackId);
      const marker=closure?.properties.get('__selected_native_callable');
      if(marker?.[0]==='str'){
        const binding=granted(marker[1],context,'callable');
        const fn=binding.receiver===undefined?binding.invoke:binding.invoke.bind(binding.receiver);
        seen.set(value,fn);return fn;
      }
      demand(typeof context.invokeClosure==='function','Selected callback reentry is unavailable');
      const activation=harness.invocations.get(context.invocationId),program=harness.programs.get(activation.programId);
      const declaration=program.functions.find(item=>item.name===closure.code||'function:'+item.start===closure.code);
      const lexical=declaration&&!/^(?:async\s+)?function\b/.test(program.source.slice(declaration.start,declaration.end));
      const fn=async function(...args){check();return context.invokeClosure(callbackId,args,lexical?undefined:this);};
      seen.set(value,fn);return fn;
    }
    const {kind,prototype,descriptors}=inspectDataObject(value);
    const result=kind==='array'?[]:prototype===null?Object.create(null):{};seen.set(value,result);
    for(const [key,descriptor] of descriptors){
      if(kind==='array'&&key==='length'){result.length=descriptor.value;continue;}
      Object.defineProperty(result,key,{value:callbackArguments(descriptor.value,context,seen),
        writable:true,configurable:true,enumerable:true});
    }
    return result;
  }
  function packResult(value,context,seen=new Map()){
    if(value===null||!['object','function'].includes(typeof value))return value;
    if(seen.has(value))return seen.get(value);
    const original=value;value=adaptValue(value);const adapted=original!==value,native=resourceIdentity(value);
    const declared=declaredBindings.get(value);
    if(declared){
      demand(declared.type==='callable','A returned native cell needs a named property surface');
      const handle=register(declared);programGrants.get(harness.invocations.get(context.invocationId).programId).add(handle);
      const result={schema:'natlang-native-value/1',kind:'callable',handle,callKind:declared.kind,properties:[]};
      seen.set(value,result);return result;
    }
    if(typeof value==='function'){
      demand(!isProxy(value),'Native result function requires an explicit callable binding');
      const kind=Object.getOwnPropertyDescriptor(value,Symbol.for('natlang.native-call-kind'))?.value??
        (referenceMeta.has(value)||Object.getPrototypeOf(value)?.constructor?.name==='AsyncFunction'||
        Object.getOwnPropertyDescriptor(value,Symbol.for('natlang.callable'))?'promise':'synchronous');
      const handle=register({type:'callable',invoke:value,kind,name:value.name||'native-result'});
      programGrants.get(harness.invocations.get(context.invocationId).programId).add(handle);
      const result={schema:'natlang-native-value/1',kind:'callable',handle,callKind:kind,properties:[]};
      seen.set(value,result);
      for(const key of Object.getOwnPropertyNames(value)){
        if(['name','length','prototype','arguments','caller'].includes(key))continue;
        const property=Object.getOwnPropertyDescriptor(value,key);
        demand(own(property,'value'),'Native callable attributes require explicit cells');
        result.properties.push({key,value:packResult(property.value,context,seen)});
      }
      return result;
    }
    let kind,prototype,descriptors;
    if(referenceMeta.has(value)||adapted){
      demand(!isProxy(value)||referenceMeta.has(value),'A declared native surface must contain explicit properties');
      kind=Array.isArray(value)?'array':'object';prototype=Object.getPrototypeOf(value)===null?null:'ordinary';
      descriptors=new Map(Reflect.ownKeys(value).map(key=>[key,Object.getOwnPropertyDescriptor(value,key)]));
    }else ({kind,prototype,descriptors}=inspectDataObject(value));
    let resourceHandle;
    if(native){resourceHandle=resources.get(native);if(!resourceHandle){resourceHandle=register({type:'resource',value:native,dispose:resourceCleanup(native)});resources.set(native,resourceHandle);}
      programGrants.get(harness.invocations.get(context.invocationId).programId).add(resourceHandle);}
    const result={schema:'natlang-native-value/1',kind:native?'resource':kind,nullPrototype:prototype===null,properties:[],
      ...(native?{handle:resourceHandle}:{}),
      ...(kind==='array'?{length:descriptors.get('length').value}:{})};seen.set(value,result);
    for(const [key,descriptor] of descriptors){
      if(kind==='array'&&key==='length')continue;
      if(own(descriptor,'value'))result.properties.push({key,value:packResult(descriptor.value,context,seen)});
      else {
        const handle=register({type:'cell',get:()=>Reflect.get(value,key,value),
          set:descriptor.set?next=>Reflect.set(value,key,next,value):null,name:String(key)});
        programGrants.get(harness.invocations.get(context.invocationId).programId).add(handle);
        result.properties.push({key,cell:{handle,writable:!!descriptor.set}});
      }
    }
    return result;
  }
  const consoleServices=Object.fromEntries(['log','info','warn','error'].map(level=>['platform.console.'+level,
    ([value],context)=>{consoleLogs.push({invocationId:context.invocationId,text:typeof value==='string'?value:JSON.stringify(value)});
      return services['platform.console.'+level]?.([value],context);} ]));
  const nativeServices={...services,...consoleServices,
    'natlang.call':async([handle,receiver,args],context)=>{
      const binding=granted(handle,context,'callable');
      demand(binding.kind==='promise'&&Array.isArray(args),'Natlang asynchronous signature mismatch');
      return packResult(await Reflect.apply(binding.invoke,binding.receiver??receiver,callbackArguments(args,context)),context);
    },
    'natlang.callSync':([handle,receiver,args],context)=>{
      const binding=granted(handle,context,'callable');
      demand(binding.kind==='synchronous'&&Array.isArray(args),'Natlang synchronous signature mismatch');
      const result=Reflect.apply(binding.invoke,binding.receiver??receiver,callbackArguments(args,context));
      demand(!result||!isPromise(result)&&typeof Object.getOwnPropertyDescriptor(Object(result),'then')?.value!=='function',
        'Synchronous Natlang binding returned a Promise; declare an asynchronous binding');return packResult(result,context);
    },
    'natlang.readCell':([handle],context)=>packResult(granted(handle,context,'cell').get(),context),
    'natlang.writeCell':([handle,value],context)=>{
      const binding=granted(handle,context,'cell');
      demand(typeof binding.set==='function','Selected captured cell is read-only');binding.set(value);return packResult(value,context);
    }
  };
  harness=new SelectedExecutionHarness({sessionId,services:nativeServices,maxGenerated:maxSelections,
    prepareCallbackInput:({ownerInvocationId,realmId,args,receiver})=>{
      const context={invocationId:ownerInvocationId,realmId},seen=new Map();
      const values=args.map(value=>packResult(value,context,seen)),nativeReceiver=packResult(receiver,context,seen);
      const prepared=inputGraph(values,realmId,nativeReceiver);
      return {inputGraph:prepared.graph,receiverValue:prepared.receiverValue};
    },
    materializeCallbackResult:({invocationId,realmId,programId,value})=>{
      const program=harness.programs.get(programId);
      return nativeSnapshot(realize(value,{realmId,code:program.source,entry:program.entry,path:program.sourceMetadata?.path??'<callback>'}),
        {invocationId,realmId});
    }});
  const driver=new SelectedModelDriver({select,harness,maxSelections});
  const grants=capabilities??[...Object.keys(services),...Object.keys(consoleServices)];
  demand(Array.isArray(grants),'Selected capability grants must be explicit');

  /** Functions and accessors become declared source wrappers. No getter, proxy,
   * coercion or guest body runs while publishing the input snapshot. */
  function prepare(names,values,{trustedNamespaces=new Set()}={}){
    const seen=new Map(),patches=[],definitions=new Map(),handles=new Set(),needed=new Set(),attachments=[];
    function callable(value,path,receiver,declared=null){
      demand(!isProxy(value),'Proxy functions require an explicit native callable binding');
      const kind=declared?.kind??callKinds[path]??
        (Object.getOwnPropertyDescriptor(value,Symbol.for('natlang.native-call-kind'))?.value??
        (referenceMeta.has(value)||Object.getOwnPropertyDescriptor(value,Symbol.for('natlang.callable'))||
          Object.getPrototypeOf(value)?.constructor?.name==='AsyncFunction'?
          'promise':'synchronous'));
      let bound=functionBindings.get(value);
      if(!bound){bound=new Map();functionBindings.set(value,bound);}
      let receiverBindings=bound.get(receiver);if(!receiverBindings){receiverBindings=new Map();bound.set(receiver,receiverBindings);}
      let handle=receiverBindings.get(kind);
      if(!handle){handle=register(declared??{type:'callable',invoke:value,kind,name:path},receiver);receiverBindings.set(kind,handle);}
      handles.add(handle);const method=kind==='promise'?'natlangCall':'natlangCallSync';
      for(const operation of ['natlang.call','natlang.callSync','natlang.readCell','natlang.writeCell'])needed.add(operation);
      const name='__selected_binding_'+handle.split(':').at(-1);
      definitions.set(name,'function '+name+'(...args){const result=host.'+method+'('+JSON.stringify(handle)+',undefined,__selected_arguments(args));return '+
        (kind==='promise'?'result.then(__selected_unwrap)':'__selected_unwrap(result)')+';}');
      patches.push(path+'='+name+';');
      patches.push('Object.defineProperty('+name+',"__selected_native_callable",{value:'+JSON.stringify(handle)+'});');
      if(!declared&&!seen.has(value)){
        seen.set(value,undefined);
        for(const key of Object.getOwnPropertyNames(value)){
          if(['name','length','prototype','arguments','caller'].includes(key))continue;
          const descriptor=Object.getOwnPropertyDescriptor(value,key);
          const childPath=path+'['+JSON.stringify(key)+']';
          if(own(descriptor,'value')){
            if(typeof descriptor.value==='function')visit(descriptor.value,childPath,value);
            else {
              const index=attachments.length;attachments.push(undefined);
              attachments[index]=visit(descriptor.value,'__attachments['+index+']',value);
              patches.push('Object.defineProperty('+path+','+JSON.stringify(key)+',{value:__attachments['+index+'],enumerable:true});');
            }
          }else cell({type:'cell',get:()=>Reflect.get(value,key,value),set:null,name:childPath},childPath);
        }
      }
      return undefined;
    }
    function cell(binding,path){
      const handle=register(binding);handles.add(handle);needed.add('natlang.readCell');
      needed.add('natlang.call');needed.add('natlang.callSync');
      if(binding.set)needed.add('natlang.writeCell');
      const get='__selected_get_'+handle.split(':').at(-1),set='__selected_set_'+handle.split(':').at(-1);
      definitions.set(get,'function '+get+'(){return __selected_unwrap(host.natlangReadCell('+JSON.stringify(handle)+'));}');
      if(binding.set)definitions.set(set,'function '+set+'(value){return __selected_unwrap(host.natlangWriteCell('+JSON.stringify(handle)+',value));}');
      const split=path.lastIndexOf('[');demand(split>=0,'Live cells must be properties of an observed scope');
      patches.push('Object.defineProperty('+path.slice(0,split)+','+path.slice(split+1,-1)+
        ',{enumerable:true,configurable:true,get:'+get+(binding.set?',set:'+set:'')+'});');return undefined;
    }
    function visit(value,path,receiver){
      if(value&&(typeof value==='object'||typeof value==='function'))value=adaptValue(value);
      const binding=value&&(typeof value==='object'||typeof value==='function')?declaredBindings.get(value):null;
      if(binding)return binding.type==='cell'?cell(binding,path):callable(value,path,receiver,binding);
      if(typeof value==='function')return callable(value,path,receiver);
      if(value===null||typeof value!=='object')return value;
      if(referenceMeta.has(value))return value;
      if(seen.has(value))return seen.get(value);
      const trusted=trustedNamespaces.has(value);
      demand(trusted||!isProxy(value),'Proxy scope values require an explicit native binding');
      const prototype=Object.getPrototypeOf(value);
      demand(trusted||Array.isArray(value)||prototype===null||prototype===Object.prototype,
        'Live host resource '+path+' requires declared callable or cell bindings');
      // The regular data inspector rejects proxies; loader-issued namespaces
      // have an independently established authority and descriptor-only view.
      const result=Array.isArray(value)?[]:prototype===null?Object.create(null):{};seen.set(value,result);
      const native=resourceIdentity(value);
      if(native){let handle=resources.get(native);if(!handle){handle=register({type:'resource',value:native});resources.set(native,handle);}
        handles.add(handle);result.__selected_resource={schema:'natlang-native-resource/1',handle};
        patches.push('Object.defineProperty('+path+',"__selected_resource",{enumerable:false});');}
      for(const key of Reflect.ownKeys(value)){
        demand(typeof key==='string','Symbol-keyed live scope needs an explicit resource adapter');
        const descriptor=Object.getOwnPropertyDescriptor(value,key);
        if(Array.isArray(value)&&key==='length'){result.length=descriptor.value;continue;}
        const childPath=path+'['+JSON.stringify(key)+']';let child;
        if(!own(descriptor,'value'))child=cell({type:'cell',get:()=>Reflect.get(value,key,value),
          set:descriptor.set?next=>Reflect.set(value,key,next,value):null,name:childPath},childPath);
        else child=visit(descriptor.value,childPath,value);
        Object.defineProperty(result,key,{value:child,writable:true,configurable:true,enumerable:true});
        if(!descriptor.enumerable)patches.push('Object.defineProperty('+path+','+JSON.stringify(key)+', {enumerable:false});');
      }
      return result;
    }
    const args=values.map((value,index)=>visit(value,names[index],undefined));args.push(attachments);
    return {args,
      preamble:(definitions.size?BINDING_RESULT_SOURCE+'\n':'')+[...definitions.values()].join('\n'),
      setup:patches.join('\n'),handles,needed};
  }
  function inputGraph(args,realmId,receiver){
    const seen=new Map(),objects=[],reserved=new Set(harness.realms.get(realmId)?.heap.keys()??[]);let ordinal=0;
    function visit(value){
      if(value===null||!['object','function'].includes(typeof value))return encode(value);
      const existing=referenceMeta.get(value);
      if(existing){demand(existing.realmId===realmId,'Selected references cannot cross realms without a declared binding');
        demand(harness.realms.get(realmId)?.heap.has(existing.id),'Selected reference is no longer owned');return ['ref',existing.id];}
      if(seen.has(value))return ['ref',seen.get(value)];
      const {kind,prototype,descriptors}=inspectDataObject(value);let id;
      do{id='o'+ordinal++;}while(reserved.has(id));reserved.add(id);seen.set(value,id);
      const node={id,kind,...(prototype===null?{prototype:null}:{}),properties:[]};objects.push(node);
      for(const [key,descriptor] of descriptors)node.properties.push({key,value:visit(descriptor.value)});
      return ['ref',id];
    }
    const roots=args.map(visit),receiverValue=visit(receiver);return {graph:{roots,objects},receiverValue};
  }
  function realize(token,owner){
    if(token[0]!=='ref')return decode(token);check();
    const {realmId,code,entry,path}=owner,id=token[1],key=realmId+'/'+id;
    if(views.has(key))return views.get(key);
    const entity=()=>{check();const data=harness.realms.get(realmId)?.heap.get(id);
      demand(data,'Selected identity is no longer available');return data;};
    const data=entity();let view;
    if(data.kind==='closure'){
      demand(typeof data.code==='string','Guest closure is missing its source entry');
      view=async function(...args){return (await run({code,entry,args,path,realmId,realmPolicy:'retained',
        selectedEntry:data.code,closureId:id,receiver:this})).value;};
    }else{
      demand(['object','array'].includes(data.kind),'Behavioral selected identity requires a declared adapter');
      const target=data.kind==='array'?[]:data.prototype===null?Object.create(null):{};
      const value=property=>realize(entity().properties.get(property)??['undefined'],owner);
      view=new Proxy(target,{
        get(_target,property){if(property===Symbol.iterator&&data.kind==='array')return Array.prototype[Symbol.iterator];
          if(typeof property==='symbol')return undefined;
          if(data.kind==='array'&&!entity().properties.has(property))return Array.prototype[property];return value(property);},
        ownKeys(){const keys=[...entity().properties.keys()];if(data.kind==='array')target.length=value('length');return keys;},
        has(_target,property){return entity().properties.has(property);},
        getOwnPropertyDescriptor(_target,property){if(!entity().properties.has(property))return undefined;
          if(data.kind==='array'&&property==='length'){target.length=value('length');return Object.getOwnPropertyDescriptor(target,'length');}
          return {value:value(property),enumerable:true,writable:false,configurable:true};},
        set(){throw new TypeError('Selected guest state changes require an observed invocation');},
        defineProperty(){throw new TypeError('Selected guest state changes require an observed invocation');},
        deleteProperty(){throw new TypeError('Selected guest state changes require an observed invocation');}
      });
    }
    views.set(key,view);referenceMeta.set(view,{realmId,id});return view;
  }
  function nativeSnapshot(value,context,seen=new Map()){
    if(!value||!['object','function'].includes(typeof value))return value;
    const owned=referenceMeta.get(value),node=owned&&harness.realms.get(owned.realmId)?.heap.get(owned.id);
    if(node?.kind==='closure'){
      const handle=node.properties.get('__selected_native_callable');
      if(handle?.[0]==='str')return granted(handle[1],context,'callable').invoke;
      return value;
    }
    const resource=value.__selected_resource;
    if(resource?.schema==='natlang-native-resource/1')return granted(resource.handle,context,'resource').value;
    if(typeof value==='function')return value;
    if(seen.has(value))return seen.get(value);
    const copy=Array.isArray(value)?[]:Object.getPrototypeOf(value)===null?Object.create(null):{};seen.set(value,copy);
    for(const key of Reflect.ownKeys(value)){
      if(Array.isArray(value)&&key==='length'){copy.length=value.length;continue;}
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      demand(own(descriptor,'value'),'Callback result requires owned data properties');
      Object.defineProperty(copy,key,{value:nativeSnapshot(descriptor.value,context,seen),enumerable:true,writable:true,configurable:true});
    }
    return copy;
  }
  const run=async({code,entry,args=[],path='<natlang>',realmId=null,realmPolicy='fresh',selectedEntry=null,
      closureId=null,receiver=undefined,prepared=null,activation='call',timeoutMs,signal=null,sourceMetadata=null})=>{
    check();demand(typeof code==='string'&&code.length>0,'Natlang source must be exact JS text');
    const id=sourceId(code),realm=realmId??'realm'+(++nextRealm),invocationId='natlang'+(++nextInvocation);
    if(prepared){const held=programGrants.get(id)??new Set();for(const handle of prepared.handles)held.add(handle);programGrants.set(id,held);}
    const owned=inputGraph(args,realm,receiver),abort=new AbortController();active.add(abort);let timer;
    if(timeoutMs!==undefined){demand(Number.isFinite(timeoutMs)&&timeoutMs>=0,'Selected timeout must be a nonnegative finite duration');
      timer=setTimeout(()=>abort.abort(new Error('Selected Natlang execution timed out')),timeoutMs);}
    const combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
    const belongs=other=>{
      const seen=new Set();while(other&&!seen.has(other)){
        if(other===invocationId)return true;seen.add(other);other=harness.invocations.get(other)?.parentInvocationId;
      }return false;
    };
    const observed=()=>harness.timeline.filter(item=>belongs(item.invocationId)&&item.mode==='observed');
    const logs=()=>consoleLogs.filter(item=>belongs(item.invocationId)).map(item=>item.text);
    try{
      const result=await driver.run({programId:id,source:code,entry,
        capabilities:[...new Set([...grants,...(prepared?.needed??[])])],invocationId,trackId:'worker:'+realm,
        realmId:realm,realmPolicy,triggerId:'natlang:'+invocationId,inputGraph:owned.graph,args:[],
        receiverValue:owned.receiverValue,selectedEntry,closureId,activation,
        completionPolicy:'await-returned-promise',signal:combined,sourceMetadata,module:activation==='module-init'});
      check();const observations=observed();
      if(result.completion.kind==='throw'){
        const thrown=realize(result.completion.value,{realmId:realm,code,entry,path});
        const error=new Error('Selected Natlang execution threw: '+String(thrown));
        error.events=observations.map(item=>({operation:'selected.observation',...item}));throw error;
      }
      return {value:realize(result.completion.value,{realmId:realm,code,entry,path}),observations,logs:logs(),
        trace:result.rendered,invocationId};
    }catch(error){
      const failure=error instanceof Error&&Object.isExtensible(error)?error:new Error(String(error));
      failure.events??=observed().map(item=>({...item,operation:'selected.observation'}));
      failure.debug={...failure.debug,logs:logs(),sourceStack:failure.stack};
      if(EvalFailure&&!(failure instanceof EvalFailure))throw new EvalFailure(failure.message,failure.events,failure.debug);
      throw failure;
    }
    finally{clearTimeout(timer);active.delete(abort);}
  };
  return {
    authority:'selected-semantic/4',mode,scopeCapabilities:{allowModules:true,allowNetwork:false},
    execute(){throw new Error('Selected semantic evaluation is asynchronous; use executeAsync');},
    async executeAsync(request){
      check();demand(request&&typeof request.code==='string'&&typeof request.path==='string',
        'Natlang selected entry needs exact code and source path');
      const translated=transpile(request.body?request.code:'('+request.code+')',{path:request.path,body:request.body});
      demand(typeof translated==='string','Selected source compiler returned nontext');
      const live={...request.live};
      for(const name of ['inline','guard','rebindInline','fuseSite','invokeWithReceiver'])if(typeof live[name]==='function')
        live[name]=selectedCallable(live[name],{kind:'promise',name});
      const prepared=prepare(['self','__live'],[request.scope??{},live]);
      const expression=translated.trim().replace(/;\s*$/,'');
      const code=migrateImmediateCalls(prepared.preamble+'\nasync function run(self,__live,__attachments){\n'+prepared.setup+'\n'+
        (request.body?translated:'return ('+expression+');')+'\n}');
      const response=await run({code,entry:'run',args:prepared.args,prepared,path:request.path,
        timeoutMs:request.timeoutMs,signal:request.signal,sourceMetadata:{path:request.path,originalSource:request.code}});
      return {result:response.value,events:response.observations.map(item=>({...item,operation:'selected.observation'})),logs:response.logs};
    },
    evaluateModule(){throw new Error('Selected module initialization requires evaluateModuleAsync');},
    async evaluateModuleAsync(compiled,bindings){
      check();demand(typeof compiled==='string'&&bindings&&typeof bindings==='object'&&bindings.module,
        'Natlang module requires compiled source/bindings');
      demand(!moduleRealms.has(bindings.module),'Module was already initialized in this selected realm');
      const trustedNamespaces=new Set();
      const resolved=resolveStaticImports(compiled,specifier=>{
        let value;if(own(modules,specifier))value=modules[specifier];else{
          demand((specifier.startsWith('./')||specifier.startsWith('natlang:')||specifier.startsWith('@natlang/'))&&
            typeof bindings.require==='function','Selected package imports need a declared native module binding');
          value=bindings.require(specifier);
        }
        if(value&&typeof value==='object')trustedNamespaces.add(value);return value;
      });
      const runtime={};for(const name of resolved.runtimeNames){
        const value=bindings.__natlang?.[name];demand(value!==undefined,'Missing declared Natlang runtime binding '+name);
        runtime[name]=['guard','inline','rebindInline','fuseSite','invokeWithReceiver'].includes(name)?selectedCallable(value,{kind:'promise',name}):value;
      }
      const exportsValue={},moduleValue={exports:exportsValue};
      const nl={__inline:selectedCallable(bindings.__natlang?.inline??bindings.nl?.__inline??(()=>{throw new Error('Missing inline binding');}),{kind:'promise',name:'nl.__inline'})};
      const prepared=prepare(['exports','module','__imports','__natlang','nl'],
        [exportsValue,moduleValue,resolved.imports,runtime,nl],{trustedNamespaces});
      const code=migrateImmediateCalls(prepared.preamble+'\nasync function initialize(exports,module,__imports,__natlang,nl,__attachments){\n'+
        'const __natlang_context=undefined;\n'+prepared.setup+'\n'+resolved.source+'\nreturn module.exports;\n}');
      const realmId='module'+(++nextRealm);moduleRealms.set(bindings.module,{realmId,status:'initializing'});
      try{
        const response=await run({code,entry:'initialize',args:prepared.args,prepared,realmId,realmPolicy:'retained',
          activation:'module-init',path:bindings.__natlang_module?.source??'<natlang-module>',sourceMetadata:bindings.__natlang_module??null});
        demand(response.value&&typeof response.value==='object','Selected module initialization must return an owned export object');
        for(const key of Reflect.ownKeys(response.value))Object.defineProperty(bindings.exports,key,{
          get:()=>response.value[key],enumerable:true,configurable:true});
        referenceMeta.set(bindings.exports,referenceMeta.get(response.value));
        bindings.module.exports=bindings.exports;
        moduleRealms.set(bindings.module,{realmId,status:'initialized',sourceId:sourceId(code)});return bindings.exports;
      }catch(error){moduleRealms.set(bindings.module,{realmId,status:'failed'});throw error;}
    },
    fork(){check();return createNatlangSelectedEnvironment({mode:'fresh',select,services,transpile,capabilities:grants,
      maxSelections,sessionId:sessionId+'f'+(++nextRealm),onClose,EvalFailure,callKinds,modules,adaptValue,resourceIdentity,resourceCleanup});},
    configureNativeBindings(configuration){
      check();demand(typeof configuration?.adaptValue==='function','Native value adaptation requires a declared host adapter');
      demand(!nextInvocation,'Native adapters must be installed before the first selected invocation');adaptValue=configuration.adaptValue;
      resourceIdentity=configuration.resourceIdentity??resourceIdentity;
      resourceCleanup=configuration.resourceCleanup??resourceCleanup;
    },
    close(){if(closed)return;closed=true;for(const controller of active)controller.abort(new Error('Selected Natlang environment closed'));
      const errors=[];for(const binding of registry.values()){
        binding.active=false;try{binding.dispose?.();}catch(error){errors.push(error);}
      }
      registry.clear();programGrants.clear();views.clear();
      driver.close({closeSelector:false});try{onClose();}catch(error){errors.push(error);}
      if(errors.length)throw new AggregateError(errors,'Selected native resource cleanup failed');},
    selectedHarness(){return harness;},selectedDriver(){return driver;}
  };
}
