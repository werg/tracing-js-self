// The original upstream function is unchanged. Pinned test callbacks are
// built in an owned guest wrapper, never imported as executable host objects.
// Return all reachable data arguments so V8 independently checks mutations.
import {parse} from 'acorn';
const isTarget=n=>n?.type==='MemberExpression'&&!n.computed&&
 n.object?.type==='Identifier'&&n.object.name==='globalThis'&&
 n.property?.type==='Identifier'&&n.property.name==='__testArgs';

export function buildOwnedFixtureEntry(setup,entry){
 if(typeof setup!=='string'||!/^[A-Za-z_$][\w$]*$/.test(entry))
   throw new TypeError('Invalid fixture request');
 const ast=parse(setup,{ecmaVersion:2022,sourceType:'script'});
 const [first,second,...extra]=ast.body;
 const assign=first?.type==='ExpressionStatement'?first.expression:null;
 if(extra.length||assign?.type!=='AssignmentExpression'||
    assign.operator!=='='||!isTarget(assign.left)||
    assign.right?.type!=='ArrayExpression'||
    assign.right.elements.some(x=>!x||x.type==='SpreadElement'))
   throw new SyntaxError('Unrecognized pinned fixture assignment');
 const values=[...assign.right.elements];
 if(second){
   const call=second.type==='ExpressionStatement'?second.expression:null;
   if(call?.type!=='CallExpression'||call.callee?.type!=='MemberExpression'||
      call.callee.computed||call.callee.property?.name!=='push'||
      !isTarget(call.callee.object)||call.arguments.some(x=>x.type==='SpreadElement'))
     throw new SyntaxError('Unrecognized pinned fixture extension');
   values.push(...call.arguments);
 }
 const names=values.map((_,i)=>'__corpusArg'+i);
 const data=names.filter((_,i)=>!['ArrowFunctionExpression','FunctionExpression']
   .includes(values[i].type));
 const declarations=values.map((node,i)=>
   'const '+names[i]+' = '+setup.slice(node.start,node.end)+';');
 const source='function __ownedCorpusFixtureEntry() {\n  '+
   [...declarations,'const __corpusResult = '+entry+'('+names.join(', ')+');',
     'return [__corpusResult'+data.map(x=>', '+x).join('')+'];']
   .join('\n  ')+'\n}\n';
 return {source,entry:'__ownedCorpusFixtureEntry'};
}
