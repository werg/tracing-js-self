// Source-only class inventory, shared with independent observers. This module
// never imports the owned compiler, journal, protocol machine or evaluator.
import {parse} from 'acorn';

export const CONSTRUCTION_SOURCE_CALLABLE_PREFIX_V8='class:';
export function constructionSourceInventoryV8(source){
  const classes=[],methods=new Map(),synthetic=new Map();
  function visit(node){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){node.forEach(visit);return;}
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
    for(const [key,child]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))visit(child);
  }
  visit(parse(source,{ecmaVersion:'latest',sourceType:'script'}));
  return {classes,methods,synthetic};
}

/** Exact source membership only; construction capabilities remain separate. */
export function hasConstructionSourceCallableV8(source,code){
  if(typeof code!=='string'||!/^class:(0|[1-9][0-9]*):(constructor|instance|static)$/.test(code))return false;
  try{return constructionSourceInventoryV8(source).synthetic.has(code);}catch{return false;}
}
