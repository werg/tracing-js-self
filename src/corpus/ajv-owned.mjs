// Candidate owned execution of actual Ajv-generated validator source.
// This is deliberately separate from native Ajv diagnostic agreements. A
// source hash or an equivalent boolean answer is never sufficient evidence.
// Call only inside an externally isolated, trusted pinned-Ajv runner: the
// independent Node vm reference is not a hostile-code security boundary.
import {createHash} from 'node:crypto';
import {parse} from 'acorn';
import {runInNewContext} from 'node:vm';
import {verifyTrainingCase,recheckIndependentTrainingEvidence}
 from '../training/admit.js';

const hash=s=>createHash('sha256').update(s).digest('hex');
// Ajv 8's generated functions use a standard optional context parameter.
// For *an omitted context argument only*, its four pure defaults can be
// represented as owned lexical initialization. The whole original function
// body stays byte-identical. Refuse every other parameter shape.
function projectOmittedAjvContext(generated,fn){
 if(fn.params.length===1&&fn.params[0].type==='Identifier'&&
    fn.params[0].name==='data')
  return {source:'"use strict";\n'+generated+'\n',
   projection:'unchanged-generated-validator/1'};
 if(fn.params.length!==2||fn.params[0].type!=='Identifier'||
    fn.params[0].name!=='data')
  return null;
 const second=fn.params[1];
 if(second.type!=='AssignmentPattern'||second.left.type!=='ObjectPattern'||
    second.right.type!=='ObjectExpression'||second.right.properties.length!==0)
  return null;
 const props=second.left.properties;
 if(![4,5].includes(props.length)||props.some(x=>x.type!=='Property'||x.computed||
      x.method||x.kind!=='init'))return null;
 const keys=['instancePath','parentData','parentDataProperty','rootData',
  'dynamicAnchors'].slice(0,props.length);
 for(let i=0;i<keys.length;i++){
  const prop=props[i];
  if(prop.key.type!=='Identifier'||prop.key.name!==keys[i])return null;
  if(i===0){
   if(prop.value.type!=='AssignmentPattern'||
      prop.value.left.type!=='Identifier'||prop.value.left.name!=='instancePath'||
      prop.value.right.type!=='Literal'||prop.value.right.value!=='')return null;
  }else if(i===3){
   if(prop.value.type!=='AssignmentPattern'||
      prop.value.left.type!=='Identifier'||prop.value.left.name!=='rootData'||
      prop.value.right.type!=='Identifier'||prop.value.right.name!=='data')return null;
  }else if(i===4){
   if(prop.value.type!=='AssignmentPattern'||
      prop.value.left.type!=='Identifier'||prop.value.left.name!=='dynamicAnchors'||
      prop.value.right.type!=='ObjectExpression'||
      prop.value.right.properties.length!==0)return null;
  }else if(prop.value.type!=='Identifier'||prop.value.name!==keys[i])return null;
 }
 if(!/^\s*,\s*$/.test(generated.slice(fn.params[0].end,second.start)))
  return null;
 const declaration='\nlet instancePath="";\nlet parentData=undefined;\n'+
  'let parentDataProperty=undefined;\nlet rootData=data;\n'+
  (props.length===5?'let dynamicAnchors={};\n':'');
 const projected=generated.slice(0,fn.params[0].end)+
  generated.slice(second.end,fn.body.start+1)+declaration+
  generated.slice(fn.body.start+1);
 return {source:'"use strict";\n'+projected+'\n',
  projection:'ajv-omitted-context-pure-defaults/1',
  originalBodySha256:hash(generated.slice(fn.body.start,fn.body.end))};
}

const refusal=(status,reason,details={})=>({
 schema:'ajv-generated-owned-attempt/1',status,reason,
 authority:'owned-runtime-independent-reference-required',
 verifiedOwned:false,admitted:false,...details
});

/**
 * Verify an unchanged generated function *body* through the owned interpreter,
 * independent V8 outcome, executed operation/branch audit, and serialized
 * evidence recheck. Reject unknown closure dependencies rather than injecting
 * native Ajv globals into the owned realm.
 */
