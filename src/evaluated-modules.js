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
import {parseTraining,parseOwnedScript} from './training/profile.js';
import {executeWithNativeServices} from './host/native-driver.js';
import {validateBundle} from './validation.js';
import {replayExact} from './replay.js';
import {realizeGraph} from './training/graph.js';
import {hasTopLevelAwait,lowerModuleAwaits,ownedModuleSchedulerSource} from './evaluated-module-scheduler.js';
import {moduleBindingIdentifiers} from './evaluated-module-bindings.js';

const namePattern=/^[A-Za-z_$][A-Za-z0-9_$]*$/;
// ResolveExport distinguishes a missing name/circular path from ambiguity.
// Namespace objects omit either, but named imports must reject both. Never
// collapse ambiguity to null: a later star path must not supply that name.
const ambiguousExport=Symbol('ambiguous module export');
const namespaceExport=Symbol('namespace module export');
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
function exportNameOf(node){
  if(node?.type==='Literal'&&typeof node.value==='string')return node.value;
  return nodeName(node);
}
function ownDataArray(value,label,max){
  if(!Array.isArray(value)||types.isProxy(value)||
     Object.getPrototypeOf(value)!==Array.prototype||
     value.length>max)
    throw new TypeError(label+' must be a bounded ordinary data array');
  const result=[];
  for(let i=0;i<value.length;i++){
    const entry=Object.getOwnPropertyDescriptor(value,String(i));
    if(!entry||!Object.hasOwn(entry,'value'))
      throw new TypeError(label+' must have dense own data elements');
    result.push(entry.value);
  }
  if(Reflect.ownKeys(value).length!==result.length+1)
    throw new TypeError(label+' must not contain extra host array properties');
  return result;
}
function parseModule(file,text,sources){
  const lowering=compileBoundedTypeScript(text,{path:file});
  const ast=parseAcorn(lowering.javascript,{ecmaVersion:2022,sourceType:'module',allowHashBang:true});
  const symbols=new Map(),imports=new Map(),namespaceImports=new Map(),exports=new Map(),forwards=new Map();
  const stars=[],deps=new Set(),functions=[],initializers=[];
  const addDependency=from=>deps.add(from);
  const addImport=(local,from,imported)=>{
    if(!validName(local)||typeof imported!=='string')
      reject('unrepresentable imported binding in '+file);
    const prior=imports.get(local);
    if(prior && (prior.module!==from||prior.name!==imported))
      reject('conflicting import '+local+' in '+file);
    if(symbols.has(local))reject('import shadows local '+local+' in '+file);
    imports.set(local,{module:from,name:imported});
    addDependency(from);
  };
  const addNamespace=(local,from)=>{
    if(namespaceImports.get(local)===from)return;
    if(!validName(local)||symbols.has(local)||imports.has(local)||
       namespaceImports.has(local)||local.startsWith('__traced_eval_'))
      reject('duplicate or reserved namespace import '+local+' in '+file);
    namespaceImports.set(local,from);addDependency(from);
  };
  const addExport=(exported,local)=>{
    if(typeof exported!=='string'||!validName(local))
      reject('unrepresentable exported binding in '+file);
    if(forwards.has(exported)||exports.has(exported)&&exports.get(exported)!==local)
      reject('duplicate export '+exported+' in '+file);
    exports.set(exported,local);
  };
  const addForward=(exported,from,imported)=>{
    if(typeof exported!=='string'||
       imported!==namespaceExport&&typeof imported!=='string')
      reject('unrepresentable forwarding export in '+file);
    if(exports.has(exported)||forwards.has(exported)&&(
       forwards.get(exported).module!==from||
       forwards.get(exported).name!==imported))
      reject('conflicting forwarded export '+exported+' in '+file);
    forwards.set(exported,{module:from,name:imported});
    addDependency(from);
  };
  const addSymbol=(name,kind,node)=>{
    if(kind==='var'&&symbols.get(name)?.kind==='var')return;
    if(!validName(name)||name.startsWith('__traced_eval_')||
       symbols.has(name)||imports.has(name)||namespaceImports.has(name))
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
       ['const','let','var'].includes(declaration.kind)){
      for(const item of declaration.declarations){
        const local=nodeName(item.id);
        // A const initialized by a guest function expression/arrow is a
        // callable export, but it is initialized during module evaluation,
        // not hoisted like a FunctionDeclaration. Mutable let exports remain
        // live data bindings and must not be mistaken for a stable callable.
        const callable=declaration.kind==='const'&&
          (item.init?.type==='ArrowFunctionExpression'||
           item.init?.type==='FunctionExpression'&&!item.init.generator);
        addSymbol(local,callable?'function':declaration.kind,item);
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
        addNamespace(named.name.text,from);
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
      if(clause&&ts.isNamespaceExport(clause)){
        addForward(clause.name.text,from,namespaceExport);
        continue;
      }
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
        if(spec.type==='ImportNamespaceSpecifier'){
          addNamespace(nodeName(spec.local),from);
          continue;
        }
        addImport(nodeName(spec.local),from,
          spec.type==='ImportDefaultSpecifier'?'default':exportNameOf(spec.imported));
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
          addForward(exportNameOf(spec.exported),from,exportNameOf(spec.local));
        }
      }else if(node.declaration){
        addDeclaration(node.declaration,true);
      }else{
        for(const spec of node.specifiers)
          addExport(exportNameOf(spec.exported),nodeName(spec.local));
      }
    }else if(node.type==='ExportAllDeclaration'){
      const from=requestPath(file,node.source.value,sources);
      if(node.exported)addForward(exportNameOf(node.exported),from,namespaceExport);
      else {addDependency(from);stars.push(from);}
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
  // `var` inside a top-level block/loop is a module binding too. Omitting it
  // from the renaming map would merge independent modules in the flattened
  // representation. Nested functions and class static blocks own their vars.
  function moduleVars(node){
    if(!node||typeof node!=='object')return;
    if(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression',
      'ClassDeclaration','ClassExpression'].includes(node.type))return;
    if(node.type==='VariableDeclaration'&&node.kind==='var')
      for(const declaration of node.declarations)addSymbol(nodeName(declaration.id),'var',declaration);
    for(const [key,value] of Object.entries(node)){
      if(['start','end','loc','range','raw','regex'].includes(key))continue;
      if(Array.isArray(value))value.forEach(moduleVars);
      else if(value&&typeof value==='object'&&value.type)moduleVars(value);
    }
  }
  moduleVars(ast);
  for(const [exported,local] of exports)
    if(!symbols.has(local)&&!imports.has(local)&&!namespaceImports.has(local))
      reject('export '+exported+' references missing local '+local+' in '+file);
  // JS modules can contain a source-level import binding not referenced in
  // the emitted code; preflight all such imports without executing anything.
  return {file,text,lowering,symbols,imports,namespaceImports,exports,forwards,
    stars:[...new Set(stars)],deps:[...deps],functions,initializers,
    bindingIdentifiers:moduleBindingIdentifiers(ast),
    hasTLA:initializers.some(part=>hasTopLevelAwait(part.node))};
}
function bindingIdentifiers(pattern,out=[]){
  if(!pattern)return out;
  if(pattern.type==='Identifier')out.push(pattern);
  else if(pattern.type==='AssignmentPattern')bindingIdentifiers(pattern.left,out);
  else if(pattern.type==='RestElement')bindingIdentifiers(pattern.argument,out);
  else if(pattern.type==='ArrayPattern')pattern.elements.forEach(x=>bindingIdentifiers(x,out));
  else if(pattern.type==='ObjectPattern')
    pattern.properties.forEach(x=>bindingIdentifiers(x.value??x.argument,out));
  return out;
}
const anonymousDefinition=node=>node?.type==='ArrowFunctionExpression'||
  (node?.type==='FunctionExpression'||node?.type==='ClassExpression')&&node.id===null;
