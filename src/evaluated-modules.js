// Explicit, bounded ESM module evaluation over an in-memory source graph.
// Unlike the function-only static linker, this profile executes module
// initialization in dependency order and aliases imported mutable bindings.
// It does not create module namespace exotics or invoke a native module loader.
import {parse as parseAcorn} from 'acorn';
import ts from 'typescript';
import path from 'node:path';
import {types} from 'node:util';
import {compileBoundedTypeScript} from './typescript.js';
import {createRuntime} from './runtime.js';
import {parseTraining} from './training/profile.js';
import {executeWithNativeServices} from './host/native-driver.js';
import {validateBundle} from './validation.js';
import {replayExact} from './replay.js';
import {realizeGraph} from './training/graph.js';

const namePattern=/^[A-Za-z_$][A-Za-z0-9_$]*$/;
const reject=reason=>{throw new SyntaxError('Unsupported evaluated-module/1: '+reason);};
const id=node=>node?.type==='Identifier'?node.name:null;
function validName(name){
  return typeof name==='string'&&namePattern.test(name);
}
function sourcesOf(modules){
  if(!modules||typeof modules!=='object'||Array.isArray(modules)||
     types.isProxy(modules)||![Object.prototype,null].includes(Object.getPrototypeOf(modules)))
    throw new TypeError('Evaluated module graph must be a plain data object');
  const files=Reflect.ownKeys(modules);
  if(!files.length||files.length>64)
    throw new RangeError('Evaluated module graph must contain 1-64 files');
  const sources=new Map();
  for(const file of files){
    // Do not execute a host getter or Proxy trap while collecting the guest
    // source graph. The supplied program is host-controlled *text*, never
    // executable host objects.
    const descriptor=Object.getOwnPropertyDescriptor(modules,file);
    if(typeof file!=='string'||!descriptor||!Object.hasOwn(descriptor,'value'))
      throw new TypeError('Module source entries must be string-keyed own data');
    const text=descriptor.value;
    if(!file||file==='.'||file==='..'||file.startsWith('/')||
       file.includes('\\')||file.startsWith('../')||
       /[\u0000-\u001f]/.test(file)||
       path.posix.normalize(file)!==file||typeof text!=='string'||
       text.length>65536)
      throw new TypeError('Invalid owned module path or source length');
    sources.set(file,text);
  }
  return sources;
}
function requestPath(file,specifier,sources){
  if(typeof specifier!=='string'||!specifier.startsWith('./')&&
     !specifier.startsWith('../'))
    reject('bare package or non-relative module request: '+specifier);
  const target=path.posix.normalize(path.posix.join(path.posix.dirname(file),specifier));
  if(!sources.has(target))
    reject('unresolved module request: '+file+' -> '+target);
  return target;
}
function nodeName(node){
  if(node?.type!=='Identifier')reject('module bindings must use identifiers');
  return node.name;
}
function parseModule(file,text,sources){
  const lowering=compileBoundedTypeScript(text,{path:file});
  const ast=parseAcorn(lowering.javascript,{ecmaVersion:2022,sourceType:'module'});
  const symbols=new Map(),imports=new Map(),exports=new Map(),forwards=new Map();
  const stars=[],deps=new Set(),functions=[],initializers=[];
  const addDependency=from=>deps.add(from);
  const addImport=(local,from,imported)=>{
    if(!validName(local)||!validName(imported)&&imported!=='default')
      reject('unrepresentable imported binding in '+file);
    const prior=imports.get(local);
    if(prior && (prior.module!==from||prior.name!==imported))
      reject('conflicting import '+local+' in '+file);
    if(symbols.has(local))reject('import shadows local '+local+' in '+file);
    imports.set(local,{module:from,name:imported});
    addDependency(from);
  };
  const addExport=(exported,local)=>{
    if(!validName(exported)&&exported!=='default'||!validName(local))
      reject('unrepresentable exported binding in '+file);
    if(forwards.has(exported)||exports.has(exported)&&exports.get(exported)!==local)
      reject('duplicate export '+exported+' in '+file);
    exports.set(exported,local);
  };
  const addForward=(exported,from,imported)=>{
    if(!validName(exported)&&exported!=='default'||
       !validName(imported)&&imported!=='default')
      reject('unrepresentable forwarding export in '+file);
    if(exports.has(exported)||forwards.has(exported)&&(
       forwards.get(exported).module!==from||
       forwards.get(exported).name!==imported))
      reject('conflicting forwarded export '+exported+' in '+file);
    forwards.set(exported,{module:from,name:imported});
    addDependency(from);
  };
  const addSymbol=(name,kind,node)=>{
    if(!validName(name)||name.startsWith('__traced_eval_')||
       symbols.has(name)||imports.has(name))
      reject('duplicate, reserved or invalid module binding '+name+' in '+file);
    symbols.set(name,{kind,node});
  };
  const addDeclaration=(declaration,exported=false)=>{
    if(declaration.type==='FunctionDeclaration'){
      const local=nodeName(declaration.id);
      if(declaration.generator)reject('generator module function not owned in '+file);
      addSymbol(local,'function',declaration);
      functions.push(declaration);
      if(exported)addExport(local,local);
      return local;
    }
    if(declaration.type==='VariableDeclaration'&&
       ['const','let'].includes(declaration.kind)){
      for(const item of declaration.declarations){
        const local=nodeName(item.id);
        addSymbol(local,declaration.kind,item);
        if(exported)addExport(local,local);
      }
      initializers.push({kind:'node',node:declaration});
      return null;
    }
    reject('unowned top-level declaration '+declaration.type+' in '+file);
  };
  // The original TS AST retains run-time import edges that the TypeScript
  // emitter may elide when an imported value is unused. These edges must
  // still link, instantiate and evaluate, and missing exports must fail.
  const original=ts.createSourceFile(file,text,ts.ScriptTarget.ES2022,true,
    /\.(?:mjs|cjs|js|jsx)$/.test(file)?ts.ScriptKind.JS:ts.ScriptKind.TS);
  for(const node of original.statements){
    if(ts.isImportDeclaration(node)){
      if(node.importClause?.isTypeOnly)continue;
      if(!node.moduleSpecifier||!ts.isStringLiteral(node.moduleSpecifier))
        reject('dynamic import request at module scope');
      const from=requestPath(file,node.moduleSpecifier.text,sources);
      const clause=node.importClause;
      const named=clause?.namedBindings;
      if(named&&ts.isNamespaceImport(named))
        reject('namespace import requires module namespace exotic object');
      const eligible=!!clause?.name||
        (named&&ts.isNamedImports(named)&&named.elements.some(e=>!e.isTypeOnly))||
        !clause;
      if(!eligible)continue;
      addDependency(from);
      if(clause?.name)addImport(clause.name.text,from,'default');
      if(named&&ts.isNamedImports(named))
        for(const element of named.elements){
          if(element.isTypeOnly)continue;
          addImport(element.name.text,from,
            (element.propertyName??element.name).text);
        }
    }else if(ts.isExportDeclaration(node)){
      if(node.isTypeOnly)continue;
      if(!node.moduleSpecifier)continue;
      if(!ts.isStringLiteral(node.moduleSpecifier))
        reject('dynamic forwarding export');
      const from=requestPath(file,node.moduleSpecifier.text,sources);
      const clause=node.exportClause;
      if(clause&&ts.isNamespaceExport(clause))
        reject('namespace forwarding requires an exotic object');
      const elements=clause&&ts.isNamedExports(clause)?
        clause.elements.filter(e=>!e.isTypeOnly):null;
      if(elements&&elements.length===0)continue;
      addDependency(from);
      if(elements)
        for(const e of elements)
          addForward(e.name.text,from,(e.propertyName??e.name).text);
      else if(!clause)stars.push(from);
    }
  }
  for(const node of ast.body){
    if(node.type==='ImportDeclaration'){
      const from=requestPath(file,node.source.value,sources);
      addDependency(from);
      for(const spec of node.specifiers){
        if(spec.type==='ImportNamespaceSpecifier')
          reject('namespace import requires a module namespace exotic object');
        addImport(nodeName(spec.local),from,
          spec.type==='ImportDefaultSpecifier'?'default':nodeName(spec.imported));
      }
    }else if(node.type==='FunctionDeclaration'||
             node.type==='VariableDeclaration'){
      addDeclaration(node);
    }else if(node.type==='ExportNamedDeclaration'){
      if(node.source){
        const from=requestPath(file,node.source.value,sources);
        addDependency(from);
        for(const spec of node.specifiers){
          if(spec.type!=='ExportSpecifier')
            reject('module namespace forwarded export');
          addForward(nodeName(spec.exported),from,nodeName(spec.local));
        }
      }else if(node.declaration){
        addDeclaration(node.declaration,true);
      }else{
        for(const spec of node.specifiers)
          addExport(nodeName(spec.exported),nodeName(spec.local));
      }
    }else if(node.type==='ExportAllDeclaration'){
      if(node.exported)
        reject('module namespace star export');
      const from=requestPath(file,node.source.value,sources);
      addDependency(from);stars.push(from);
    }else if(node.type==='ExportDefaultDeclaration'){
      if(node.declaration.type==='FunctionDeclaration'){
        addExport('default',addDeclaration(node.declaration,false));
      }else if(node.declaration.type==='ClassDeclaration'){
        reject('default class evaluation is not owned');
      }else{
        const local='__default_expr';
        addSymbol(local,'const',node.declaration);
        addExport('default',local);
        initializers.push({kind:'default',node:node.declaration,local});
      }
    }else if(node.type==='EmptyStatement'){
      // Separators are inert.
    }else if(['ExpressionStatement','IfStatement','WhileStatement',
             'DoWhileStatement','ForStatement','BlockStatement',
             'TryStatement','ThrowStatement'].includes(node.type)){
      initializers.push({kind:'node',node});
    }else reject('unowned module statement '+node.type+' in '+file);
  }
  for(const [exported,local] of exports)
    if(!symbols.has(local)&&!imports.has(local))
      reject('export '+exported+' references missing local '+local+' in '+file);
  // JS modules can contain a source-level import binding not referenced in
  // the emitted code; preflight all such imports without executing anything.
  return {file,text,lowering,symbols,imports,exports,forwards,
    stars:[...new Set(stars)],deps:[...deps],functions,initializers};
}
function bindingNames(pattern,out=[]){
  if(!pattern)return out;
  if(pattern.type==='Identifier')out.push(pattern.name);
  else if(pattern.type==='AssignmentPattern')bindingNames(pattern.left,out);
  else if(pattern.type==='RestElement')bindingNames(pattern.argument,out);
  else if(pattern.type==='ArrayPattern')pattern.elements.forEach(x=>bindingNames(x,out));
  else if(pattern.type==='ObjectPattern')
    pattern.properties.forEach(x=>bindingNames(x.value??x.argument,out));
  return out;
}
function rewrite(module,root,names,initialIdentifiers){
  const edits=new Map();
  function walk(node,parent=null,key=null){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){
      for(const child of node)walk(child,parent,key);
      return;
    }
    if(typeof node.type!=='string')return;
    if(node.type==='AssignmentExpression'&&
       node.left?.type==='Identifier'&&module.imports.has(node.left.name))
      reject('assignment to read-only import '+node.left.name+' in '+module.file);
    if(node.type==='UpdateExpression'&&
       node.argument?.type==='Identifier'&&module.imports.has(node.argument.name))
      reject('update of read-only import '+node.argument.name+' in '+module.file);
    if(node.type==='FunctionDeclaration'||node.type==='FunctionExpression'||
       node.type==='ArrowFunctionExpression'){
      if(node!==root&&node.id&&names.has(node.id.name))
        reject('shadowed module function '+node.id.name+' in '+module.file);
      for(const parameter of node.params??[])
        for(const name of bindingNames(parameter))
          if(names.has(name))
            reject('shadowed imported/module name '+name+' in '+module.file);
    }
    if(node.type==='CatchClause')
      for(const name of bindingNames(node.param))
        if(names.has(name))reject('shadowed catch binding '+name);
    if(node.type==='VariableDeclarator'&&
       !initialIdentifiers.has(node.id?.start))
      for(const name of bindingNames(node.id))
        if(names.has(name))
          reject('shadowed lexical binding '+name+' in '+module.file);
    if(node.type==='Identifier'){
      const replacement=names.get(node.name);
      if(!replacement)return;
      if(parent?.type==='MemberExpression'&&key==='property'&&!parent.computed)return;
      if((parent?.type==='Property'||parent?.type==='MethodDefinition')&&
         key==='key'&&!parent.computed)return;
      if(key==='label'||parent?.type==='BreakStatement'||
         parent?.type==='ContinueStatement')return;
      if(parent?.type==='Property'&&parent.shorthand&&key==='value'){
        edits.set(node.start,{end:node.end,value:node.name+': '+replacement});
        return;
      }
      if(parent?.type==='FunctionExpression'&&key==='id')return;
      if(parent?.type==='FunctionDeclaration'&&key==='id'&&node!==root.id)
        return;
      if(parent?.type==='VariableDeclarator'&&key==='id'&&
         !initialIdentifiers.has(node.start))return;
      edits.set(node.start,{end:node.end,value:replacement});
      return;
    }
    for(const [field,value] of Object.entries(node)){
      if(['start','end','loc','range','raw','regex'].includes(field))continue;
      if(Array.isArray(value)||value&&typeof value==='object'&&value.type)
        walk(value,node,field);
    }
  }
  walk(root);
  let source=module.lowering.javascript.slice(root.start,root.end);
  for(const [start,edit] of [...edits].sort((a,b)=>b[0]-a[0])){
    const left=start-root.start,right=edit.end-root.start;
    source=source.slice(0,left)+edit.value+source.slice(right);
  }
  return source;
}
export function linkEvaluatedModules({modules,entryModule,exportName='default',
  args=[],calls=null}={}){
  const sources=sourcesOf(modules);
  if(typeof entryModule!=='string'||!sources.has(entryModule))
    reject('entry module is not part of the supplied graph');
  if(!validName(exportName)&&exportName!=='default')
    reject('invalid entry export');
  if(!Array.isArray(args)||args.length>64)
    throw new TypeError('Entry invocation takes at most 64 arguments');
  // A batch is one owned episode, not a cache that replays module effects
  // across multiple host calls. Safely read descriptors before guest import.
  let sequence=null;
  if(calls!==null){
    if(!Array.isArray(calls)||types.isProxy(calls)||
       calls.length===0||calls.length>32||args.length)
      throw new TypeError('Calls must be 1-32 entries and replace single-call args');
    sequence=calls.map(call=>{
      if(!call||typeof call!=='object'||Array.isArray(call)||
         types.isProxy(call)||
         ![Object.prototype,null].includes(Object.getPrototypeOf(call)))
        throw new TypeError('Each owned module call must be a data record');
      const e=Object.getOwnPropertyDescriptor(call,'exportName');
      const a=Object.getOwnPropertyDescriptor(call,'args');
      if(!e||!Object.hasOwn(e,'value')||!validName(e.value)||
         !a||!Object.hasOwn(a,'value')||!Array.isArray(a.value)||
         a.value.length>64)
        throw new TypeError('Each module call needs exportName and up to 64 args');
      return {exportName:e.value,args:a.value};
    });
  }
  const modulesByFile=new Map(),visiting=new Set(),visited=new Set(),order=[];
  function get(file){
    if(!modulesByFile.has(file))
      modulesByFile.set(file,parseModule(file,sources.get(file),sources));
    return modulesByFile.get(file);
  }
  function visit(file){
    if(visiting.has(file))reject('cyclic initialization graph is not owned: '+file);
    if(visited.has(file))return;
    visiting.add(file);
    for(const from of get(file).deps)visit(from);
    visiting.delete(file);
    visited.add(file);order.push(file);
  }
  visit(entryModule);
  const renamed=new Map();
  for(const [index,file] of order.entries()){
    const names=new Map();
    for(const name of get(file).symbols.keys())
      names.set(name,'__traced_eval_m'+(index+1)+'_'+name);
    renamed.set(file,names);
  }
  function resolve(file,exported,trail=new Set()){
    const marker=file+'#'+exported;
    if(trail.has(marker))return null;
    const seen=new Set(trail);seen.add(marker);
    const module=get(file);
    if(module.exports.has(exported)){
      const local=module.exports.get(exported);
      if(module.symbols.has(local))
        return {file,local,linked:renamed.get(file).get(local),
          kind:module.symbols.get(local).kind};
      const binding=module.imports.get(local);
      return binding?resolve(binding.module,binding.name,seen):null;
    }
    if(module.forwards.has(exported)){
      const forward=module.forwards.get(exported);
      return resolve(forward.module,forward.name,seen);
    }
    if(exported==='default')return null;
    const matches=new Map();
    for(const from of module.stars){
      const found=resolve(from,exported,seen);
      if(found!==null)matches.set(found.file+'#'+found.local,found);
      if(matches.size>1)reject('ambiguous export * for '+exported+' in '+file);
    }
    return matches.size===1?[...matches.values()][0]:null;
  }
  function required(file,exported){
    const found=resolve(file,exported);
    if(!found)reject('unresolved export '+exported+' in '+file);
    return found;
  }
  // Every explicit indirect export participates in ESM linking even when
  // the entry never reads it. Otherwise a missing export could be hidden by
  // an unrelated successful entry evaluation.
  for(const file of order){
    for(const exported of get(file).forwards.keys())
      required(file,exported);
    for(const [exported,local] of get(file).exports)
      if(get(file).imports.has(local))
        required(file,exported);
  }
  const selected=sequence?required(entryModule,sequence[0].exportName):
    required(entryModule,exportName);
  if(!sequence&&selected.kind!=='function'&&args.length)
    reject('cannot call a non-function exported module binding');
  const requested=sequence?sequence.map(call=>{
    const binding=required(entryModule,call.exportName);
    if(binding.kind!=='function'&&call.args.length)
      reject('cannot invoke a non-function module export '+call.exportName);
    return {...call,binding};
  }):null;
  const bound=new Map(),links=[];
  for(const file of order){
    const module=get(file),names=new Map(renamed.get(file));
    for(const [local,imp] of module.imports){
      const resolved=required(imp.module,imp.name);
      names.set(local,resolved.linked);
      links.push({from:file,local,source:imp.module,exportName:imp.name,
        binding:resolved.linked,live:true});
    }
    for(const [name,forward] of module.forwards){
      const target=required(file,name);
      links.push({from:file,exportName:name,source:forward.module,
        imported:forward.name,binding:target.linked,live:true});
    }
    bound.set(file,names);
  }
  let source='"use strict";\nasync function __traced_evaluated_entry(self) {\n';
  const spans=[];
  const append=(file,kind,fragment)=>{
    const start=source.length;
    source+='  '+fragment+'\n';
    spans.push({file,kind,start,end:source.length});
  };
  // Instantiation: hoist every linked function before executing any body.
  // Imported reads share a single renamed lexical binding, not a snapshot.
  for(const file of order){
    const module=get(file),names=bound.get(file);
    for(const fn of module.functions)
      append(file,'instantiate',rewrite(module,fn,names,new Set()));
  }
  // Evaluation: side effects and mutable lexicals execute in module request
  // dependency order, once, in the *same* owned guest invocation/heap.
  for(const file of order){
    const module=get(file),names=bound.get(file);
    for(const item of module.initializers){
      if(item.kind==='default'){
        append(file,'evaluate','const '+names.get(item.local)+' = ('+
          rewrite(module,item.node,names,new Set())+');');
      }else{
        const initialIdentifiers=new Set();
        if(item.node.type==='VariableDeclaration')
          for(const declarator of item.node.declarations)
            initialIdentifiers.add(declarator.id.start);
        append(file,'evaluate',rewrite(module,item.node,names,initialIdentifiers));
      }
    }
  }
  if(requested){
    // All calls execute after initialization in a single owned activation;
    // lexical exports and heap aliases survive each intermediate await.
    requested.forEach(({binding,args:callArgs},i)=>{
      const parameters=callArgs.map((_,j)=>
        'self.calls['+i+'].args['+j+']').join(',');
      const expression=binding.kind==='function'?
        binding.linked+'('+parameters+')':binding.linked;
      source+='  const __traced_eval_result_'+i+'=await '+expression+';\n';
    });
    source+='  return ['+requested.map((_,i)=>
      '__traced_eval_result_'+i).join(',')+'];\n';
  }else if(selected.kind==='function'){
    const argumentsText=args.map((_,i)=>'self.args['+i+']').join(',');
    source+='  return await '+selected.linked+'('+argumentsText+');\n';
  }else source+='  return await '+selected.linked+';\n';
  source+='}\n';
  if(source.length>262144)
    throw new RangeError('Linked module entry exceeds bounded source limit');
  // Linking must never hand off unowned guest syntax to an assumed Node or
  // browser module loader. Validate the actual concatenated guest program,
  // including its identifier resolution, before an entry can be executed.
  try {parseTraining(source);}
  catch(error){reject('unowned generated guest syntax: '+error.message);}
  const metadata={
    profile:'evaluated-module/1',entryModule,exportName,
    evaluationOrder:order.slice(),linkedBinding:selected.linked,
    ...(requested?{calls:requested.map(({exportName,binding})=>({
      exportName,binding:binding.linked}))}:{}),
    instantiationAndEvaluation:spans,links,
    modules:order.map(file=>({
      file,source:sources.get(file),transpiler:get(file).lowering.compiler,
      sourceMap:get(file).lowering.sourceMap
    }))
  };
  return {profile:'evaluated-module/1',source,
    entryFunction:'__traced_evaluated_entry',metadata,
    entryInput:sequence?{calls:sequence.map(({args})=>({args}))}:{args}};
}
export async function executeEvaluatedModules({modules,entryModule,
  exportName='default',args=[],calls=null,services=null,maxSteps=100000,signal}={}){
  const linked=linkEvaluatedModules({modules,entryModule,exportName,args,calls});
  if(!Number.isSafeInteger(maxSteps)||maxSteps<1||maxSteps>1000000)
    throw new RangeError('Module evaluation step budget out of range');
  let bundle,runtime,progress;
  const entry={text:linked.source,
    url:'evaluated-module://'+entryModule,
    functionName:linked.entryFunction,
    args:[linked.entryInput]};
  if(services!==null){
    const executed=await executeWithNativeServices({
      entry,services,maxSteps,signal
    });
    ({bundle,runtime,progress}=executed);
  }else{
    runtime=createRuntime({maxSteps});
    const source=runtime.registerSource({text:linked.source,
      url:entry.url,trainingProfile:true});
    runtime.startEntry({source,functionName:entry.functionName,
      args:entry.args,allowAsync:true});
    progress=runtime.drive();
    bundle=JSON.parse(JSON.stringify(runtime.exportRun()));
    validateBundle(bundle);
    replayExact(bundle);
  }
  if(progress.kind!=='terminated')
    throw new TypeError('Evaluated module guest did not terminate: '+progress.kind);
  const root=runtime.initialState.control.a0.activeFrameId;
  const promiseId=runtime.initialState.frames[root]?.asyncPromiseId;
  const settled=promiseId&&runtime.state.promises[promiseId];
  if(!settled||settled.status==='pending')
    throw new TypeError('Evaluated module root promise remains unsettled');
  if(settled.status==='rejected'){
    const value=realizeGraph(runtime.state.heap,[settled.value.value])[0];
    throw new Error('Owned module evaluation rejected: '+String(
      value&&typeof value==='object'?value.message??value.name??'guest object':value));
  }
  const value=realizeGraph(runtime.state.heap,[settled.value.value])[0];
  return {result:value,bundle,metadata:linked.metadata};
}
