// Bounded, source-only static ESM linker for pure function modules.
// Imports are statically resolved within a supplied source graph; no Node
// loader, native require/import(), eval or host module code executes as guest.
// Only named function declarations are instantiated. This deliberately rejects
// general module initialization, mutable exports, dynamic imports and exotics.
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
  const addExport=(name,local)=>{
    if(!identifier.test(name)&&name!=='default')reject('invalid exported name');
    if(exports.has(name))reject('duplicate export '+name+' in '+file);
    exports.set(name,local);
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
      if(node.source!==null)reject('re-export from a source is not in this profile');
      if(node.declaration){
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
  return {file,text,lowering,declarations,imports,exports};
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
    for(const imp of parse(file).imports.values())visit(imp.module);
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
  function resolve(file,exported,trail=new Set()){
    const marker=file+'#'+exported;
    if(trail.has(marker))reject('cyclic re-export without a function declaration');
    trail.add(marker);
    const module=parse(file),local=module.exports.get(exported);
    if(!local)reject('unresolved export '+exported+' in '+file);
    if(module.declarations.has(local))return bindings.get(file).get(local);
    const imported=module.imports.get(local);
    if(!imported)reject('missing local export '+local);
    return resolve(imported.module,imported.name,trail);
  }
  const entryFunction=resolve(entryModule,exportName);
  const items=[],links=[];
  for(const file of ordered){
    const module=parse(file);
    const names=new Map(bindings.get(file));
    for(const [local,imported] of module.imports)
      names.set(local,resolve(imported.module,imported.name));
    for(const [local,imported] of module.imports)
      links.push({from:file,local,module:imported.module,
        exported:imported.name,binding:names.get(local)});
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
