// Bounded, source-only static ESM linker for pure function modules and
// function-only re-export forwarding. No general module evaluation.
// Imports are statically resolved within a supplied source graph; no Node
// loader, native require/import(), eval or host module code executes as guest.
// Only named function declarations are instantiated. Re-exports resolve to
// their original function binding, including cyclic and diamond star graphs.
// Initialization, mutable exports, dynamic imports and exotics fail closed.
import {parse as parseAcorn} from 'acorn';
import path from 'node:path';
import {compileBoundedTypeScript} from './typescript.js';
import {createRuntime} from './runtime.js';
import {validateBundle} from './validation.js';
import {replayExact} from './replay.js';
import {realizeGraph} from './training/graph.js';

const identifier=/^[A-Za-z_$][A-Za-z0-9_$]*$/;
const reject=message=>{throw new SyntaxError('Unsupported static-module/1: '+message);};
const own=(obj,key)=>Object.prototype.hasOwnProperty.call(obj,key);
function identifierName(node){
  return node?.type==='Identifier'?node.name:null;
}
function asSourceGraph(modules){
  if(!modules||typeof modules!=='object'||Array.isArray(modules))
    throw new TypeError('modules must be a path-to-source object');
  const normalized=new Map();
  for(const [key,text] of Object.entries(modules)){
    if(typeof text!=='string'||!key||key.startsWith('/')||
       key.includes('\\')||path.posix.normalize(key)!==key||
       key.startsWith('../')||text.length>131072)
      throw new TypeError('Invalid static module path or source');
    if(normalized.has(key))reject('duplicate module path');
    normalized.set(key,text);
  }
  if(normalized.size===0||normalized.size>128)
    throw new RangeError('Static module graph must contain 1-128 source files');
  return normalized;
}
function localImportPath(from,specifier,sources){
  if(!specifier.startsWith('./')&&!specifier.startsWith('../'))
    reject('host packages and bare module specifiers are not owned: '+specifier);
  const target=path.posix.normalize(path.posix.join(path.posix.dirname(from),specifier));
  if(!sources.has(target))reject('module not supplied: '+target);
  return target;
}
function parseOne(file,text,sources){
  const lowering=compileBoundedTypeScript(text,{path:file});
  const ast=parseAcorn(lowering.javascript,{ecmaVersion:2022,sourceType:'module'});
  const declarations=new Map(),imports=new Map(),exports=new Map();
  const reexports=new Map(),starExports=[];
  const addExport=(name,local)=>{
    if(!identifier.test(name)&&name!=='default')reject('invalid exported name');
    if(exports.has(name)||reexports.has(name))
      reject('duplicate export '+name+' in '+file);
    exports.set(name,local);
  };
  const addReexport=(name,from,imported)=>{
    if(!identifier.test(name)&&name!=='default')reject('invalid re-exported name');
    if(exports.has(name)||reexports.has(name))
      reject('duplicate export '+name+' in '+file);
    reexports.set(name,{module:from,name:imported});
  };
  const addFunction=declaration=>{
    const name=identifierName(declaration?.id);
    if(declaration?.type!=='FunctionDeclaration'||!name||declarations.has(name)||
       imports.has(name)||name.startsWith('__traced_m'))
      reject('only uniquely named ordinary function declarations are supported in '+file);
    if(declaration.async||declaration.generator)
      reject('async/generator export not supported in '+file);
    declarations.set(name,declaration);
    return name;
  };
  for(const node of ast.body){
    if(node.type==='ImportDeclaration'){
      const importedFrom=localImportPath(file,node.source.value,sources);
      if(node.specifiers.length===0)reject('side-effect module imports');
      for(const spec of node.specifiers){
        if(spec.type==='ImportNamespaceSpecifier')
          reject('namespace import requires a module namespace object');
        const local=identifierName(spec.local);
        const imported=spec.type==='ImportDefaultSpecifier'?'default':
          identifierName(spec.imported);
        if(!local||!imported||imports.has(local)||declarations.has(local)||
           local.startsWith('__traced_m'))
          reject('duplicate or unsupported import binding');
        imports.set(local,{module:importedFrom,name:imported});
      }
    }else if(node.type==='FunctionDeclaration'){
      addFunction(node);
    }else if(node.type==='ExportNamedDeclaration'){
      if(node.source!==null){
        const from=localImportPath(file,node.source.value,sources);
        if(node.specifiers.length===0)
          reject('empty source re-export executes a module for side effects');
        for(const spec of node.specifiers){
          if(spec.type!=='ExportSpecifier')reject('namespace re-export');
          const name=identifierName(spec.exported),imported=identifierName(spec.local);
          if(!name||!imported)reject('literal re-export name');
          addReexport(name,from,imported);
        }
      }else if(node.declaration){
        const name=addFunction(node.declaration);
        addExport(name,name);
      }else for(const spec of node.specifiers){
        const name=identifierName(spec.exported),local=identifierName(spec.local);
        if(!name||!local)reject('literal/namespace export');
        addExport(name,local);
      }
    }else if(node.type==='ExportDefaultDeclaration'){
      const name=addFunction(node.declaration);
      addExport('default',name);
    }else if(node.type==='ExportAllDeclaration'){
      if(node.exported)reject('namespace star re-export requires an exotic object');
      starExports.push(localImportPath(file,node.source.value,sources));
    }else if(node.type==='EmptyStatement'){
      // Harmless source-only separator.
    }else reject('top-level effects, mutable bindings or module syntax in '+file+
      ' ('+node.type+')');
  }
  for(const local of exports.values())
    if(!imports.has(local)&&!declarations.has(local))
      reject('export of missing binding '+local+' in '+file);
  for(const local of imports.keys())
    if(declarations.has(local))reject('import/declaration collision in '+file);
  return {file,text,lowering,declarations,imports,exports,reexports,starExports};
}
// Conservative alpha renaming of imported and file-local function bindings.
// Reject lexical shadowing of rewritten names rather than producing subtle,
// plausible but incorrect lexical trace targets.
function rewriteDeclaration(module,root,names){
  const bindings=new Set(names.keys());
  const replacements=new Map();
  const checkPattern=node=>{
    if(!node)return;
    if(node.type==='Identifier'&&bindings.has(node.name))
      reject('shadowed linked name '+node.name+' in '+module.file);
    if(node.type==='RestElement'||node.type==='AssignmentPattern')
      checkPattern(node.argument??node.left);
    if(node.type==='ArrayPattern')node.elements.forEach(checkPattern);
    if(node.type==='ObjectPattern')node.properties.forEach(x=>
      checkPattern(x.value??x.argument));
  };
  function walk(node,parent=null,key=null){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){node.forEach(n=>walk(n,parent,key));return;}
    if(typeof node.type!=='string')return;
    if(node.type==='VariableDeclarator')checkPattern(node.id);
    // ESM imported names are read-only live bindings. This static profile
    // supports only function exports, so any assignment is an error rather
    // than silently mutating the flattened global function cell.
    if((node.type==='AssignmentExpression'||node.type==='UpdateExpression')&&
       node.left?.type==='Identifier'&&module.imports.has(node.left.name))
      reject('assignment to imported binding '+node.left.name);
    if(node.type==='UpdateExpression'&&
       node.argument?.type==='Identifier'&&module.imports.has(node.argument.name))
      reject('update of imported binding '+node.argument.name);
    if(node.type==='FunctionDeclaration'||node.type==='FunctionExpression'||
       node.type==='ArrowFunctionExpression'){
      if(node!==root)checkPattern(node.id);
      (node.params??[]).forEach(checkPattern);
    }
    if(node.type==='CatchClause')checkPattern(node.param);
    if(node.type==='Identifier'){
      if(!bindings.has(node.name))return;
      if(parent?.type==='MemberExpression'&&key==='property'&&!parent.computed)return;
      if(parent?.type==='Property'&&key==='key'&&!parent.computed)return;
      // For {importAlias}, substituting the identifier alone would rename
      // the *property key*, not just the live value. Preserve the public key.
      if(parent?.type==='Property'&&key==='value'&&parent.shorthand){
        replacements.set(node.start,{end:node.end,
          value:node.name+': '+names.get(node.name)});
        return;
      }
      if(parent?.type==='MethodDefinition'&&key==='key'&&!parent.computed)return;
      if(key==='label')return;
      if(parent?.type==='VariableDeclarator'&&key==='id')return;
      if(parent?.type==='FunctionDeclaration'&&key==='id'&&parent!==root)return;
      if(parent?.type==='FunctionExpression'&&key==='id')return;
      if(parent?.type==='ImportDeclaration'||parent?.type==='ExportSpecifier')return;
      replacements.set(node.start,{end:node.end,value:names.get(node.name)});
      return;
    }
    for(const [childKey,value] of Object.entries(node)){
      if(['start','end','loc','range','raw','regex'].includes(childKey))continue;
      if(Array.isArray(value)||value&&typeof value==='object'&&value.type)
        walk(value,node,childKey);
    }
  }
  walk(root);
  let source=module.lowering.javascript.slice(root.start,root.end);
  for(const [start,change] of [...replacements].sort((a,b)=>b[0]-a[0])){
    const left=start-root.start,right=change.end-root.start;
    source=source.slice(0,left)+change.value+source.slice(right);
  }
  return source;
}
export function linkStaticModules({modules,entryModule,exportName='default'}={}){
  const sources=asSourceGraph(modules);
  if(typeof entryModule!=='string'||!sources.has(entryModule))
    reject('entry module not supplied');
  if(typeof exportName!=='string'||(!identifier.test(exportName)&&exportName!=='default'))
    reject('invalid entry export');
  const parsed=new Map();
  function parse(file){
    if(!parsed.has(file))parsed.set(file,parseOne(file,sources.get(file),sources));
    return parsed.get(file);
  }
  const reachable=new Set();
  function visit(file){
    if(reachable.has(file))return;
    reachable.add(file);
    const module=parse(file);
    for(const imp of module.imports.values())visit(imp.module);
    for(const imp of module.reexports.values())visit(imp.module);
    for(const from of module.starExports)visit(from);
  }
  visit(entryModule);
  const ordered=[...reachable].sort();
  const bindings=new Map();
  for(const [i,file] of ordered.entries()){
    const module=parse(file);
    const map=new Map();
    for(const name of module.declarations.keys())
      map.set(name,'__traced_m'+(i+1)+'_'+name);
    bindings.set(file,map);
  }
  // ResolveExport semantics for the function-only profile: explicit exports
  // beat export *, the default export is never included in export *, and two
  // distinct star targets are ambiguous. A cycle without a definition does
  // not invent a binding or recurse forever.
  function resolve(file,exported,trail=new Set()){
    const marker=file+'#'+exported;
    if(trail.has(marker))return null;
    const seen=new Set(trail);
    seen.add(marker);
    const module=parse(file),local=module.exports.get(exported);
    if(local!==undefined){
      if(module.declarations.has(local))return bindings.get(file).get(local);
      const imported=module.imports.get(local);
      return imported?resolve(imported.module,imported.name,seen):null;
    }
    const forwarded=module.reexports.get(exported);
    if(forwarded)return resolve(forwarded.module,forwarded.name,seen);
    if(exported==='default')return null;
    const matches=new Set();
    for(const from of module.starExports){
      const found=resolve(from,exported,seen);
      if(found!==null)matches.add(found);
      if(matches.size>1)reject('ambiguous star re-export '+exported+' in '+file);
    }
    return matches.size===1?[...matches][0]:null;
  }
  function requireResolved(file,exported){
    const resolved=resolve(file,exported);
    if(resolved===null)reject('unresolved export '+exported+' in '+file);
    return resolved;
  }
  // Explicit forwarding must link even when not reached by the entry call.
  for(const file of ordered)
    for(const name of parse(file).reexports.keys())requireResolved(file,name);
  const entryFunction=requireResolved(entryModule,exportName);
  const items=[],links=[];
  for(const file of ordered){
    const module=parse(file);
    const names=new Map(bindings.get(file));
    for(const [local,imported] of module.imports)
      names.set(local,requireResolved(imported.module,imported.name));
    for(const [local,imported] of module.imports)
      links.push({from:file,local,module:imported.module,
        exported:imported.name,binding:names.get(local)});
    for(const [exported,forward] of module.reexports)
      links.push({from:file,kind:'reexport',exported,
        module:forward.module,imported:forward.name,
        binding:requireResolved(file,exported)});
    for(const from of module.starExports)
      links.push({from:file,kind:'star-reexport',module:from});
    for(const [local,ast] of module.declarations)
      items.push({file,local,name:names.get(local),
        code:rewriteDeclaration(module,ast,names),
        transpiler:module.lowering.compiler});
  }
  let source='"use strict";\n';
  const sites=[];
  for(const item of items){
    const start=source.length;
    source+=item.code+'\n';
    sites.push({module:item.file,local:item.local,linked:item.name,
      generatedStart:start,generatedEnd:source.length-1});
  }
  return {profile:'static-module/1',source,entryFunction,
    metadata:{profile:'static-module/1',entryModule,exportName,
      functions:sites,links,modules:ordered.map(file=>({
        file,source:sources.get(file),
        transpiler:parse(file).lowering.compiler,
        sourceMap:parse(file).lowering.sourceMap
      }))}};
}
export function executeStaticModule({modules,entryModule,exportName='default',
  args=[],maxSteps=10000}={}){
  const linked=linkStaticModules({modules,entryModule,exportName});
  const runtime=createRuntime({maxSteps});
  const source=runtime.registerSource({text:linked.source,
    url:'static-module://'+entryModule,trainingProfile:true});
  runtime.startEntry({source,functionName:linked.entryFunction,args});
  const progress=runtime.drive();
  if(progress.kind!=='terminated')
    throw new TypeError('Static module guest did not complete: '+progress.kind);
  const bundle=JSON.parse(JSON.stringify(runtime.exportRun()));
  validateBundle(bundle);
  replayExact(bundle);
  return {result:realizeGraph(runtime.state.heap,[runtime.result])[0],
    bundle,metadata:linked.metadata};
}
