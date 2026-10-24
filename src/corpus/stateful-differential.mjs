// Source-agnostic, trusted-only stateful command differential probes.
// Native reference comparisons and shrinking are diagnostics, NEVER owned traces.
import {createHash} from 'node:crypto';

const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const supported=new Set(['enqueue','dequeue','peek','clear','drain','snapshot']);

function checkJson(value,depth=0){
 if(depth>12)throw new TypeError('Stateful command nesting limit exceeded');
 if(value===null||typeof value==='string'||typeof value==='boolean')return;
 if(typeof value==='number'&&Number.isFinite(value))return;
 if(Array.isArray(value)){
  if(value.length>256)throw new TypeError('Oversized JSON array');
  for(let i=0;i<value.length;i++){
   if(!Object.hasOwn(value,i))throw new TypeError('Sparse command values');
   checkJson(value[i],depth+1);
  }
  return;
 }
 if(!isObject(value)||Object.getPrototypeOf(value)!==Object.prototype)
  throw new TypeError('Expected a JSON plain object');
 const fields=Object.getOwnPropertyDescriptors(value),keys=Object.keys(fields);
 if(keys.length>64)throw new TypeError('Oversized JSON object');
 for(const key of keys){
  if(['__proto__','constructor','prototype'].includes(key)||
     !Object.hasOwn(fields[key],'value')||!fields[key].enumerable)
   throw new TypeError('Unsafe or non-data JSON object field');
  checkJson(fields[key].value,depth+1);
 }
}
export function validateStatefulCommands(commands,{allowEmpty=false}={}){
 if(!Array.isArray(commands)||commands.length>256||
    (!allowEmpty&&commands.length===0))throw new TypeError('Invalid stateful command sequence');
 checkJson(commands);
 for(const command of commands){
  if(!isObject(command)||!supported.has(command.op)||
     (command.op==='enqueue'?!Object.hasOwn(command,'value'):
       Object.hasOwn(command,'value'))||
     Object.keys(command).some(k=>!['op','value'].includes(k)))
   throw new TypeError('Invalid queue command or payload');
 }
 const json=JSON.stringify(commands);
 if(json.length>65536)throw new TypeError('Oversized serialized command sequence');
 return JSON.parse(json);
}

// Logs each observable result, intermediate state and final state. The model
// uses an Array; the SUT uses the original upstream Queue implementation.
export function compareQueueHistory(commands,Queue){
 const input=validateStatefulCommands(commands,{allowEmpty:true});
 if(typeof Queue!=='function')throw new TypeError('Missing pinned queue constructor');
 const run=(factory,model)=>{
  const q=factory(),log=[];
  for(const c of input){
   let returned=null;
   switch(c.op){
    case 'enqueue': returned=model?q.push(structuredClone(c.value)):q.enqueue(structuredClone(c.value));break;
    case 'dequeue': returned=model?q.shift():q.dequeue();break;
    case 'peek': returned=model?q[0]:q.peek();break;
    case 'clear': returned=model?(q.length=0):q.clear();break;
    case 'drain': returned=model?q.splice(0):[...q.drain()];break;
    case 'snapshot': returned=model?[...q]:[...q];break;
   }
   // Queue's void methods return undefined; normalize internal model methods.
   if(c.op==='enqueue'||c.op==='clear')returned=null;
   if(returned===undefined)returned=null;
   log.push({op:c.op,result:structuredClone(returned),size:model?q.length:q.size,
    items:structuredClone(model?[...q]:[...q])});
  }
  return {log,final:{size:model?q.length:q.size,items:structuredClone(model?[...q]:[...q])}};
 };
 const native=run(()=>new Queue(),false),reference=run(()=>[],true);
 return {schema:'pinned-queue-stateful-differential/1',
  authority:'native-v8-vs-explicit-array-model',verifiedOwned:false,admitted:false,
  sequenceSha256:sha(input),commandCount:input.length,
  agreed:JSON.stringify(native)===JSON.stringify(reference),native,reference};
}

// A reproducible (not security-grade) generator. It never reads network,
// invokes source in acquisition, or labels a case with an expected oracle result.
export function generateQueueSequences({seed=42,count=64,maxCommands=32}={}){
 if(!Number.isSafeInteger(seed)||seed<0||seed>0xffffffff||
    !Number.isSafeInteger(count)||count<1||count>4096||
    !Number.isSafeInteger(maxCommands)||maxCommands<1||maxCommands>256)
  throw new TypeError('Invalid bounded stateful fuzz settings');
 let state=seed>>>0;
 const next=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
 const ops=['enqueue','enqueue','enqueue','dequeue','peek','clear','drain','snapshot'];
 const seen=new Set(),rows=[];
 for(let i=0;i<count;i++){
  const size=1+(next()%maxCommands),commands=[];
  for(let j=0;j<size;j++){
   const op=ops[next()%ops.length];
   const n=next()%43;
   commands.push(op==='enqueue'?{op,value:j%5===0?{key:'k'+n,n}:n-21}:{op});
  }
  const signature=sha(commands);
  if(!seen.has(signature)){seen.add(signature);rows.push({id:signature,commands});}
 }
 return rows;
}