function namedDefinition(source,name){
  // A property NamedEvaluation supplies the original observable function/class
  // name without adding an inner lexical binding. The computed key also keeps
  // a binding called __proto__ from becoming an object-literal prototype setter.
  const key=JSON.stringify(name);
  return '({['+key+']:('+source+')})['+key+']';
}
function rewrite(module,root,names,namespaceBindings=new Map()){
  const edits=new Map();
  const staticName=node=>node.computed?
    (node.property?.type==='Literal'&&typeof node.property.value==='string'?
      node.property.value:null):node.property?.type==='Identifier'?node.property.name:null;
  // A namespace re-export is still a namespace. Resolve a whole static path
  // before replacing its final value, without manufacturing a guest object.
  function namespaceOf(node){
    if(node?.type==='Identifier')return module.bindingIdentifiers.has(node)?
      namespaceBindings.get(node.name)??null:null;
    if(node?.type!=='MemberExpression')return null;
    const parent=namespaceOf(node.object);
    if(!parent)return null;
    const name=staticName(node);
    if(name===null)reject('dynamic namespace property access requires module namespace exotic semantics');
    return parent(name).readNamespace??null;
  }
  function checkAssignment(pattern){
    for(const identifier of bindingIdentifiers(pattern))
      if(module.bindingIdentifiers.has(identifier)&&
         (module.imports.has(identifier.name)||module.namespaceImports.has(identifier.name)))
        reject('assignment to read-only import '+identifier.name+' in '+module.file);
    const checkNamespace=target=>{
      if(!target)return;
      if(target.type==='MemberExpression'&&namespaceOf(target.object))
        reject('namespace exports are read-only live bindings');
      if(target.type==='AssignmentPattern')checkNamespace(target.left);
      else if(target.type==='RestElement')checkNamespace(target.argument);
      else if(target.type==='ArrayPattern')target.elements.forEach(checkNamespace);
      else if(target.type==='ObjectPattern')
        target.properties.forEach(property=>checkNamespace(property.value??property.argument));
    };
    checkNamespace(pattern);
  }
  function walk(node,parent=null,key=null){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){
      for(const child of node)walk(child,parent,key);
      return;
    }
    if(typeof node.type!=='string')return;
    if(node.type==='AssignmentExpression')checkAssignment(node.left);
    if(node.type==='UpdateExpression')checkAssignment(node.argument);
    if((node.type==='ForOfStatement'||node.type==='ForInStatement')&&
       node.left.type!=='VariableDeclaration')checkAssignment(node.left);
    const nameTarget=node.type==='VariableDeclarator'?node.id:
      node.type==='AssignmentPattern'||node.type==='AssignmentExpression'&&
      ['=','&&=','||=','??='].includes(node.operator)?node.left:null;
    const definition=node.type==='VariableDeclarator'?node.init:node.right;
    if(nameTarget?.type==='Identifier'&&module.bindingIdentifiers.has(nameTarget)&&
       anonymousDefinition(definition)){
      // Renaming a module cell must not rename an anonymous value initialized
      // or assigned to it. Set the name as part of evaluation, before class
      // static fields execute, while recursively preserving all source reads.
      walk(nameTarget,node,node.type==='VariableDeclarator'?'id':'left');
      const expression=rewrite(module,definition,names,namespaceBindings);
      edits.set(definition.start,{end:definition.end,
        value:namedDefinition(expression,nameTarget.name)});
      return;
    }
    const namespace=node.type==='MemberExpression'?namespaceOf(node.object):null;
    if(namespace){
      if((parent?.type==='AssignmentExpression'&&key==='left')||
         (parent?.type==='UpdateExpression'&&key==='argument')||
         (parent?.type==='UnaryExpression'&&parent.operator==='delete'))
        reject('namespace exports are read-only live bindings');
      // ns.fn() receives a namespace exotic as its strict this receiver.
      // Bare lexical fn() does not. Without a namespace identity in the
      // owned heap that call transformation would silently change semantics.
      if(parent?.type==='CallExpression'&&key==='callee'||
         parent?.type==='TaggedTemplateExpression'&&key==='tag')
        reject('namespace method call needs an owned namespace receiver');
      const exportedName=staticName(node);
      if(exportedName===null)reject('dynamic namespace property access requires module namespace exotic semantics');
      const target=namespace(exportedName);
      if(target.readNamespace)
        reject('namespace identity escapes a static property read in '+module.file);
      edits.set(node.start,{end:node.end,value:'('+target.linked+')'});
      return;
    }
    if(node.type==='Identifier'){
      if(node.name.startsWith('__traced_eval_'))
        reject('reserved generated identifier '+node.name+' in '+module.file);
      if(!module.bindingIdentifiers.has(node))return;
      if(namespaceBindings.has(node.name))
        reject('namespace identity escapes a static property read in '+module.file);
      const replacement=names.get(node.name);
      if(!replacement)return;
      if(parent?.type==='Property'&&parent.shorthand&&key==='value'){
        edits.set(node.start,{end:node.end,value:node.name+': '+replacement});
        return;
      }
      edits.set(node.start,{end:node.end,value:parent?.type==='NewExpression'&&key==='callee'?
        '('+replacement+')':replacement});
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
  args=[],calls=null,evaluateOnly=false}={}){
  if(typeof evaluateOnly!=='boolean'||evaluateOnly&&(calls!==null||args.length))
    throw new TypeError('Module evaluate-only mode cannot carry export calls or arguments');
  const sources=sourcesOf(modules);
  if(typeof entryModule!=='string'||!sources.has(entryModule))
    reject('entry module is not part of the supplied graph');
  if(!validName(exportName)&&exportName!=='default')
    reject('invalid entry export');
  const checkedArgs=ownDataArray(args,'Entry args',64);
  // A batch is one owned episode, not a cache that replays module effects
  // across multiple host calls. Safely read descriptors before guest import.
  let sequence=null;
  if(calls!==null){
    const checkedCalls=ownDataArray(calls,'Calls',32);
    if(!checkedCalls.length||checkedArgs.length)
      throw new TypeError('Calls must be 1-32 entries and replace single-call args');
    sequence=checkedCalls.map(call=>{
      if(!call||typeof call!=='object'||Array.isArray(call)||
         types.isProxy(call)||
         ![Object.prototype,null].includes(Object.getPrototypeOf(call)))
        throw new TypeError('Each owned module call must be a data record');
      const e=Object.getOwnPropertyDescriptor(call,'exportName');
      const a=Object.getOwnPropertyDescriptor(call,'args');
      if(!e||!Object.hasOwn(e,'value')||!validName(e.value)||
         !a||!Object.hasOwn(a,'value'))
        throw new TypeError('Each module call needs exportName and args');
      if(Reflect.ownKeys(call).some(key=>
           key!=='exportName'&&key!=='args'))
        throw new TypeError('Unexpected host property in module call record');
      return {exportName:e.value,
        args:ownDataArray(a.value,'Module call args',64)};
    });
  }
  const modulesByFile=new Map(),visited=new Set(),order=[];
  const cycles=[];
  function get(file){
    if(!modulesByFile.has(file))
      modulesByFile.set(file,parseModule(file,sources.get(file),sources));
    return modulesByFile.get(file);
  }
  const stack=[];
  function visit(file){
    const active=stack.indexOf(file);
    if(active>=0){
      const members=stack.slice(active);
      const marker=members.join(' -> ')+' -> '+file;
      if(!cycles.some(c=>c.path===marker))
        cycles.push({path:marker,members:[...members]});
      return;
    }
    if(visited.has(file))return;
    stack.push(file);
    for(const from of get(file).deps)visit(from);
    stack.pop();
    visited.add(file);order.push(file);
  }
  visit(entryModule);
  const indices=new Map(order.map((file,index)=>[file,index]));
  function dependsOn(file,dependency,seen=new Set()){
    if(file===dependency)return true;
    if(seen.has(file))return false;
    seen.add(file);
    return get(file).deps.some(from=>dependsOn(from,dependency,seen));
  }
  // A later module that does not depend on an earlier async module must
  // start while that module is suspended. Flattening the postorder would
  // serialize sibling bodies, including a synchronous sibling after TLA.
  // Async cyclic graphs additionally need DFS/SCC records even when their
  // syntactic postorder happens to resemble a single dependency chain.
  const scheduled=cycles.length>0&&order.some(file=>get(file).hasTLA)||
    order.some((file,index)=>order.slice(0,index).some(prior=>
      get(prior).hasTLA&&!dependsOn(file,prior)));
  const renamed=new Map();
  for(const [index,file] of order.entries()){
    const names=new Map();
    for(const name of get(file).symbols.keys())
      names.set(name,'__traced_eval_m'+(index+1)+'_'+name);
    renamed.set(file,names);
  }
  function resolve(file,exported,trail=new Set()){
    const marker=JSON.stringify([file,exported]);
    if(trail.has(marker))return null;
    // ResolveExport shares its visited pairs across every recursive star
    // branch. Besides detecting cycles, this bounds diamond traversal.
    const seen=trail;seen.add(marker);
    const module=get(file);
    if(module.exports.has(exported)){
      const local=module.exports.get(exported);
      if(module.symbols.has(local))
        return {file,local,linked:renamed.get(file).get(local),
          kind:module.symbols.get(local).kind};
      if(module.namespaceImports.has(local))
        return {file,local,linked:'namespace:'+file+'#'+local,
          kind:'namespace',namespace:module.namespaceImports.get(local)};
      const binding=module.imports.get(local);
      return binding?resolve(binding.module,binding.name,seen):null;
    }
    if(module.forwards.has(exported)){
      const forward=module.forwards.get(exported);
      if(forward.name===namespaceExport)
        return {file:forward.module,local:namespaceExport,
          linked:'namespace:'+forward.module,kind:'namespace',namespace:forward.module};
      return resolve(forward.module,forward.name,seen);
    }
    if(exported==='default')return null;
    let match=null;
    for(const from of module.stars){
      const found=resolve(from,exported,seen);
      if(found===ambiguousExport)return ambiguousExport;
      if(found===null)continue;
      if(match!==null&&(found.file!==match.file||found.local!==match.local))
        return ambiguousExport;
      match=found;
    }
    return match;
  }
  function required(file,exported){
    const found=resolve(file,exported);
    if(found===ambiguousExport)reject('ambiguous export '+exported+' in '+file);
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
  const selected=evaluateOnly?null:sequence?required(entryModule,sequence[0].exportName):
    required(entryModule,exportName);
  if(!evaluateOnly&&!sequence&&selected.kind!=='function'&&checkedArgs.length)
    reject('cannot call a non-function exported module binding');
  const requested=sequence?sequence.map(call=>{
    const binding=required(entryModule,call.exportName);
    if(binding.kind!=='function'&&call.args.length)
      reject('cannot invoke a non-function module export '+call.exportName);
    return {...call,binding};
  }):null;
  const linkedAccess=binding=>{
    if(binding.kind==='namespace')reject('namespace identity escapes a static property read');
    return scheduled?'__traced_eval_cells['+indices.get(binding.file)+'].'+binding.linked+'()':
      binding.linked;
  };
  const namespaceRead=file=>exported=>{
    const binding=resolve(file,exported);
    // Missing and ambiguous names are absent own properties of the namespace.
    // `void 0` cannot be captured by a guest binding named undefined.
    if(binding===null||binding===ambiguousExport)return {linked:'void 0'};
    if(binding.kind==='namespace')return {...binding,readNamespace:namespaceRead(binding.namespace)};
    return {...binding,linked:linkedAccess(binding)};
  };
  const bound=new Map(),links=[];
  const namespaces=new Map();
  for(const file of order){
    const module=get(file),names=new Map(renamed.get(file));
    const reads=new Map();
    for(const [local,from] of module.namespaceImports)
      reads.set(local,namespaceRead(from));
    namespaces.set(file,reads);
    for(const [local,imp] of module.imports){
      const resolved=required(imp.module,imp.name);
      if(resolved.kind==='namespace')reads.set(local,namespaceRead(resolved.namespace));
      else names.set(local,linkedAccess(resolved));
      links.push({from:file,local,source:imp.module,exportName:imp.name,
        binding:resolved.linked,live:true});
    }
    for(const [name,forward] of module.forwards){
      const target=required(file,name);
      links.push({from:file,exportName:name,source:forward.module,
        imported:forward.name===namespaceExport?'*namespace*':forward.name,
        binding:target.linked,live:true});
    }
    bound.set(file,names);
  }
  const entryFunction=evaluateOnly?'__traced_eval_entry':'__traced_evaluated_entry';
  let source='"use strict";\nasync function '+entryFunction+'(self) {\n';
  const spans=[];
  const append=(file,kind,fragment)=>{
    const start=source.length;
    source+='  '+fragment+'\n';
    spans.push({file,kind,start,end:source.length});
  };
  function initializers(file,lower=false){
    const module=get(file),names=bound.get(file);
    for(const item of module.initializers){
      let fragment;
      if(item.kind==='default'){
        const expression=rewrite(module,item.node,names,namespaces.get(file));
        // `export default <anonymous function/class definition>` performs
        // NamedEvaluation with the name "default" before the value is
        // initialized. A synthetic `const __default_expr = ...` would infer
        // that implementation name instead. Use an object property value as
        // the NamedEvaluation context; this also makes the name observable
        // during class static initialization, without consulting guest globals.
        const value=anonymousDefinition(item.node)?'({default:('+expression+')}).default':expression;
        fragment='const '+names.get(item.local)+' = ('+value+');';
      }else{
        fragment=rewrite(module,item.node,names,namespaces.get(file));
      }
      append(file,'evaluate',lower?lowerModuleAwaits(fragment):fragment);
    }
  }
  if(scheduled){
    append(null,'scheduler-state','const __traced_eval_cells=[];\n'+
      '  const __traced_eval_modules=[];\n'+
      '  const __traced_eval_entry_index='+indices.get(entryModule)+';');
    for(const file of order){
      const module=get(file),names=bound.get(file),index=indices.get(file);
      append(file,'environment','function* __traced_eval_module_'+index+'(){');
      for(const fn of module.functions)
        append(file,'instantiate',rewrite(module,fn,names,namespaces.get(file)));
      // Capturing a getter does not read its lexical binding. Functions are
      // already initialized while let/const stay in TDZ until evaluation.
      const getters=[...renamed.get(file).values()].map(name=>
        name+':()=>'+name);
      append(file,'bindings','yield {'+getters.join(',')+'};');
      initializers(file,true);
      append(file,'environment','}');
    }
    for(const file of order){
      const module=get(file),index=indices.get(file);
      append(file,'module-record','__traced_eval_modules['+index+']={'+
        'index:'+index+',entry:'+(file===entryModule)+',hasTLA:'+module.hasTLA+
        ',dependencies:'+JSON.stringify(module.deps.map(from=>indices.get(from)))+
        ',parents:[],pending:0,asyncOrder:0,dfsIndex:-1,ancestorIndex:-1,'+
        'cycleRoot:-1,started:false,status:"linked",failed:false,'+
        'error:undefined,execution:undefined,iterator:__traced_eval_module_'+index+'()};');
    }
    for(const file of order){
      const index=indices.get(file);
      append(file,'instantiate-environment','__traced_eval_cells['+index+']='+
        '__traced_eval_modules['+index+'].iterator.next().value;');
    }
    append(null,'async-scheduler',ownedModuleSchedulerSource);
  }else{
    // The already-qualified synchronous/single-chain profile shares lexical
    // cells directly. Parallel async graphs use retained environments above.
    for(const file of order){
      const module=get(file),names=bound.get(file);
      for(const fn of module.functions)
        append(file,'instantiate',rewrite(module,fn,names,namespaces.get(file)));
    }
    for(const file of order){
      initializers(file);
      // ExecuteAsyncModule settles an execution Promise, whose fulfillment
      // reaction readies dependent bodies in a later job. Even a syntactic
      // await hidden in an untaken branch has that completion boundary.
      if(get(file).hasTLA)append(file,'async-completion','await undefined;');
    }
    // The entry invocation follows completion of graph evaluation, just as
    // the caller awaiting the graph's top-level capability does. This also
    // lets already-enqueued module jobs precede that invocation for sync ESM.
    append(entryModule,'invoke-after-evaluation','await undefined;');
  }
  if(requested){
    // All calls execute after initialization in a single owned activation;
    // lexical exports and heap aliases survive each intermediate await.
    requested.forEach(({binding,args:callArgs},i)=>{
      const parameters=callArgs.map((_,j)=>
        'self.calls['+i+'].args['+j+']').join(',');
      const expression=binding.kind==='function'?
        linkedAccess(binding)+'('+parameters+')':linkedAccess(binding);
      source+='  const __traced_eval_result_'+i+'=await '+expression+';\n';
    });
    source+='  return ['+requested.map((_,i)=>
      '__traced_eval_result_'+i).join(',')+'];\n';
  }else if(evaluateOnly)source+='  return undefined;\n';
  else if(selected.kind==='function'){
    const argumentsText=checkedArgs.map((_,i)=>'self.args['+i+']').join(',');
    source+='  return await '+linkedAccess(selected)+'('+argumentsText+');\n';
  }else source+='  return await '+linkedAccess(selected)+';\n';
  source+='}\n';
  if(source.length>262144)
    throw new RangeError('Linked module entry exceeds bounded source limit');
  // Linking must never hand off unowned guest syntax to an assumed Node or
  // browser module loader. Validate the actual concatenated guest program,
  // including its identifier resolution, before an entry can be executed.
  try {evaluateOnly?parseOwnedScript(source):parseTraining(source);}
  catch(error){reject('unowned generated guest syntax: '+error.message);}
  const metadata={
    profile:'evaluated-module/1',entryModule,exportName:evaluateOnly?null:exportName,
    evaluationStrategy:scheduled?'async-dependency-scheduler':'dependency-concatenation',
    evaluationOrder:order.slice(),cycles,linkedBinding:selected?.linked??null,
    ...(scheduled?{asyncDependencies:order.map(file=>({file,index:indices.get(file),
      hasTLA:get(file).hasTLA,dependencies:get(file).deps.slice()}))}:{}),
    ...(requested?{calls:requested.map(({exportName,binding})=>({
      exportName,binding:binding.linked}))}:{}),
    instantiationAndEvaluation:spans,links,
    modules:order.map(file=>({
      file,source:sources.get(file),transpiler:get(file).lowering.compiler,
      sourceMap:get(file).lowering.sourceMap
    }))
  };
  return {profile:'evaluated-module/1',source,
    entryFunction,metadata,
    entryInput:sequence?{calls:sequence.map(({args})=>({args}))}:{args:checkedArgs}};
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

/**
 * Synchronous, effect-free native-embeddable module invocation. The owned
 * async root may use already-settling guest Promise jobs, but any outstanding
 * host effect or unresolved guest work fails closed. No native JS executes
 * the linked guest module, and archives are validated + exactly replayed.
 */
export function executeEvaluatedModulesSync({modules,entryModule,
  exportName='default',args=[],calls=null,maxSteps=100000,
  services=null,signal}={}){
  if(services!==null||signal!==undefined)
    throw new TypeError('Synchronous owned modules cannot use native services/signals');
  const linked=linkEvaluatedModules({modules,entryModule,exportName,args,calls});
  if(!Number.isSafeInteger(maxSteps)||maxSteps<1||maxSteps>1000000)
    throw new RangeError('Module evaluation step budget out of range');
  const runtime=createRuntime({maxSteps});
  const source=runtime.registerSource({text:linked.source,
    url:'evaluated-module://'+entryModule,trainingProfile:true});
  runtime.startEntry({source,functionName:linked.entryFunction,
    args:[linked.entryInput],allowAsync:true});
  const progress=runtime.drive();
  const bundle=JSON.parse(JSON.stringify(runtime.exportRun()));
  validateBundle(bundle);
  replayExact(bundle);
  if(progress.kind!=='terminated')
    throw new TypeError('Synchronous module invocation did not settle: '+progress.kind);
  const root=runtime.initialState.control.a0.activeFrameId;
  const promiseId=runtime.initialState.frames[root]?.asyncPromiseId;
  const settled=promiseId&&runtime.state.promises[promiseId];
  if(!settled||settled.status==='pending')
    throw new TypeError('Synchronous module root promise did not settle');
  if(settled.status==='rejected'){
    const value=realizeGraph(runtime.state.heap,[settled.value.value])[0];
    throw new Error('Owned module evaluation rejected: '+String(
      value&&typeof value==='object'?value.message??value.name??'guest object':value));
  }
  return {result:realizeGraph(runtime.state.heap,[settled.value.value])[0],
    bundle,metadata:linked.metadata};
}
