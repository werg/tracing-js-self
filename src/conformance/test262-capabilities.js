// Static capability accounting only. No source transformation or guest
// evaluation: lexical bindings prevent a local `Map` from becoming a false
// requirement for an unimplemented global Map intrinsic.
const missingGlobals=new Set(['eval','Function','Date','RegExp','Map','WeakMap','WeakSet','JSON','Intl','globalThis',
  'isFinite','parseFloat','decodeURI','decodeURIComponent','encodeURI','encodeURIComponent','escape','unescape',
  'AggregateError','WeakRef','FinalizationRegistry','Uint8ClampedArray','Float16Array','Iterator','AsyncIterator']);
export const unavailableOwnedStandardGlobal=name=>missingGlobals.has(name);

export function freeTest262Identifiers(ast){
  const locations=new WeakMap(),declarations=new WeakSet(),references=new Set();
  const scope=(parent,isFunction=false)=>({parent,isFunction,names:new Set()});
  const root=scope(null,true);
  const children=node=>Object.entries(node).filter(([key])=>!['loc','start','end'].includes(key))
    .flatMap(([key,value])=>Array.isArray(value)?value.map(child=>[key,child]):[[key,value]])
    .filter(([,value])=>value&&typeof value==='object'&&typeof value.type==='string');
  function declare(pattern,environment){
    if(!pattern)return;
    if(pattern.type==='Identifier'){environment.names.add(pattern.name);declarations.add(pattern);}
    else if(pattern.type==='RestElement')declare(pattern.argument,environment);
    else if(pattern.type==='AssignmentPattern')declare(pattern.left,environment);
    else if(pattern.type==='ArrayPattern')pattern.elements.forEach(item=>declare(item,environment));
    else if(pattern.type==='ObjectPattern')pattern.properties.forEach(item=>declare(item.type==='RestElement'?item.argument:item.value,environment));
  }
  function assign(node,environment){
    if(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type)){
      if(node.type==='FunctionDeclaration')declare(node.id,environment);
      environment=scope(environment,true);
      if(node.type==='FunctionExpression')declare(node.id,environment);
      node.params.forEach(parameter=>declare(parameter,environment));
    }else if(['ClassDeclaration','ClassExpression'].includes(node.type)){
      if(node.type==='ClassDeclaration')declare(node.id,environment);
      environment=scope(environment);declare(node.id,environment);
    }else if(['BlockStatement','ForStatement','ForInStatement','ForOfStatement','SwitchStatement','CatchClause'].includes(node.type)){
      environment=scope(environment);
      if(node.type==='CatchClause')declare(node.param,environment);
    }
    locations.set(node,environment);
    if(node.type==='VariableDeclaration'){
      let target=environment;
      if(node.kind==='var')while(!target.isFunction)target=target.parent;
      node.declarations.forEach(declaration=>declare(declaration.id,target));
    }
    if(node.type==='ImportDeclaration')node.specifiers.forEach(specifier=>declare(specifier.local,environment));
    for(const [,child] of children(node))assign(child,environment);
  }
  assign(ast,root);
  function collect(node,parent=null,key=null){
    if(node.type==='Identifier'&&!declarations.has(node)){
      const nonReference=parent&&(
        ['MemberExpression','OptionalMemberExpression'].includes(parent.type)&&key==='property'&&!parent.computed||
        ['Property','MethodDefinition','PropertyDefinition'].includes(parent.type)&&key==='key'&&!parent.computed||
        ['LabeledStatement','BreakStatement','ContinueStatement'].includes(parent.type)&&key==='label'||
        parent.type==='MetaProperty'||parent.type==='ImportSpecifier'&&key==='imported'||
        parent.type==='ExportSpecifier'&&key==='exported');
      if(!nonReference){
        let environment=locations.get(node);
        while(environment&&!environment.names.has(node.name))environment=environment.parent;
        if(!environment)references.add(node.name);
      }
    }
    for(const [name,child] of children(node))collect(child,node,name);
  }
  collect(ast);return [...references].sort();
}
export function unsupportedOwnedGlobals(ast){
  return freeTest262Identifiers(ast).filter(name=>missingGlobals.has(name));
}

export function requiresScriptGlobalThis(ast){
  let required=false;
  function visit(node,globalReceiver){
    if(!node||typeof node!=='object')return;
    if(node.type==='ThisExpression'&&globalReceiver)required=true;
    if(['FunctionDeclaration','FunctionExpression'].includes(node.type))globalReceiver=false;
    if(['ClassDeclaration','ClassExpression'].includes(node.type)){
      visit(node.superClass,globalReceiver);visit(node.body,false);return;
    }
    for(const [key,value] of Object.entries(node)){
      if(['loc','start','end'].includes(key))continue;
      if(Array.isArray(value))value.forEach(child=>visit(child,globalReceiver));
      else if(value&&typeof value==='object')visit(value,globalReceiver);
    }
  }
  visit(ast,true);return required;
}
