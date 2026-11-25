// Original-source production helper extraction for the owned training profile.
// Only the exact pinned vendor bytes and top-level standalone function bodies
// are eligible.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parse} from 'acorn';
import {upstream,pinnedSha256} from '../../corpus/stateful/cases.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
export const OWNED_PRODUCTION_HELPERS=Object.freeze([
 {module:'axios-interceptors',function:'countHandlers',
  cases:[[null],[[]],[[1,2,3]]]},
 {module:'axios-interceptors',function:'normalizeHandlerId',
  cases:[['3'],['03'],[4],['not-a-number']]},
 {module:'axios-interceptors',function:'trimHandlers',
  cases:[[null],[[1,null,null]],[[1,2]]]},
 {module:'axios-utils',function:'isUnsafeObjectKey',
  cases:[['__proto__'],['constructor'],['prototype'],['safe'],[4]]},
 {module:'axios-utils',function:'isObject',
  cases:[[null],[{}],[4],['hello']]},
 {module:'axios-utils',function:'isBoolean',
  cases:[[true],[false],[0],[null]]}
]);
const fileFor=record=>'corpus/stateful/upstream/'+record.path;
export function extractPinnedHelper(moduleName,functionName,{root=process.cwd()}={}){
 const pin=upstream[moduleName],expected=pinnedSha256[moduleName];
 if(!pin||!expected||!/^[a-zA-Z_$][\w$]*$/.test(functionName))
  throw new TypeError('Unrecognized pinned production function');
 const file=resolve(root,fileFor(pin));
 const original=readFileSync(file,'utf8');
 if(sha(original)!==expected)
  throw new Error('Pinned production library SHA-256 mismatch: '+moduleName);
 const parsed=parse(original,{ecmaVersion:2022,sourceType:'module'});
 const matches=parsed.body.filter(x=>x.type==='FunctionDeclaration'&&x.id?.name===functionName);
 const arrows=parsed.body.filter(x=>x.type==='VariableDeclaration'&&
  x.declarations.length===1&&
  x.declarations[0].id?.name===functionName&&
  x.declarations[0].init?.type==='ArrowFunctionExpression');
 if(matches.length+arrows.length!==1)
  throw new Error('No single synchronous original function declaration or arrow');
 const prefix='"use strict";\n';
 let projected,sourceStart,sourceEnd,projectionStart,extraction,originalArrow=null;
 if(matches.length===1){
  const node=matches[0];
  if(node.async||node.generator)
   throw new Error('Asynchronous/generator original helper is unsupported');
  const literal=original.slice(node.start,node.end);
  projected=prefix+literal+'\n';
  sourceStart=node.start;sourceEnd=node.end;projectionStart=prefix.length;
  extraction='exact-source-function/1';
 }else{
  const declaration=arrows[0].declarations[0],arrow=declaration.init;
  if(arrow.async||arrow.expression!==true||
   arrow.params.some(p=>p.type!=='Identifier')||
   arrow.body.type==='AwaitExpression')
   throw new Error('Unprojectable original arrow helper');
  const originalBody=original.slice(arrow.body.start,arrow.body.end);
  const synthetic='function '+functionName+'('+arrow.params.map(p=>p.name).join(',')+'){return ';
  projected=prefix+synthetic+originalBody+';}\n';
  sourceStart=arrow.body.start;sourceEnd=arrow.body.end;
  projectionStart=prefix.length+synthetic.length;
  extraction='unchanged-arrow-expression-with-synthetic-function-wrapper/1';
  originalArrow='const '+functionName+' = '+
   original.slice(arrow.start,arrow.end)+';\n';
 }
 return {projected,entry:functionName,originalArrow,
  provenance:{repository:pin.repository,revision:pin.revision,
   license:pin.license,path:pin.path,sha256:expected,
   sourceSpan:{start:sourceStart,end:sourceEnd,unit:'utf16'},
   projectionStart,extraction}};
}

export const OWNED_PRODUCTION_CLOSURE_CASES=Object.freeze([
 ['string','abc'],['string',4],['number',0],['number',null],
 ['boolean',true],['boolean',false],['boolean',0],
 ['undefined',null],['object',{}],['object',[1,2]],
 ['function','text']
]);

export function extractPinnedTypeOfTestClosure({root=process.cwd()}={}){
 const moduleName='axios-utils',pin=upstream[moduleName];
 const original=readFileSync(resolve(root,fileFor(pin)),'utf8');
 if(sha(original)!==pinnedSha256[moduleName])
  throw new Error('Pinned production library SHA-256 mismatch: '+moduleName);
 const parsed=parse(original,{ecmaVersion:2022,sourceType:'module'});
 const declarations=parsed.body.filter(x=>x.type==='VariableDeclaration')
  .flatMap(x=>x.declarations).filter(x=>x.id?.name==='typeOfTest');
 if(declarations.length!==1||declarations[0].init?.type!=='ArrowFunctionExpression')
  throw new Error('Pinned closure factory shape changed');
 const factory=declarations[0].init;
 if(factory.async||factory.generator||factory.params.length!==1||
    factory.params[0].type!=='Identifier'||
    factory.body.type!=='ArrowFunctionExpression'||
    factory.body.params.length!==1||factory.body.params[0].type!=='Identifier')
  throw new Error('Pinned closure factory is not the audited nested arrow');
 const exact=original.slice(factory.start,factory.end);
 if(exact.replace(/\s+/g,'')!=='(type)=>(thing)=>typeofthing===type')
  throw new Error('Pinned closure factory semantics changed');
 const before='"use strict";\nfunction ownedTypeOfTest(type, thing) {\n  const typeOfTest = ';
 const after=';\n  const predicate = typeOfTest(type);\n  return predicate(thing);\n}\n';
 const projected=before+exact+after;
 return {projected,entry:'ownedTypeOfTest',
  provenance:{repository:pin.repository,revision:pin.revision,
   license:pin.license,path:pin.path,sha256:pinnedSha256[moduleName],
   sourceSpan:{start:factory.start,end:factory.end,unit:'utf16'},
   projectionStart:before.length,extraction:'exact-source-closure-factory/1'}};
}
