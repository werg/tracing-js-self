// Static semantic site inventory constructed before guest execution. No
// executed-site pruning, bytecode sites or private future events are consulted.
import {parse} from 'acorn';

const semanticNodes=new Set([
  'Identifier','Literal','BinaryExpression','LogicalExpression',
  'UnaryExpression','UpdateExpression','AssignmentExpression',
  'ConditionalExpression','CallExpression','NewExpression',
  'MemberExpression','ReturnStatement','ThrowStatement',
  'IfStatement','ForStatement','ForOfStatement','WhileStatement',
  'DoWhileStatement','VariableDeclarator','FunctionDeclaration',
  'FunctionExpression','ArrowFunctionExpression','AwaitExpression',
  'ObjectExpression','ArrayExpression','TryStatement','CatchClause'
]);
const opaqueEffects=new Set(['CallExpression','NewExpression','AwaitExpression',
  'AssignmentExpression','UpdateExpression','ThrowStatement']);
// Source callsite attribution shares the existing AST inventory. There is no
// separate parser or second effect-call grammar in the serving controller.
function directHostOperation(node) {
  const callee=node.callee;
  if(callee?.type!=='MemberExpression'||callee.object?.type!=='Identifier')return null;
  const name=callee.computed?
    (callee.property?.type==='Literal'&&typeof callee.property.value==='string'?
      callee.property.value:null):
    (callee.property?.type==='Identifier'?callee.property.name:null);
  if(!name)return null;
  if(callee.object.name==='host')return {"httpGet":"http.get","httpPost":"http.post","httpStatus":"http.responseStatus","httpRead":"http.responseRead","httpClose":"http.responseClose","httpAbort":"http.abort","readText":"fs.readText","writeText":"fs.writeText","listFiles":"fs.list","openRead":"fs.openRead","readChunk":"fs.readChunk","closeStream":"fs.close","socketConnect":"net.connect","socketWrite":"net.write","socketRead":"net.read","socketClose":"net.close"}[name]??'demo.'+name;
  if(callee.object.name==='Date'&&name==='now')return 'platform.dateNow';
  if(callee.object.name==='console')return 'platform.console.'+name;
  return null;
}
export function analyzeSemanticProgram(source) {
  if(typeof source!=='string')throw new TypeError('Missing static program source');
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'script',allowReturnOutsideFunction:false});
  const dictionary=new Map(),functions=[],effects=[],bindings=new Set();
  function visit(node,parent=null) {
    if(!node||typeof node!=='object'||typeof node.type!=='string')return;
    if(semanticNodes.has(node.type)){
      const key=node.start+':'+node.end+':'+node.type;
      if(!dictionary.has(key))
        dictionary.set(key,{start:node.start,end:node.end,role:node.type,
          ...(node.type==='CallExpression'&&directHostOperation(node)?
            {operation:directHostOperation(node)}:{})});
    }
    if(opaqueEffects.has(node.type))
      effects.push({start:node.start,end:node.end,type:node.type});
    if(node.type==='VariableDeclarator'&&node.id?.type==='Identifier')
      bindings.add(node.id.name);
    if(node.type==='FunctionDeclaration'&&node.id?.name)
      bindings.add(node.id.name);
    if(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type))
      functions.push({start:node.start,end:node.end,
        name:node.id?.name??null,params:node.params.map(p=>p.name??null)});
    for(const [key,value] of Object.entries(node)){
      if(['start','end','loc','raw','type'].includes(key))continue;
      if(Array.isArray(value))for(const child of value)visit(child,node);
      else if(value&&typeof value==='object')visit(value,node);
    }
  }
  visit(ast);
  const sites=[...dictionary.values()].sort((a,b)=>a.start-b.start||a.end-b.end||
    a.role.localeCompare(b.role)).map((site,index)=>({id:'s'+(index+1),...site}));
  return {schema:'semantic-program/1',sites,functions,effects,
    bindings:[...bindings].sort()};
}
