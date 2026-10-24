// Conservative natlang-emitted CommonJS bridge to a purely owned ESM graph.
// Does not execute arbitrary CommonJS bootstrap/require or native callbacks.
import {parse as parseAcorn} from 'acorn';

const identifier=value=>typeof value==='string'&&/^[$A-Za-z_][$\w]*$/.test(value) &&
  !['__proto__','constructor','prototype','then'].includes(value);
const nameOf=node=>node?.type==='Identifier'?node.name:null;

function moduleMarker(statement){
  const n=statement?.expression;
  if(n?.type!=='CallExpression'||n.arguments.length!==3||
     n.callee?.type!=='MemberExpression'||n.callee.computed||
     nameOf(n.callee.object)!=='Object'||nameOf(n.callee.property)!=='defineProperty'||
     nameOf(n.arguments[0])!=='exports'||
     n.arguments[1]?.type!=='Literal'||n.arguments[1].value!=='__esModule')
    return false;
  const obj=n.arguments[2];
  return obj?.type==='ObjectExpression'&&obj.properties.length===1&&
    obj.properties[0].type==='Property'&&!obj.properties[0].computed&&
    nameOf(obj.properties[0].key)==='value'&&
    obj.properties[0].value?.type==='Literal'&&obj.properties[0].value.value===true;
}
function registration(statement){
  const n=statement?.expression;
  if(n?.type!=='AssignmentExpression'||n.operator!=='='||
     n.left.type!=='MemberExpression'||nameOf(n.left.object)!=='exports'||
     n.left.optional||nameOf(n.right)===null)return null;
  const name=n.left.computed?n.left.property?.type==='Literal'?
    n.left.property.value:null:nameOf(n.left.property);
  if(!identifier(name)||!identifier(n.right.name))return null;
  return {name,local:n.right.name};
}

/**
 * The pinned TypeScript CommonJS emitter uses exports.f = void 0, sometimes
 * chained, before registering const function bindings. A marker is inert
 * only when EVERY named export has a subsequent statically verified binding.
 */
function emptyExportMarkers(statement){
  let expr=statement?.expression;
  const names=[];
  while(expr?.type==='AssignmentExpression'&&expr.operator==='='&&
        expr.left?.type==='MemberExpression'&&!expr.left.optional&&
        nameOf(expr.left.object)==='exports'){
    const name=expr.left.computed?
      expr.left.property?.type==='Literal'?expr.left.property.value:null:
      nameOf(expr.left.property);
    if(!identifier(name))return null;
    names.push(name);
    expr=expr.right;
  }
  return names.length&&expr?.type==='UnaryExpression'&&
    expr.operator==='void'&&expr.prefix&&
    expr.argument?.type==='Literal'&&expr.argument.value===0?
    names:null;
}

/**
 * Accept only a flat group of hoisted guest declarations and native-free
 * TypeScript CommonJS export registrations. Unknown bootstrap syntax fails
 * closed at module-evaluation time rather than running through host V8.
 */
export function lowerPureCommonJsModule(code){
  if(typeof code!=='string'||code.length>65536)
    throw new TypeError('CommonJS source must be bounded text');
  const ast=parseAcorn(code,{ecmaVersion:2022,sourceType:'script'});
  const functions=new Set(),registrations=[],seen=new Set(),markers=new Set(),declarations=[];
  for(const statement of ast.body){
    if(statement.type==='ExpressionStatement'&&statement.directive==='use strict')
      continue;
    if(moduleMarker(statement))continue;
    const emptyMarkers=emptyExportMarkers(statement);
    if(emptyMarkers){
      for(const name of emptyMarkers){
        if(markers.has(name)||seen.has(name))
          throw new TypeError('Duplicate CommonJS export initialization');
        markers.add(name);
      }
      continue;
    }
    if(statement.type==='FunctionDeclaration'&&identifier(statement.id?.name)&&
       !statement.generator&&!functions.has(statement.id.name)){
      const text=code.slice(statement.start,statement.end);
      functions.add(statement.id.name);
      declarations.push(text);
      continue;
    }
    if(statement.type==='VariableDeclaration'&&
       ['const','let'].includes(statement.kind)&&
       statement.declarations.length>0&&statement.declarations.length<=32&&
       statement.declarations.every(item=>item.id.type==='Identifier'&&
         identifier(item.id.name)&&item.init)){
      // A const function value can be exposed as a stable CommonJS callable.
      // Mutable let callables are not equivalent to ESM live exports.
      for(const item of statement.declarations)
        if(statement.kind==='const'&&
           ['ArrowFunctionExpression','FunctionExpression'].includes(item.init.type)&&
           !item.init.generator)
          functions.add(item.id.name);
      // Other initializers must still pass the owned ESM linker.
      declarations.push(code.slice(statement.start,statement.end));
      continue;
    }
    const mapping=registration(statement);
    if(mapping&&!seen.has(mapping.name)){
      registrations.push(mapping);seen.add(mapping.name);continue;
    }
    throw new TypeError('Unowned CommonJS top-level statement or export registration');
  }
  if(!registrations.length||registrations.length>32||
     [...markers].some(name=>!seen.has(name))||
     registrations.some(record=>!functions.has(record.local)))
    throw new TypeError('Only registered guest function exports are supported');
  return {
    source:'"use strict";\n'+declarations.join('\n')+'\n'+
      registrations.map(({name,local})=>
        'export { '+local+' as '+name+' };').join('\n')+'\n',
    exportNames:registrations.map(record=>record.name)
  };
}
