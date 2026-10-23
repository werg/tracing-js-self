// Deterministic, bounded counterexample shrinking. A trusted, external
// reference predicate must independently reproduce each candidate failure.
// Shrinking itself never produces an owned trace or training admission.
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');

function variants(value,depth=0){
 if(depth>3)return [];
 if(typeof value==='number'&&Number.isFinite(value)){
  const simple=[0,1,-1,Math.trunc(value/2),Math.sign(value)];
  return [...new Set(simple)].filter(x=>x!==value);
 }
 if(typeof value==='string'){
  const half=Math.floor(value.length/2);
  return [...new Set(['',value.slice(0,half),value.slice(half),
   value.slice(0,-1),value.slice(1)])].filter(x=>x!==value);
 }
 if(typeof value==='boolean')return value?[false]:[];
 if(Array.isArray(value)){
  const n=value.length,half=Math.floor(n/2);
  const result=[[],value.slice(0,half),value.slice(half),
   value.slice(0,-1),value.slice(1)];
  for(let i=0;i<n&&i<32;i++){
   result.push([...value.slice(0,i),...value.slice(i+1)]);
   for(const replacement of variants(value[i],depth+1).slice(0,8)){
    const changed=value.slice();changed[i]=replacement;result.push(changed);
   }
  }
  return result;
 }
 if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype){
  const keys=Object.keys(value).sort().slice(0,32);
  const result=[{}];
  for(const key of keys){
   const dropped={...value};delete dropped[key];result.push(dropped);
   for(const replacement of variants(value[key],depth+1).slice(0,8))
    result.push({...value,[key]:replacement});
  }
  return result;
 }
 return [];
}
export function shrinkReferenceMismatch(args,reproduces,
 {maxEvaluations=32}={}){
 if(!Array.isArray(args)||typeof reproduces!=='function'||
  !Number.isSafeInteger(maxEvaluations)||maxEvaluations<1||
  maxEvaluations>256)
  throw new TypeError('Invalid bounded reference shrink arguments');
 const encoded=JSON.stringify(args);
 if(typeof encoded!=='string'||encoded.length>20000)
  throw new TypeError('Invalid oversized reference counterexample');
 const input=JSON.parse(encoded),initialHash=hash(encoded);
 const output=(status,smallest,tries,accepted,errors)=>({
  schema:'native-reference-counterexample-shrink/1',
  authority:'native-reference-predicate-only',verifiedOwned:false,admitted:false,
  status,originalHash:initialHash,initialBytes:Buffer.byteLength(encoded),
  minimizedArgs:smallest,minimizedBytes:Buffer.byteLength(JSON.stringify(smallest)),
  evaluations:tries,acceptedReductions:accepted,oracleErrors:errors
 });
 let evaluations=0,errors=0,accepted=0;
 const evaluate=candidate=>{
  evaluations++;
  try{return reproduces(structuredClone(candidate))===true;}
  catch{errors++;return false;}
 };
 if(!evaluate(input))return output('not-reproduced',input,evaluations,0,errors);
 let current=input,bytes=encoded.length;
 const visited=new Set([encoded]);
 while(evaluations<maxEvaluations){
  let improved=false;
  for(let i=0;i<current.length&&!improved;i++){
   for(const change of variants(current[i])){
    const candidate=current.slice();candidate[i]=change;
    const serialized=JSON.stringify(candidate);
    if(typeof serialized!=='string'||serialized.length>=bytes||
       visited.has(serialized))continue;
    visited.add(serialized);
    if(evaluations>=maxEvaluations)break;
    if(evaluate(candidate)){
     current=candidate;bytes=serialized.length;accepted++;improved=true;break;
    }
   }
  }
  if(!improved)break;
 }
 return output(accepted?'minimized':'unreduced',
  current,evaluations,accepted,errors);
}