function reducedJsonValues(v,depth=0){
 if(depth>3)return [];
 if(typeof v==='number')return [0,1,-1,Math.trunc(v/2)].filter((n,i,a)=>n!==v&&a.indexOf(n)===i);
 if(typeof v==='string')return ['',v.slice(0,Math.floor(v.length/2)),v.slice(0,-1)]
  .filter((s,i,a)=>s!==v&&a.indexOf(s)===i);
 if(typeof v==='boolean')return v?[false]:[];
 if(Array.isArray(v)){
  const out=[[],v.slice(0,Math.floor(v.length/2)),v.slice(1)];
  for(let i=0;i<Math.min(12,v.length);i++){
   out.push([...v.slice(0,i),...v.slice(i+1)]);
   for(const newValue of reducedJsonValues(v[i],depth+1).slice(0,4)){
    const changed=structuredClone(v);changed[i]=newValue;out.push(changed);
   }
  }
  return out;
 }
 if(isObject(v)){
  const keys=Object.keys(v).sort(),out=[{}];
  for(const key of keys.slice(0,12)){
   const dropped={...v};delete dropped[key];out.push(dropped);
   for(const newValue of reducedJsonValues(v[key],depth+1).slice(0,4))
    out.push({...v,[key]:newValue});
  }
  return out;
 }
 return [];
}

// Async delta debugging: only a trusted independently reset oracle can say
// whether the SAME failure still occurs. Recheck twice to limit flakiness.
export async function shrinkStatefulMismatch(commands,reproduces,
 {maxEvaluations=128,confirmations=2,allowEmpty=true}={}){
 const original=validateStatefulCommands(commands);
 if(typeof reproduces!=='function'||
  !Number.isSafeInteger(maxEvaluations)||maxEvaluations<confirmations||maxEvaluations>2048||
  !Number.isSafeInteger(confirmations)||confirmations<2||confirmations>4||
  typeof allowEmpty!=='boolean')throw new TypeError('Invalid stateful shrink controls');
 const originalHash=sha(original);let evaluations=0,oracleErrors=0,accepted=0;
 const inspect=async candidate=>{
  let signature=null;
  for(let i=0;i<confirmations;i++){
   if(evaluations>=maxEvaluations)return {status:'budget'};
   evaluations++;
   let value;
   try{value=await reproduces(structuredClone(candidate));}
   catch{oracleErrors++;return {status:'not-reproduced'};}
   if(value===true)value={reproduced:true,signature:null};
   if(!isObject(value)||value.reproduced!==true||
      !(value.signature===null||typeof value.signature==='string'))
    return {status:'not-reproduced'};
   if(i&&signature!==value.signature)return {status:'flaky'};
   signature=value.signature;
  }
  return {status:'reproduced',signature};
 };
 const first=await inspect(original);
 const done=(status,current)=>({schema:'stateful-reference-counterexample-shrink/1',
  authority:'trusted-independent-reference-oracle-only',verifiedOwned:false,
  admitted:false,status,originalHash,originalCommands:original.length,
  minimizedCommands:current,remainingCommands:current.length,
  originalBytes:Buffer.byteLength(JSON.stringify(original)),
  minimizedBytes:Buffer.byteLength(JSON.stringify(current)),
  oracleSignature:first.signature??null,evaluations,oracleErrors,
  acceptedReductions:accepted,confirmations});
 if(first.status!=='reproduced')return done(first.status==='budget'?'budget-exhausted':first.status,original);
 let current=original,budgetHit=false;
 const tried=new Set([JSON.stringify(current)]);
 const tryCandidate=async candidate=>{
  if(candidate.length===0&&!allowEmpty)return false;
  let validated;
  try{validated=validateStatefulCommands(candidate,{allowEmpty});}catch{return false;}
  const serialized=JSON.stringify(validated),before=JSON.stringify(current);
  if(serialized.length>=before.length||tried.has(serialized))return false;
  tried.add(serialized);
  const outcome=await inspect(validated);
  if(outcome.status==='budget'){budgetHit=true;return false;}
  if(outcome.status!=='reproduced'||outcome.signature!==first.signature)return false;
  current=validated;accepted++;return true;
 };
 // First remove whole sub-sequences, then minimize individual data payloads.
 let granularity=2;
 while(current.length&&evaluations+confirmations<=maxEvaluations){
  const chunkSize=Math.ceil(current.length/granularity);
  let changed=false;
  for(let start=0;start<current.length;start+=chunkSize){
   if(await tryCandidate([...current.slice(0,start),...current.slice(start+chunkSize)])){
    granularity=Math.max(2,granularity-1);changed=true;break;
   }
   if(budgetHit)break;
  }
  if(budgetHit)break;
  if(changed)continue;
  if(granularity>=current.length)break;
  granularity=Math.min(current.length,granularity*2);
 }
 for(let i=0;i<current.length&&!budgetHit;i++){
  if(current[i].op!=='enqueue')continue;
  let improved=true;
  while(improved&&!budgetHit){
   improved=false;
   for(const value of reducedJsonValues(current[i].value)){
    const candidate=structuredClone(current);candidate[i].value=value;
    if(await tryCandidate(candidate)){improved=true;break;}
    if(budgetHit)break;
   }
  }
 }
 return done(budgetHit?'budget-exhausted':accepted?'minimized':'unreduced',current);
}
