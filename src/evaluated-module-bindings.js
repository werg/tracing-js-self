// Identify the identifiers which actually refer to a module binding before
// lowering. Names alone are not enough: parameters, block/catch bindings,
// hoisted vars, named function expressions and class names may shadow them.
// This pass performs no evaluation and never changes the parsed source.
export function moduleBindingIdentifiers(ast){
  const locations=new WeakMap(),declarations=new WeakMap(),moduleBindings=new WeakSet();
  const scope=(parent,isFunction=false)=>({parent,isFunction,names:new Set()});
  const moduleScope=scope(null,true);
  const children=node=>Object.entries(node).filter(([key])=>!['loc','start','end'].includes(key))
    .flatMap(([key,value])=>Array.isArray(value)?value.map(child=>[key,child]):[[key,value]])
    .filter(([,value])=>value&&typeof value==='object'&&typeof value.type==='string');
  function declare(pattern,environment){
    if(!pattern)return;
    if(pattern.type==='Identifier'){
      environment.names.add(pattern.name);declarations.set(pattern,environment);
    }else if(pattern.type==='RestElement')declare(pattern.argument,environment);
    else if(pattern.type==='AssignmentPattern')declare(pattern.left,environment);
    else if(pattern.type==='ArrayPattern')pattern.elements.forEach(item=>declare(item,environment));
    else if(pattern.type==='ObjectPattern')pattern.properties.forEach(item=>
      declare(item.type==='RestElement'?item.argument:item.value,environment));
  }
  function locate(node,environment){
    if(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type)){
      if(node.type==='FunctionDeclaration')declare(node.id,environment);
      environment=scope(environment,true);
      if(node.type==='FunctionExpression')declare(node.id,environment);
      node.params.forEach(parameter=>declare(parameter,environment));
      locations.set(node,environment);
      if(node.id)locations.set(node.id,environment);
      for(const parameter of node.params)locate(parameter,environment);
      // Parameter defaults precede the body variable environment. A `var x`
      // in the body must not hide the imported x read by a default parameter.
      locate(node.body,node.params.some(parameter=>parameter.type!=='Identifier')?
        scope(environment,true):environment);
      return;
    }
    if(['ClassDeclaration','ClassExpression'].includes(node.type)){
      // The evaluated-module parser refuses top-level class declarations
      // before constructing this index. For the supported nested classes,
      // both declaration and inner class name remain local, so their shared
      // identifier keeps the inner mark. Supporting module-level classes will
      // also require retaining the outer declaration identity separately.
      if(node.type==='ClassDeclaration')declare(node.id,environment);
      environment=scope(environment);declare(node.id,environment);
    }else if(node.type==='SwitchStatement'){
      locations.set(node,environment);locate(node.discriminant,environment);
      const cases=scope(environment);
      node.cases.forEach(item=>locate(item,cases));
      return;
    }else if(node.type==='StaticBlock')environment=scope(environment,true);
    else if(['BlockStatement','ForStatement','ForInStatement','ForOfStatement','CatchClause'].includes(node.type)){
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
    for(const [,child] of children(node))locate(child,environment);
  }
  locate(ast,moduleScope);
  function collect(node,parent=null,key=null){
    if(node.type==='Identifier'){
      const declaration=declarations.get(node);
      if(declaration===moduleScope)moduleBindings.add(node);
      else if(!declaration){
        const nonReference=parent&&(
          parent.type==='MemberExpression'&&key==='property'&&!parent.computed||
          ['Property','MethodDefinition','PropertyDefinition'].includes(parent.type)&&key==='key'&&!parent.computed||
          ['LabeledStatement','BreakStatement','ContinueStatement'].includes(parent.type)&&key==='label'||
          parent.type==='MetaProperty'||parent.type==='ImportSpecifier'&&key==='imported'||
          parent.type==='ExportSpecifier'&&key==='exported');
        if(!nonReference){
          let environment=locations.get(node);
          while(environment&&!environment.names.has(node.name))environment=environment.parent;
          if(environment===moduleScope)moduleBindings.add(node);
        }
      }
    }
    for(const [field,child] of children(node))collect(child,node,field);
  }
  collect(ast);return moduleBindings;
}
