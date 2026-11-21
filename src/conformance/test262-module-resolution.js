// Source-only static Module Record construction and export resolution for the
// original Test262 preflight. This does not lower, compile or execute a body.
// In particular, a failed guest-lowering attempt cannot satisfy a resolution
// negative. Native module execution remains a separate reference authority.
import {posix} from 'node:path';

const ambiguous=Symbol('ambiguous');
const namespace=Symbol('namespace');
const defaultBinding=Symbol('default binding');
const name=node=>node.type==='Identifier'?node.name:
  node.type==='Literal'&&typeof node.value==='string'?node.value:null;
function boundNames(pattern){
  if(!pattern)return [];
  if(pattern.type==='Identifier')return [pattern.name];
  if(pattern.type==='AssignmentPattern')return boundNames(pattern.left);
  if(pattern.type==='RestElement')return boundNames(pattern.argument);
  if(pattern.type==='ArrayPattern')return pattern.elements.flatMap(boundNames);
  if(pattern.type==='ObjectPattern')return pattern.properties.flatMap(property=>
    boundNames(property.type==='RestElement'?property.argument:property.value));
  return [];
}
const request=(file,node)=>{
  const specifier=node.source.value;
  return specifier.startsWith('./')||specifier.startsWith('../')?
    posix.normalize(posix.join(posix.dirname(file),specifier)):null;
};

/** Return unresolved/ambiguous bindings in already parsed static source graphs.
 * Missing modules are reported by graph acquisition; only present targets are
 * checked here. Every explicit import and indirect export is checked, even if
 * its binding is unused. Star ambiguity alone is valid until requested. */
export function unresolvedOriginalModuleBindings(parsed){
  const records=new Map();
  for(const [file,ast] of parsed){
    const record={file,imports:new Map(),locals:new Map(),indirect:new Map(),stars:[]};
    records.set(file,record);
    for(const node of ast.body){
      if(node.type==='ImportDeclaration'){
        const from=request(file,node);
        for(const specifier of node.specifiers)
          record.imports.set(specifier.local.name,{from,imported:
            specifier.type==='ImportNamespaceSpecifier'?namespace:
              specifier.type==='ImportDefaultSpecifier'?'default':name(specifier.imported)});
      }else if(node.type==='ExportAllDeclaration'){
        const from=request(file,node);
        if(node.exported)record.indirect.set(name(node.exported),{from,imported:namespace});
        else record.stars.push(from);
      }else if(node.type==='ExportDefaultDeclaration'){
        record.locals.set('default',node.declaration.id?.name??defaultBinding);
      }else if(node.type==='ExportNamedDeclaration'){
        if(node.source){
          const from=request(file,node);
          for(const specifier of node.specifiers)
            record.indirect.set(name(specifier.exported),{from,imported:name(specifier.local)});
        }else if(node.declaration){
          const declaration=node.declaration;
          if(declaration.id)for(const binding of boundNames(declaration.id))record.locals.set(binding,binding);
          for(const declarator of declaration.declarations??[])
            for(const binding of boundNames(declarator.id))record.locals.set(binding,binding);
        }else for(const specifier of node.specifiers)
          record.locals.set(name(specifier.exported),name(specifier.local));
      }
    }
  }
  function resolve(file,exported,seen=new Set()){
    const pair=JSON.stringify([file,exported]);
    if(seen.has(pair))return null;
    seen.add(pair);
    const record=records.get(file);
    if(!record)return null;
    if(record.locals.has(exported)){
      const local=record.locals.get(exported),imported=record.imports.get(local);
      // ParseModule (ECMA-262 17.0, 10.a.ii) rewrites exports of imported
      // bindings, including namespaces, into indirect exports. Namespace
      // identity belongs to the target module, not to the importing local.
      return imported?(imported.imported===namespace?{file:imported.from,local:namespace}:
        resolve(imported.from,imported.imported,seen)):{file,local};
    }
    if(record.indirect.has(exported)){
      const entry=record.indirect.get(exported);
      return entry.imported===namespace?{file:entry.from,local:namespace}:
        resolve(entry.from,entry.imported,seen);
    }
    if(exported==='default')return null;
    let match=null;
    for(const from of record.stars){
      const found=resolve(from,exported,seen);
      if(found===ambiguous)return ambiguous;
      if(found===null)continue;
      if(match!==null&&(match.file!==found.file||match.local!==found.local))return ambiguous;
      match=found;
    }
    return match;
  }
  const missing=[];
  const check=(from,target,exported)=>{
    if(!records.has(target)||exported===namespace)return;
    const found=resolve(target,exported);
    if(found===null||found===ambiguous)missing.push({from,target,name:exported,
      kind:'export',resolution:found===ambiguous?'ambiguous':'unresolved'});
  };
  for(const record of records.values()){
    for(const entry of record.imports.values())check(record.file,entry.from,entry.imported);
    for(const entry of record.indirect.values())check(record.file,entry.from,entry.imported);
  }
  return missing;
}
