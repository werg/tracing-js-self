// Deterministic, bounded variations of canonical Exercism inputs.
// Mutations are new oracle-labeled probes, NEVER additional canonical test
// cases. They must be independently executed against original real JS source,
// projected V8 and the owned runtime before local trace verification.
import {createHash} from 'node:crypto';
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const copy=value=>structuredClone(value);
const numberBoundary=value=>{
 if(!Number.isFinite(value)||Math.abs(value)>1000000)return [];
 const n=[0,1,2,3,4,5,7,10,15,21,28,100,101,399,400,
    value-2,value-1,value+1,value+2,Math.floor(value/2)];
 return [...new Set(n)].filter(v=>Number.isSafeInteger(v)&&v!==value&&Math.abs(v)<=1000000);
};
const strings=value=>[value+'a',value+'!',value.toUpperCase(),
  value.toLowerCase(),value.trim(),value.slice(0,Math.floor(value.length/2)),
  '', 'AaA', 'a\u0301','\u{1F600}'];
export function generateInputVariations(slug,canonicalCases,{limit=16}={}){
 if(!Number.isSafeInteger(limit)||limit<0||limit>512)
  throw new TypeError('Invalid deterministic mutation limit');
 const seen=new Set(canonicalCases.filter(x=>x.status==='candidate')
    .map(x=>JSON.stringify(x.args)));
 const result=[];
 const accept=(seed,args,label)=>{
   if(result.length>=limit)return;
   const bytes=JSON.stringify(args);
   if(bytes.length>2500||seen.has(bytes))return;
   seen.add(bytes);
   result.push({caseId:'generated/'+slug+'/'+sha(args).slice(0,24),
     property:seed.property,entry:seed.entry,args,expected:null,
     expectedAuthority:'original-v8-oracle',generator:'exercism-deterministic-boundaries/1',
     derivedFrom:seed.caseId,mutation:label,status:'candidate',
     description:['Synthetic input mutation, not an upstream canonical test']});
 };
 for(const seed of canonicalCases){
  if(result.length>=limit)break;
  if(seed.status!=='candidate'||!Array.isArray(seed.args)||
    seed.expected&&typeof seed.expected==='object'&&
      Object.hasOwn(seed.expected,'error'))continue;
  for(let i=0;i<seed.args.length&&result.length<limit;i++){
   const value=seed.args[i];
   const variants=typeof value==='number'?numberBoundary(value):
     typeof value==='string'?strings(value):Array.isArray(value)?
       [[],value.slice(0,1),value.slice(0,-1),value.concat(value.slice(-1)),
         value.slice().reverse()]:[];
   for(const candidate of variants){
    if(result.length>=limit)break;
    const args=copy(seed.args);args[i]=candidate;
    accept(seed,args,'argument['+i+']');
   }
  }
 }
 return result;
}
