// Original-source production helper extraction for the owned training profile.
// Only the exact pinned vendor bytes and top-level standalone function bodies
// are eligible. No module shim or native V8 diagnostic is promoted by itself.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parse} from 'acorn';
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
  cases:[[null],[[1,null,null]],[[1,2]]]}
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
 if(matches.length!==1||matches[0].async||matches[0].generator)
  throw new Error('No single synchronous original function declaration');
 const node=matches[0],literal=original.slice(node.start,node.end);
 // Function text is byte-for-byte original. This accepts no imported closure
 // dependencies; the owned interpreter refuses unresolved references.
 const prefix='"use strict";\n';
 const projected=prefix+literal+'\n';
 return {projected,entry:functionName,
  provenance:{repository:pin.repository,revision:pin.revision,
   license:pin.license,path:pin.path,sha256:expected,
   sourceSpan:{start:node.start,end:node.end,unit:'utf16'},
   projectionStart:prefix.length,
   extraction:'exact-source-function/1'}};
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
