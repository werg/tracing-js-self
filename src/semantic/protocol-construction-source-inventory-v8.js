// Source-only class and callable inventory, shared with independent observers. This module
// never imports the owned compiler, journal, protocol machine or evaluator.
import {parse} from 'acorn';

export const CONSTRUCTION_SOURCE_CALLABLE_PREFIX_V8='class:';
export function constructionSourceInventoryV8(source){
  const classes=[],methods=new Map(),objectMethods=new Map(),ordinaryFunctions=new Map(),synthetic=new Map(),
    ordinaryNames=new Set(),constructions=[],prototypeMembers=[];
  function visit(node,parent=null){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){node.forEach(child=>visit(child,parent));return;}
    if(['FunctionDeclaration','FunctionExpression'].includes(node.type)&&!node.async&&!node.generator&&
      parent?.type!=='MethodDefinition'&&!(parent?.type==='Property'&&(parent.method||['get','set'].includes(parent.kind)))){
      ordinaryFunctions.set(node.start,node);
      if(node.id)ordinaryNames.add(node.id.name);
      if(parent?.type==='VariableDeclarator'&&parent.id.type==='Identifier')ordinaryNames.add(parent.id.name);
      if(parent?.type==='AssignmentExpression'&&parent.left.type==='Identifier')ordinaryNames.add(parent.left.name);
    }
    if(node.type==='NewExpression')constructions.push(node.callee);
    if(node.type==='MemberExpression'&&(!node.computed&&node.property.name==='prototype'||
      node.computed&&node.property.type==='Literal'&&node.property.value==='prototype'))prototypeMembers.push(node);
    if(node.type==='ObjectExpression')for(const element of node.properties)
      if(element.type==='Property'&&(element.method||['get','set'].includes(element.kind)))
        objectMethods.set(element.value.start,{objectNode:node,element});
    if(node.type==='ClassDeclaration'||node.type==='ClassExpression'){
      const elements=node.body.body,privateNames=[];
      for(const element of elements){
        if(element.key?.type==='PrivateIdentifier'&&!privateNames.some(row=>row.name===element.key.name))
          privateNames.push({name:element.key.name,kind:element.type==='PropertyDefinition'?'field':element.kind,
            static:element.static===true,element});
        if(element.type==='MethodDefinition')methods.set(element.value.start,{classNode:node,element});
      }
      const item={node,privateNames,constructor:elements.find(element=>element.kind==='constructor')??null};
      classes.push(item);
      // Private accessor pairs need their own access protocol and must not
      // acquire an apparently valid synthetic callable in this profile.
      const supported=!elements.some(element=>element.key?.type==='PrivateIdentifier'&&['get','set'].includes(element.kind));
      const add=(placement,body)=>synthetic.set('class:'+node.start+':'+placement,{classNode:node,placement,body});
      if(supported){
        if(!item.constructor)add('constructor',[]);
        for(const placement of ['instance','static']){
          const isStatic=placement==='static';
          const body=elements.filter(element=>element.type==='StaticBlock'?isStatic:
            element.static===isStatic&&(element.type==='PropertyDefinition'||
              element.type==='MethodDefinition'&&element.key?.type==='PrivateIdentifier'));
          if(body.length)add(placement,body);
        }
      }
    }
    for(const [key,child]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))visit(child,node);
  }
  visit(parse(source,{ecmaVersion:'latest',sourceType:'script'}));
  const ordinaryExpression=node=>node&&((node.type==='Identifier'&&ordinaryNames.has(node.name))||ordinaryFunctions.has(node.start));
  const ordinaryConstruction=constructions.some(ordinaryExpression)||prototypeMembers.some(node=>ordinaryExpression(node.object))||
    classes.some(item=>ordinaryExpression(item.node.superClass));
  return {classes,methods,objectMethods,ordinaryFunctions,ordinaryConstruction,prototypeMembers,synthetic};
}

/** Exact source membership only; construction capabilities remain separate. */
export function hasConstructionSourceCallableV8(source,code){
  if(typeof code!=='string'||!/^class:(0|[1-9][0-9]*):(constructor|instance|static)$/.test(code))return false;
  try{return constructionSourceInventoryV8(source).synthetic.has(code);}catch{return false;}
}
