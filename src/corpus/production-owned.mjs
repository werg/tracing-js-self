// Original-source production helper extraction for the owned training profile.
// Only the exact pinned vendor bytes and top-level standalone function bodies
// are eligible. No module shim or native V8 diagnostic is promoted by itself.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parse} from 'acorn';
import {runInNewContext} from 'node:vm';
import {upstream,pinnedSha256} from '../../corpus/stateful/cases.mjs';
import {verifyTrainingCase,recheckIndependentTrainingEvidence}
 from '../training/admit.js';

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
export function verifyPinnedProductionHelpers({
 inventory=OWNED_PRODUCTION_HELPERS,root=process.cwd(),maxGenerated=256}={}){
 if(!Array.isArray(inventory)||inventory.length>20||
  !Number.isSafeInteger(maxGenerated)||maxGenerated<1||maxGenerated>2048)
  throw new TypeError('Invalid bounded production owned helper inventory');
 const rows=[],verified=[];
 for(const item of inventory){
  const artifact=extractPinnedHelper(item.module,item.function,{root});
  if(!Array.isArray(item.cases)||item.cases.length>50)
   throw new TypeError('Invalid production helper cases');
  for(const [i,args] of item.cases.entries()){
   if(!Array.isArray(args)||JSON.stringify(args).length>2500)
    throw new TypeError('Invalid production helper arguments');
   const id=sha(JSON.stringify([artifact.provenance,item.function,i,args]));
   if(artifact.originalArrow){
    // Compare original pinned arrow semantics to the synthesized function
    // wrapper, independently in two distinct V8 realms. Scalar/JSON-only
    // input budgets and source-hash locking are mandatory.
    const encoded=JSON.stringify(args);
    if(typeof encoded!=='string'||encoded.length>2500)
     throw new TypeError('Unrepresentable original arrow fixture');
    const call=artifact.entry+'(...'+encoded+')';
    const originalResult=runInNewContext(artifact.originalArrow+call,
     Object.create(null),{timeout:300,contextCodeGeneration:{strings:false,wasm:false}});
    const loweredResult=runInNewContext(artifact.projected+call,
     Object.create(null),{timeout:300,contextCodeGeneration:{strings:false,wasm:false}});
    if(!Object.is(originalResult,loweredResult)){
     rows.push({schema:'production-helper-owned-result/1',id,entry:artifact.entry,
      args,originalSource:artifact.provenance,admitted:false,
      status:'source_projection_mismatch',verifiedOwned:false});
     continue;
    }
   }
   const result=verifyTrainingCase({source:artifact.projected,
    entry:artifact.entry,args,lineage:{origin:'pinned-production-owned/1',
     source:artifact.provenance,index:i},maxGenerated,maxSteps:12000});
   const row={schema:'production-helper-owned-result/1',id,entry:artifact.entry,
    args,originalSource:artifact.provenance,admitted:false,
    status:result.status,verifiedOwned:false};
   if(result.status==='locally_verified'){
    const serialized=JSON.parse(JSON.stringify(result.exported));
    const evidence=recheckIndependentTrainingEvidence(serialized);
    if(!evidence.valid)throw new Error('Production helper independent recheck failed: '+evidence.reason);
    const text=serialized.sidecar.archive.sources.find(x=>
      x.sourceId===serialized.sidecar.archive.entrySpec.sourceId)?.text;
    if(text!==artifact.projected)throw new Error('Owned source does not match pinned projection');
    row.status='locally_verified';row.verifiedOwned=true;
    row.evidence={operations:evidence.operations,branches:evidence.branches,
     modelVisibleSchema:serialized.public.schema,
     originalExactText:artifact.projected.slice(artifact.provenance.projectionStart,
      artifact.provenance.projectionStart+
      artifact.provenance.sourceSpan.end-artifact.provenance.sourceSpan.start)};
    verified.push({id,exported:serialized,provenance:artifact.provenance});
   }else row.reason=String(result.reason??'Unsupported owned execution').slice(0,300);
   rows.push(row);
  }
 }
 return {report:{schema:'production-helper-owned-report/1',
   authority:'owned-runtime-plus-independent-reference-checks',
   attempted:rows.length,locallyVerified:verified.length,
   refused:rows.length-verified.length,admitted:0,
   rows,warnings:['Only individually rechecked original helper bodies qualify.',
    'The extracted function is a strict function-entry projection, not arbitrary ESM module execution.',
    'Only model-visible semantic-execution/2 examples are locally verified; no megatoken admission is implied.']},
   verified};
}
