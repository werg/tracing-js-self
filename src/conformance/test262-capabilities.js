// Static capability accounting only. No source transformation or guest
// evaluation: lexical bindings prevent a local `Map` from becoming a false
// requirement for an unimplemented global Map intrinsic.
const missingGlobals=new Set(['eval','Function','Date','RegExp','Map','WeakMap','WeakSet','JSON','Intl','globalThis',
  'isFinite','parseFloat','decodeURI','decodeURIComponent','encodeURI','encodeURIComponent','escape','unescape',
  'AggregateError','WeakRef','FinalizationRegistry','Uint8ClampedArray','Float16Array','Iterator','AsyncIterator',
  'ShadowRealm']);
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
      locations.set(node,environment);
      for(const parameter of node.params)assign(parameter,environment);
      // Initializers run outside the body variable environment. A body var
      // cannot hide a global used by a default parameter or binding pattern.
      assign(node.body,node.params.some(parameter=>parameter.type!=='Identifier')?
        scope(environment,true):environment);
      return;
    }else if(['ClassDeclaration','ClassExpression'].includes(node.type)){
      if(node.type==='ClassDeclaration')declare(node.id,environment);
      environment=scope(environment);declare(node.id,environment);
    }else if(node.type==='SwitchStatement'){
      locations.set(node,environment);assign(node.discriminant,environment);
      const cases=scope(environment);
      node.cases.forEach(item=>assign(item,cases));
      return;
    }else if(node.type==='StaticBlock'){
      // Static initialization blocks have their own var declaration scope.
      environment=scope(environment,true);
    }else if(['BlockStatement','ForStatement','ForInStatement','ForOfStatement','CatchClause'].includes(node.type)){
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

/** Resolve statically visible Test262 host-object and agent requirements.
 * Access through the standard globalThis binding is covered too; a locally
 * shadowed globalThis remains an ordinary guest value. */
export function test262HostCapabilities(ast){
  const free=new Set(freeTest262Identifiers(ast)),required=new Set(),agentAliases=new Set();
  if(free.has('ShadowRealm'))required.add('standard-global:ShadowRealm');
  const propertyName=node=>node?.computed?
    node.property?.type==='Literal'&&typeof node.property.value==='string'?node.property.value:null:
    node?.property?.type==='Identifier'?node.property.name:null;
  const global262=node=>node?.type==='Identifier'&&node.name==='$262'&&free.has('$262')||
    node?.type==='MemberExpression'&&node.object?.type==='Identifier'&&node.object.name==='globalThis'&&
    free.has('globalThis')&&propertyName(node)==='$262';
  function collectAliases(node){
    if(!node||typeof node!=='object')return;
    if(node.type==='VariableDeclarator'&&global262(node.init)){
      required.add('test262-host-object');
      if(node.id?.type==='Identifier')agentAliases.add(node.id.name);
      if(node.id?.type==='ObjectPattern'&&node.id.properties.some(property=>
        property.type==='Property'&&(property.key.name==='agent'||property.key.value==='agent')))
        required.add('agent-cluster');
    }
    for(const [key,value] of Object.entries(node)){
      if(['loc','start','end'].includes(key))continue;
      if(Array.isArray(value))value.forEach(collectAliases);else if(value&&typeof value==='object')collectAliases(value);
    }
  }
  collectAliases(ast);
  function visit(node){
    if(!node||typeof node!=='object')return;
    if(node.type==='Identifier'&&node.name==='$262'&&free.has('$262'))required.add('test262-host-object');
    if(node.type==='MemberExpression'&&(global262(node.object)||
      node.object?.type==='Identifier'&&agentAliases.has(node.object.name))){
      required.add('test262-host-object');
      if(propertyName(node)==='agent')required.add('agent-cluster');
    }
    for(const [key,value] of Object.entries(node)){
      if(['loc','start','end'].includes(key))continue;
      if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);
    }
  }
  visit(ast);return [...required].sort();
}

export function requiresScriptGlobalThis(ast){
  let required=false;
  function visit(node,globalReceiver){
    if(!node||typeof node!=='object')return;
    if(node.type==='ThisExpression'&&globalReceiver)required=true;
    if(['FunctionDeclaration','FunctionExpression'].includes(node.type))globalReceiver=false;
    if(['ClassDeclaration','ClassExpression'].includes(node.type)){
      visit(node.superClass,globalReceiver);
      for(const element of node.body.body){
        // Computed names run while defining the class, with the surrounding
        // receiver. Method bodies, fields and static blocks have class receivers.
        if(element.computed)visit(element.key,globalReceiver);
        if(element.type==='StaticBlock')visit(element,false);
        else visit(element.value,false);
      }
      return;
    }
    for(const [key,value] of Object.entries(node)){
      if(['loc','start','end'].includes(key))continue;
      if(Array.isArray(value))value.forEach(child=>visit(child,globalReceiver));
      else if(value&&typeof value==='object')visit(value,globalReceiver);
    }
  }
  visit(ast,true);return required;
}