export function attemptOwnedAjvGeneratedValidator({
 validator,data,observedResult,originalId=null,
 maxSteps=12000,maxGenerated=256}={}){
 if(typeof validator!=='function'||typeof observedResult!=='boolean'||
    !Number.isSafeInteger(maxSteps)||maxSteps<1||maxSteps>50000||
    !Number.isSafeInteger(maxGenerated)||maxGenerated<1||maxGenerated>2048)
  return {row:refusal('unsupported','Invalid bounded Ajv owned attempt'),exported:null};
 const generated=validator.source?.validateCode;
 const entry=validator.name;
 if(typeof generated!=='string'||!generated.length||generated.length>65536||
    typeof entry!=='string'||!/^[A-Za-z_$][\w$]*$/.test(entry))
  return {row:refusal('unsupported','Missing bounded named generated Ajv source'),exported:null};
 const codeSha256=hash(generated);
 const details={generatedCodeSha256:codeSha256,generatedFunction:entry,originalId};
 const scoped=validator.source?.scopeValues;
 let ast;
 try{ast=parse(generated,{ecmaVersion:2022,sourceType:'script'});}
 catch(error){
  return {row:refusal('unsupported','Generated Ajv code cannot be parsed: '+String(error.message).slice(0,160),details),exported:null};
 }
 // Ajv can retain unused scope registrations in its generated metadata.
 // Permit those only if no generated identifier refers to them. Actual
 // captured values (schema0, func1, etc.) must never be injected from V8.
 // This is a conservative lexical preflight; the independent V8 oracle will
 // still reject any missed ambient dependency in the executable program.
 if(scoped && Reflect.ownKeys(scoped).length){
  const keys=Reflect.ownKeys(scoped);
  const identifiers=new Set(),stack=[ast];
  while(stack.length){
   const current=stack.pop();
   if(!current||typeof current!=='object')continue;
   if(current.type==='Identifier')identifiers.add(current.name);
   for(const value of Object.values(current)){
    if(Array.isArray(value))stack.push(...value);
    else if(value&&typeof value==='object')stack.push(value);
   }
  }
  if(keys.some(key=>typeof key!=='string'||!/^[A-Za-z_][\w]*$/.test(key)||
      [...identifiers].some(name=>name.startsWith(key)&&
       /^[0-9]+$/.test(name.slice(key.length)))))
   return {row:refusal('unsupported','Ajv generated function requires captured native scope',details),
    exported:null};
 }
 if(ast.body.length!==1||ast.body[0].type!=='FunctionDeclaration'||
    ast.body[0].id?.name!==entry||ast.body[0].generator||ast.body[0].async)
  return {row:refusal('unsupported','Generated source is not exactly one synchronous named function',details),
   exported:null};
 let cloned;
 try{cloned=structuredClone(data);}
 catch(error){
  return {row:refusal('unsupported','Unrepresentable JSON input data',details),exported:null};
 }
 const projected=projectOmittedAjvContext(generated,ast.body[0]);
 if(!projected)
  return {row:refusal('unsupported','Unsupported generated Ajv context parameter layout',
   {...details,signature:generated.slice(ast.body[0].start,ast.body[0].body.start).slice(0,280)}),
   exported:null};
 details.projection=projected.projection;
 if(projected.originalBodySha256)details.originalBodySha256=projected.originalBodySha256;
 // Run exact original V8 generated bytes as an additional differential guard.
 // Never pass host objects into this vm; JSON inputs only. This is not a
 // security sandbox, hence the CI caller's restricted, trusted environment.
 let inputJSON;
 try{inputJSON=JSON.stringify(cloned);}
 catch{return {row:refusal('unsupported','Input cannot be serialized as JSON',details),exported:null};}
 if(typeof inputJSON!=='string'||inputJSON.length>12000)
  return {row:refusal('unsupported','Owned validator input exceeds JSON boundary',details),exported:null};
 try{
  const original=runInNewContext('"use strict";\n'+generated+'\n'+entry+
    '('+inputJSON+')',Object.create(null),{timeout:300,
     contextCodeGeneration:{strings:false,wasm:false}});
  if(typeof original!=='boolean'||original!==observedResult)
   return {row:refusal('reference_mismatch',
    'Original standalone Ajv generated code differs from compiled validator',details),
    exported:null};
 }catch(error){
  return {row:refusal('unsupported',
   'Original generated validator needs unavailable ambient scope: '+
   String(error.message??error).slice(0,140),details),exported:null};
 }
 const source=projected.source;
 const result=verifyTrainingCase({source,entry,args:[cloned],maxSteps,maxGenerated,
  lineage:{origin:'ajv-generated-owned-attempt/1',originalId,
   generatedCodeSha256:codeSha256}});
 if(result.status!=='locally_verified')
  return {row:refusal(result.status,String(result.reason??'Owned validator refused').slice(0,300),details),
   exported:null};
 const exported=JSON.parse(JSON.stringify(result.exported));
 const reference=exported.sidecar?.reference?.outcome;
 if(reference?.kind!=='return'||
    JSON.stringify(reference.graph?.roots?.at(-1))!==JSON.stringify(['bool',observedResult]))
  return {row:refusal('reference_mismatch',
   'Generated standalone function differs from real Ajv compiled validator',details),exported:null};
 const evidence=recheckIndependentTrainingEvidence(exported);
 if(!evidence.valid)
  return {row:refusal('reference_mismatch',
   'Independent serialized owned evidence fails: '+String(evidence.reason).slice(0,160),details),
   exported:null};
 const ownedText=exported.sidecar.archive.sources.find(s=>
  s.sourceId===exported.sidecar.archive.entrySpec.sourceId)?.text;
 if(ownedText!==source)
  return {row:refusal('reference_mismatch','Owned archive source differs from Ajv-generated bytes',details),
   exported:null};
 return {row:{schema:'ajv-generated-owned-attempt/1',...details,
   status:'locally_verified',authority:'owned-runtime-independent-reference-required',
   verifiedOwned:true,admitted:false,
   evidence:{operations:evidence.operations,branches:evidence.branches,
    modelVisibleSchema:exported.public.schema}},
   exported};
}
